// Wires the debate to PostgreSQL.
//
// Read-only with respect to everything that existed before it: the debate builds features, runs the active
// models and scores an ensemble purely in memory. It writes nothing to FeatureSnapshot, AnalysisRun,
// Prediction, ModelVersion, FeatureWeight or LearningEvent, so no forecast, metric or learning decision can
// move because a debate ran. It writes only DebateRun, DebateAgentClaim and DebatePick.

import type { DataEnvironment, DebateMarket, Prisma, PrismaClient } from '@prisma/client';
import { MatchAnalysisEngine, ensemble, runModels } from '../analysis/engine.js';
import { DebateEngine, type DebateInput } from '../debate/debate.engine.js';
import { Copycat } from '../debate/copycat.agent.js';
import { Scout } from '../debate/scout.agent.js';
import { deriveMarkets } from '../debate/markets.js';
import { DEBATE_ENGINE_VERSION, type CalibrationCheck, type DebateTranscript, type MarketProbabilities, type StoredOdds } from '../debate/types.js';
import { FeatureEngineeringService } from '../features/feature-engineering.service.js';
import { KnowledgeService } from '../data/knowledge/knowledge.service.js';
import { ModelRegistry } from '../learning/model-registry.js';
import { createModelAdapters, type ModelAdapters } from '../models/adapters.js';
import { NotFoundError } from '../utils/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface DebateRunResult {
  debateRunId: string;
  transcript: DebateTranscript;
}

const CONFIDENCE_BUCKETS = ['LOW', 'MEDIUM', 'HIGH'] as const;

export class DebateService {
  private readonly features: FeatureEngineeringService;
  private readonly knowledge: KnowledgeService;
  private readonly registry: ModelRegistry;
  private readonly analysisEngine = new MatchAnalysisEngine();
  private readonly debate = new DebateEngine();
  private readonly scout = new Scout();
  private readonly copycat = new Copycat();

  constructor(
    private readonly db: Db,
    private readonly adapters: ModelAdapters = createModelAdapters(),
    private readonly oddsConfigured: boolean = false,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.features = new FeatureEngineeringService(db);
    this.knowledge = new KnowledgeService(db);
    this.registry = new ModelRegistry(db);
  }

  async run(matchId: string): Promise<DebateRunResult> {
    const match = await this.db.match.findUnique({
      where: { id: matchId },
      select: { id: true, status: true, matchDate: true, dataEnvironment: true, competitionId: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } },
    });
    if (!match) throw new NotFoundError('Match', matchId);

    const now = this.now();
    // Before kickoff the debate sees only what is known now; afterwards it replays the pre-kickoff cutoff.
    const prospective = match.status !== 'FINISHED' && match.matchDate.getTime() > now.getTime();
    const build = await this.features.build(matchId, prospective ? now : undefined);
    const asOf = build.pit.cutoff;

    const version = await this.registry.usableFor(match.dataEnvironment, asOf);
    const weights = await this.registry.weightsOf(version.id);

    const run = await this.db.debateRun.create({
      data: {
        matchId,
        analysisRunId: (await this.latestAnalysisRunId(matchId)) ?? null,
        dataEnvironment: match.dataEnvironment,
        status: 'RUNNING',
        engineVersion: DEBATE_ENGINE_VERSION,
        asOf,
      },
    });

