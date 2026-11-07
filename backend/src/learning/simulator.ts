import type { DataEnvironment, ModelVersion, Prisma, PrismaClient } from '@prisma/client';
import { EvaluationEngine } from '../evaluation/evaluation.engine.js';
import { createModelAdapters, type ModelAdapters } from '../models/adapters.js';
import type { FeatureWeights } from '../models/types.js';
import { AnalysisService } from '../services/analysis.service.js';
import { GUARDRAILS, type LearningSample, type Target } from './learning.engine.js';
import { LearningService } from './learning.service.js';
import { actualsFor, unseenBy } from './samples.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface SimulationConfig {
  dataEnvironment: Exclude<DataEnvironment, 'LIVE'>;
  competitionCode?: string;
  maxMatches?: number;
}

export interface LineageStep {
  version: string;
  parent: string;
  createdAfter: string;
  trainingSamples: number;
  changes: Array<{ feature: string; from: number; to: number }>;
  decision: 'PROMOTED' | 'REJECTED' | 'PENDING';
  reason: string;
  holdoutSamples: number;
}

export interface SimulationSummary {
  simulationRunId: string;
  dataEnvironment: DataEnvironment;
  isEvidenceOfRealImprovement: boolean;
  evidenceNote: string;
  matchesProcessed: number;
  matchesForecast: number;
  forecastsEvaluated: number;
  periods: number;
  window: { from: string; to: string } | null;
  initialModel: string;
  finalModel: string;
  lineage: LineageStep[];
  promoted: LineageStep[];
  rejected: LineageStep[];
  learningSignalsRecorded: number;
  weights: { initial: FeatureWeights; final: FeatureWeights };
  outOfSample: {
    description: string;
    samples: number;
    perTarget: Partial<Record<Target, { before: number; after: number; change: number; n: number; metric: string }>>;
  };
  walkForward: Awaited<ReturnType<EvaluationEngine['performance']>>['byTarget'];
}

const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const r = (v: number, p = 4) => Math.round(v * 10 ** p) / 10 ** p;

export class LearningSimulator {
  private readonly analysis: AnalysisService;
  private readonly evaluation: EvaluationEngine;
  private readonly learning: LearningService;

  constructor(
    private readonly db: Db,
    adapters: ModelAdapters = createModelAdapters(),
    private readonly log: (line: string) => void = () => {},
  ) {
    this.analysis = new AnalysisService(db, adapters);
    this.evaluation = new EvaluationEngine(db);
    this.learning = new LearningService(db, adapters);
  }

  async run(config: SimulationConfig): Promise<SimulationSummary> {
    const env = config.dataEnvironment;
    const sim = await this.db.simulationRun.create({ data: { dataEnvironment: env, status: 'RUNNING', config: { ...config, guardrails: GUARDRAILS } as unknown as Prisma.InputJsonValue } });
    try {
      const summary = await this.execute(sim.id, config);
      await this.db.simulationRun.update({ where: { id: sim.id }, data: { status: 'COMPLETED', completedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue } });
      return summary;
    } catch (error) {
      await this.db.simulationRun.update({ where: { id: sim.id }, data: { status: 'FAILED', completedAt: new Date(), errorMessage: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }

  private async execute(simulationRunId: string, config: SimulationConfig): Promise<SimulationSummary> {
    const env = config.dataEnvironment;
    const registry = this.learning.registry;
    await registry.supersedeActive(env, `Superseded: walk-forward simulation ${simulationRunId} restarts learning from the baseline.`);

    const baseline = await registry.baseline();
    const initialWeights = await registry.weightsOf(baseline.id);
    let active: ModelVersion = baseline;
    let activeWeights = initialWeights;

    const matches = await this.db.match.findMany({
      where: { dataEnvironment: env, status: 'FINISHED', ...(config.competitionCode ? { competition: { code: config.competitionCode } } : {}) },
      select: { id: true, matchDate: true },
      orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
      take: config.maxMatches,
    });
    const periods = new Map<string, string[]>();
    for (const m of matches) periods.set(monthKey(m.matchDate), [...(periods.get(monthKey(m.matchDate)) ?? []), m.id]);

    const history: LearningSample[] = [];
    const lineage: LineageStep[] = [];
    let candidate: { version: ModelVersion; step: LineageStep } | null = null;
    let signals = 0;
    let forecastMatches = 0;

    for (const [period, ids] of periods) {
      const periodSamples: LearningSample[] = [];
      for (const matchId of ids) {
        // Only information published before this match's kickoff enters its snapshot (enforced in DB as well).
        const run = await this.analysis.run(matchId, { modelVersionId: active.id, simulationRunId });
        if (run.predictionIds.length === 0) continue;
        forecastMatches += 1;
        periodSamples.push({ matchId, cutoff: new Date(run.analysis.asOf), resultKnownAt: new Date(0), vector: run.vector, actual: { result: null, numeric: {} } });
      }

      // The period is over: reveal actual results and evaluate every forecast made in it.
      await this.evaluation.evaluatePending({ simulationRunId });
      const actuals = await actualsFor(this.db, periodSamples.map((s) => s.matchId));
      for (const s of periodSamples) {
        const a = actuals.get(s.matchId)!;
        s.resultKnownAt = a.resultKnownAt;
        s.actual = a.actual;
      }
      history.push(...periodSamples);

      if (candidate) {
        const holdout = unseenBy(candidate.version, history);
        const outcome = await this.learning.decide(env, active, activeWeights, candidate.version, holdout, simulationRunId);
        if (outcome.decision.decision !== 'INSUFFICIENT_DATA') {
          candidate.step.decision = outcome.promoted ? 'PROMOTED' : 'REJECTED';
          candidate.step.reason = outcome.decision.reason;
          candidate.step.holdoutSamples = outcome.decision.samples;
          this.log(`  ${period}: ${candidate.version.version} ${candidate.step.decision} — ${outcome.decision.reason}`);
          if (outcome.promoted) {
            active = candidate.version;
            activeWeights = await registry.weightsOf(active.id);
          }
          candidate = null;
        }
      }

      if (!candidate && history.length >= GUARDRAILS.minTrainingSamples) {
        const proposal = await this.learning.engine.propose(activeWeights, history);
        await this.learning.recordSignals(env, active, proposal, simulationRunId);
        signals += 1;
        if (proposal.status === 'PROPOSED') {
          const version = await this.learning.createCandidate(env, active, proposal, history, simulationRunId);
          const step: LineageStep = {
            version: version.version,
            parent: active.version,
            createdAfter: period,
            trainingSamples: proposal.samples,
            changes: proposal.changes.map((c) => ({ feature: c.feature, from: r(c.from), to: r(c.to) })),
            decision: 'PENDING',
            reason: proposal.reason,
            holdoutSamples: 0,
          };
          lineage.push(step);
          candidate = { version, step };
          this.log(`  ${period}: proposed ${version.version} from ${active.version} — ${proposal.reason}`);
        }
      }
    }

    if (candidate) await registry.reject(candidate.version, 'Simulation ended before enough unseen matches were available to validate this candidate.', { holdout: unseenBy(candidate.version, history).length });

    const finalWeights = activeWeights;
    const unseen = unseenBy(active, history);
    const [before, after] = await Promise.all([this.learning.engine.evaluateWeights(initialWeights, unseen), this.learning.engine.evaluateWeights(finalWeights, unseen)]);
    const perTarget: SimulationSummary['outOfSample']['perTarget'] = {};
    for (const t of Object.keys(before.meanLoss) as Target[]) {
      const b = before.meanLoss[t]!;
      const a = after.meanLoss[t]!;
      perTarget[t] = { before: r(b.loss), after: r(a.loss), change: b.loss === 0 ? 0 : r((a.loss - b.loss) / b.loss), n: b.n, metric: t === 'MATCH_RESULT' ? 'Brier score' : 'MAE' };
    }
    if (unseen.length > 0) {
      const rows: Prisma.ModelMetricCreateManyInput[] = [];
      for (const [t, v] of Object.entries(perTarget)) {
        const metric = t === 'MATCH_RESULT' ? 'OUT_OF_SAMPLE_BRIER' : 'OUT_OF_SAMPLE_MAE';
        rows.push({ modelVersionId: baseline.id, dataEnvironment: env, target: t as Prisma.ModelMetricCreateManyInput['target'], segment: 'FINAL_OUT_OF_SAMPLE', metric, value: v.before, sampleSize: v.n, windowStart: unseen[0]!.cutoff, windowEnd: unseen.at(-1)!.cutoff, simulationRunId });
        if (active.id !== baseline.id) rows.push({ modelVersionId: active.id, dataEnvironment: env, target: t as Prisma.ModelMetricCreateManyInput['target'], segment: 'FINAL_OUT_OF_SAMPLE', metric, value: v.after, sampleSize: v.n, windowStart: unseen[0]!.cutoff, windowEnd: unseen.at(-1)!.cutoff, simulationRunId });
      }
      await this.db.modelMetric.createMany({ data: rows });
    }

    const walk = await this.evaluation.performance({ simulationRunId });
    return {
      simulationRunId,
      dataEnvironment: env,
      isEvidenceOfRealImprovement: env !== 'SYNTHETIC',
      evidenceNote:
        env === 'SYNTHETIC'
          ? 'SYNTHETIC development data: this run demonstrates the pipeline only and is NOT evidence that the learning system improves real-world forecasts.'
          : 'HISTORICAL real data, evaluated walk-forward: each forecast used only information published before kickoff, and every model change was validated on later matches it had not trained on.',
      matchesProcessed: matches.length,
      matchesForecast: forecastMatches,
      forecastsEvaluated: walk.forecastsEvaluated,
      periods: periods.size,
      window: matches.length > 0 ? { from: matches[0]!.matchDate.toISOString(), to: matches.at(-1)!.matchDate.toISOString() } : null,
      initialModel: baseline.version,
      finalModel: active.version,
      lineage,
      promoted: lineage.filter((s) => s.decision === 'PROMOTED'),
      rejected: lineage.filter((s) => s.decision !== 'PROMOTED'),
      learningSignalsRecorded: signals,
      weights: { initial: initialWeights, final: finalWeights },
      outOfSample: {
        description:
          active.id === baseline.id
            ? `No change was promoted; the baseline stayed active. Comparison covers all ${unseen.length} forecast matches.`
            : `Baseline vs final weights on the ${unseen.length} matches whose cutoff is after ${active.version}'s training window (never used to fit it).`,
        samples: unseen.length,
        perTarget,
      },
      walkForward: walk.byTarget,
    };
  }
}