    try {
      // In-memory only: featureSnapshotId is null because the debate stores no snapshot of its own.
      const modelResults = await runModels(this.adapters, build.vector, weights, version.version);
      const analysis = this.analysisEngine.analyze(build, modelResults, version.version, null, now);
      const combined = ensemble(modelResults.outputs);

      const model = this.modelProbabilities(build, combined);
      const [odds, knownResults, history, calibration] = await Promise.all([
        this.oddsBefore(matchId, asOf),
        this.knowledge.knownResults(match.competitionId, build.pit),
        this.history(match.dataEnvironment),
        this.calibration(match.dataEnvironment),
      ]);

      const input: DebateInput = {
        matchId,
        fixture: `${match.homeTeam.name} vs ${match.awayTeam.name}`,
        kickoff: match.matchDate,
        asOf,
        dataEnvironment: match.dataEnvironment,
        modelVersion: version.version,
        evidence: this.scout.gather({ build, analysis, now }),
        baseline: this.copycat.baseline({ odds, asOf, providerConfigured: this.oddsConfigured }),
        model,
        analysis,
        vector: build.vector,
        ensembleAgreement: combined.MATCH_RESULT?.agreement ?? null,
        knownResults: knownResults.length,
        calibration,
        history,
      };

      const transcript = this.debate.run(input);

      await this.db.debateAgentClaim.createMany({
        data: transcript.claims.map((c) => ({
          debateRunId: run.id,
          agent: c.agent,
          round: c.round,
          code: c.code,
          summary: c.summary,
          stance: c.stance,
          severity: c.severity,
          targetAgent: c.targetAgent,
          market: c.market,
          evidence: c.evidence as Prisma.InputJsonValue,
        })),
      });

      for (const v of transcript.verdicts) {
        await this.db.debatePick.create({
          data: {
            debateRunId: run.id,
            matchId,
            market: v.market,
            probabilities: (v.probabilities ?? {}) as Prisma.InputJsonValue,
            marketBaseline: (v.marketBaseline ?? undefined) as Prisma.InputJsonValue | undefined,
            edge: v.edge,
            confidence: v.confidence,
            recommendation: v.recommendation,
            stakePct: v.stakePct,
            stakeReason: v.stakeReason,
            oddsAtPick: (v.prices ?? undefined) as Prisma.InputJsonValue | undefined,
            oddsSnapshotId: v.oddsSnapshotId,
            reasoning: v.reasoning,
            unresolvedObjections: v.unresolvedObjections as Prisma.InputJsonValue,
            kickoff: match.matchDate,
            asOf,
          },
        });
      }

      await this.db.debateRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', completedAt: this.now(), transcript: transcript as unknown as Prisma.InputJsonValue },
      });
      return { debateRunId: run.id, transcript };
    } catch (error) {
      await this.db.debateRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', completedAt: this.now(), errorMessage: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async latest(matchId: string) {
    if ((await this.db.match.count({ where: { id: matchId } })) === 0) throw new NotFoundError('Match', matchId);
    return this.db.debateRun.findFirst({
      where: { matchId, status: 'COMPLETED' },
      orderBy: { startedAt: 'desc' },
      include: { picks: { include: { result: true } } },
    });
  }

  private async latestAnalysisRunId(matchId: string): Promise<string | null> {
    const run = await this.db.analysisRun.findFirst({ where: { matchId, status: 'COMPLETED' }, orderBy: { startedAt: 'desc' }, select: { id: true } });
    return run?.id ?? null;
  }

  // The result probability is the ensemble the existing models produced — never recomputed here.
  // Over/under and BTTS are derived from the same Dixon-Coles expectation, and stay null without it.
  private modelProbabilities(build: Parameters<MatchAnalysisEngine['analyze']>[0], combined: ReturnType<typeof ensemble>): MarketProbabilities {
    const result = combined.MATCH_RESULT ? { home: combined.MATCH_RESULT.home, draw: combined.MATCH_RESULT.draw, away: combined.MATCH_RESULT.away } : null;
    const lh = build.vector.features.dcExpectedHomeGoals?.value ?? null;
    const la = build.vector.features.dcExpectedAwayGoals?.value ?? null;
    const rho = build.vector.features.dcRho?.value ?? null;
    if (lh === null || la === null || rho === null || lh <= 0 || la <= 0) {
      return { MATCH_RESULT: result, OVER_UNDER_25: null, BTTS: null };
    }
    const derived = deriveMarkets({ lambdaHome: lh, lambdaAway: la, rho });
    return { MATCH_RESULT: result, OVER_UNDER_25: derived.overUnder25, BTTS: derived.btts };
  }

  private async oddsBefore(matchId: string, asOf: Date): Promise<StoredOdds[]> {
    const rows = await this.db.oddsSnapshot.findMany({ where: { matchId, capturedAt: { lte: asOf } }, orderBy: { capturedAt: 'asc' } });
    return rows.map((o) => ({
      id: o.id,
      market: o.market,
      source: o.source,
      bookmaker: o.bookmaker,
      capturedAt: o.capturedAt,
      prices: o.prices as Record<string, number>,
    }));
  }

  // Hit rate of settled picks per confidence bucket. Picks that have not settled are not counted.
  private async history(dataEnvironment: DataEnvironment): Promise<Record<'LOW' | 'MEDIUM' | 'HIGH', CalibrationCheck>> {
    const rows = await this.db.debatePick.findMany({
      where: { debateRun: { dataEnvironment }, result: { isNot: null } },
      select: { confidence: true, probabilities: true, result: { select: { wasCorrect: true, probabilityOfActual: true } } },
    });
    const out = {} as Record<'LOW' | 'MEDIUM' | 'HIGH', CalibrationCheck>;
    for (const bucket of CONFIDENCE_BUCKETS) {
      const inBucket = rows.filter((r) => r.confidence === bucket);
      const n = inBucket.length;
      const observed = n === 0 ? null : inBucket.filter((r) => r.result!.wasCorrect).length / n;
      const expected =
        n === 0
          ? null
          : inBucket.reduce((s, r) => {
              const p = Object.values(r.probabilities as Record<string, number>);
              return s + (p.length === 0 ? 0 : Math.max(...p));
            }, 0) / n;
      out[bucket] = { bucket, observed, expected, sampleSize: n, trustworthy: false, note: '' };
    }
    return out;
  }

  // Expected calibration error of the model's own settled result forecasts, used by the Skeptic to decide
  // whether an edge is larger than the model's known miscalibration.
  private async calibration(dataEnvironment: DataEnvironment): Promise<{ expectedCalibrationError: number | null; sampleSize: number }> {
    const rows = await this.db.prediction.findMany({
      where: { dataEnvironment, target: 'MATCH_RESULT', result: { isNot: null } },
      select: { probabilities: true, predictedLabel: true, result: { select: { wasCorrect: true } } },
      take: 5000,
    });
    const usable = rows.filter((r) => r.probabilities !== null && r.predictedLabel !== null && r.result !== null);
    if (usable.length < 50) return { expectedCalibrationError: null, sampleSize: usable.length };

    const edges = [0, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0000001];
    let ece = 0;
    for (let i = 0; i < edges.length - 1; i += 1) {
      const from = edges[i]!;
      const to = edges[i + 1]!;
      const inBin = usable.filter((r) => {
        const p = (r.probabilities as Record<string, number>)[r.predictedLabel!.toLowerCase()] ?? 0;
        return p >= from && p < to;
      });
      if (inBin.length === 0) continue;
      const meanPredicted = inBin.reduce((s, r) => s + ((r.probabilities as Record<string, number>)[r.predictedLabel!.toLowerCase()] ?? 0), 0) / inBin.length;
      const observed = inBin.filter((r) => r.result!.wasCorrect).length / inBin.length;
      ece += (inBin.length / usable.length) * Math.abs(meanPredicted - observed);
    }
    return { expectedCalibrationError: Math.round(ece * 10000) / 10000, sampleSize: usable.length };
  }
}

export { CONFIDENCE_BUCKETS };
export type { DebateMarket };
