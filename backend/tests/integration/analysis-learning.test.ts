import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { informationCutoff } from '../../src/data/knowledge/cutoff.js';
import { EvaluationEngine } from '../../src/evaluation/evaluation.engine.js';
import { ModelRegistry } from '../../src/learning/model-registry.js';
import { LearningSimulator } from '../../src/learning/simulator.js';
import { AnalysisService } from '../../src/services/analysis.service.js';
import { DataQualityService } from '../../src/services/data-quality.service.js';

const prisma = new PrismaClient();
const DAY = 86_400_000;

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>, timeout = 120_000): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout, maxWait: 20_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

beforeAll(async () => {
  if ((await prisma.match.count({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' } })) < 100) throw new Error('Needs the seeded synthetic league');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('analysis runs', () => {
  it('backtests a finished match at its pre-kickoff cutoff with a stored immutable snapshot and forecasts', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED', season: { name: '2025/26' } }, orderBy: { matchDate: 'asc' } });
    await inRollback(async (tx) => {
      const res = await new AnalysisService(tx).run(match.id);
      expect(res.mode).toBe('BACKTEST');
      expect(res.analysis.asOf).toBe(informationCutoff(match).toISOString());
      const snap = await tx.featureSnapshot.findUniqueOrThrow({ where: { id: res.featureSnapshotId } });
      expect(snap.latestInputAt!.getTime()).toBeLessThan(snap.asOf.getTime());
      const preds = await tx.prediction.findMany({ where: { analysisRunId: res.analysisRunId } });
      expect(preds.map((p) => p.target).sort()).toEqual(['CARDS', 'CORNERS', 'GOALS', 'MATCH_RESULT', 'SHOTS', 'SHOTS_ON_TARGET']);
      expect(preds.every((p) => p.dataEnvironment === 'SYNTHETIC' && p.asOf.getTime() === snap.asOf.getTime())).toBe(true);
      expect(res.analysis.confidence.reasons.length).toBeGreaterThan(2);
      expect(res.analysis.keyFactors.length).toBeGreaterThan(0);

      const evaluated = await new EvaluationEngine(tx).evaluatePending({ dataEnvironment: 'SYNTHETIC' });
      expect(evaluated.evaluated).toBeGreaterThanOrEqual(5);
      // Other stored forecasts may be permanently not evaluable (e.g. corners never recorded), so count only this run's.
      const results = await tx.predictionResult.findMany({ where: { prediction: { analysisRunId: res.analysisRunId } } });
      const stats = await tx.matchTeamStats.findMany({ where: { matchId: match.id } });
      const cornersKnown = stats.length === 2 && stats.every((s) => s.corners !== null);
      expect(results.length).toBe(cornersKnown ? preds.length : preds.length - 1);
    });
  });

  it('analyses an upcoming LIVE fixture prospectively with what is known now', async () => {
    const upcoming = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'LIVE', status: 'SCHEDULED', matchDate: { gt: new Date() } }, orderBy: { matchDate: 'asc' } });
    await inRollback(async (tx) => {
      const before = Date.now();
      const res = await new AnalysisService(tx).run(upcoming.id);
      expect(res.mode).toBe('PROSPECTIVE');
      expect(new Date(res.analysis.asOf).getTime()).toBeGreaterThanOrEqual(before);
      expect(new Date(res.analysis.asOf).getTime()).toBeLessThan(upcoming.matchDate.getTime());
      expect(res.analysis.forecasts.map((f) => f.target).sort()).toEqual(['GOALS', 'MATCH_RESULT']);
      expect(res.analysis.dataLimitations.join(' ')).toMatch(/unavailable/i);
      expect((await new EvaluationEngine(tx).evaluatePending({ dataEnvironment: 'LIVE' })).evaluated).toBe(0);
    });
  });

  it('never evaluates EPL corners/cards because the source never supplied them', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'HISTORICAL', sourceId: { startsWith: 'en.1/2024-25/' } }, orderBy: { matchDate: 'asc' } });
    await inRollback(async (tx) => {
      const res = await new AnalysisService(tx).run(match.id);
      expect(res.analysis.forecasts.some((f) => f.target === 'CORNERS' || f.target === 'CARDS')).toBe(false);
      expect(res.analysis.cornerTrend).toBeNull();
    });
  });
});

describe('model training window guard (future-data leakage)', () => {
  it('rejects forecasts by a version trained on outcomes at or after the match cutoff, and the registry falls back', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED', season: { name: '2025/26' } }, orderBy: { matchDate: 'asc' } });
    const cutoff = informationCutoff(match);
    await inRollback(async (tx) => {
      const registry = new ModelRegistry(tx);
      const baseline = await registry.baseline();
      const trainedLater = await tx.modelVersion.create({ data: { version: 'leak-test', status: 'EXPERIMENTAL', dataEnvironment: 'SYNTHETIC', parentVersionId: baseline.id, trainingWindowStart: new Date(cutoff.getTime() - 100 * DAY), trainingWindowEnd: new Date(cutoff.getTime() + DAY) } });
      expect((await registry.usableFrom(trainedLater, cutoff)).id).toBe(baseline.id);
      // Last statement: a rejected insert aborts the surrounding transaction.
      await expect(
        tx.analysisRun.create({ data: { matchId: match.id, modelVersionId: trainedLater.id, dataEnvironment: 'SYNTHETIC', status: 'RUNNING', asOf: cutoff } }),
      ).rejects.toThrow(/future-data leakage/);
    });
  });
});

describe('model versioning, promotion and rollback', () => {
  it('promotes, retires the previous version, rolls back, and never edits weights', async () => {
    await inRollback(async (tx) => {
      const registry = new ModelRegistry(tx);
      const baseline = await registry.baseline();
      const mk = async (parent: typeof baseline, factor: number) => {
        const weights = await registry.weightsOf(parent.id);
        return registry.createCandidate({
          parent, dataEnvironment: 'SYNTHETIC', weights: { ...weights, h2h: weights.h2h * factor }, changes: [{ feature: 'h2h', from: weights.h2h, to: weights.h2h * factor, reason: 'test', confidence: 0.5 }],
          trainingWindowStart: new Date('2024-01-01'), trainingWindowEnd: new Date('2024-06-01'), trainingSamples: 60, notes: 'test',
        });
      };
      const v1 = await mk(baseline, 0.5);
      expect(Object.values(await registry.weightsOf(v1.id)).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      const stored = await tx.featureWeight.findMany({ where: { modelVersionId: v1.id } });
      expect(stored.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 5);
      await registry.promote(v1, 'passed', {});
      const v2 = await mk(v1, 0.5);
      await registry.promote(v2, 'passed', {});
      expect((await tx.modelVersion.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('RETIRED');
      expect((await registry.activeFor('SYNTHETIC')).id).toBe(v2.id);

      const back = await registry.rollback('SYNTHETIC', 'test rollback');
      expect(back.to.id).toBe(v1.id);
      expect((await registry.activeFor('SYNTHETIC')).id).toBe(v1.id);
      await registry.rollback('SYNTHETIC', 'again');
      expect((await registry.activeFor('SYNTHETIC')).id).toBe(baseline.id);
      await expect(registry.rollback('SYNTHETIC', 'nothing left')).rejects.toThrow(/already uses the baseline/);

      const events = await tx.learningEvent.findMany({ where: { OR: [{ toVersionId: { in: [v1.id, v2.id] } }, { fromVersionId: { in: [v1.id, v2.id] } }] } });
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['WEIGHT_ADJUSTMENT_PROPOSED', 'VERSION_PROMOTED', 'ROLLBACK']));
      expect((await registry.weightsOf(v2.id)).h2h).toBeLessThan((await registry.weightsOf(v1.id)).h2h);
      await expect(tx.featureWeight.updateMany({ where: { modelVersionId: v1.id }, data: { weight: 1 } })).rejects.toThrow(/immutable/);
    });
  });
});

describe('walk-forward learning simulation (SYNTHETIC, rolled back)', () => {
  it('runs the full loop chronologically without future information and labels itself as non-evidence', { timeout: 600_000 }, async () => {
    await inRollback(async (tx) => {
      const summary = await new LearningSimulator(tx).run({ dataEnvironment: 'SYNTHETIC' });
      expect(summary.isEvidenceOfRealImprovement).toBe(false);
      expect(summary.evidenceNote).toMatch(/NOT evidence/);
      expect(summary.matchesProcessed).toBe(128);
      expect(summary.forecastsEvaluated).toBeGreaterThan(300);
      expect(summary.learningSignalsRecorded).toBeGreaterThan(0);

      const runs = await tx.analysisRun.findMany({ where: { simulationRunId: summary.simulationRunId }, include: { featureSnapshot: true, match: true, modelVersion: true } });
      expect(runs.length).toBe(128);
      for (const run of runs) {
        expect(run.asOf.getTime()).toBe(informationCutoff(run.match).getTime());
        if (run.featureSnapshot!.latestInputAt) expect(run.featureSnapshot!.latestInputAt.getTime()).toBeLessThan(run.asOf.getTime());
        if (run.modelVersion.trainingWindowEnd) expect(run.modelVersion.trainingWindowEnd.getTime()).toBeLessThan(run.asOf.getTime());
      }
      // Chronology: the very first match of the league has no earlier results to draw on.
      const first = runs.sort((a, b) => a.asOf.getTime() - b.asOf.getTime())[0]!;
      const firstFeatures = first.featureSnapshot!.features as Record<string, { value: number | null; sampleSize: number }>;
      expect(firstFeatures.recentFormHome).toMatchObject({ value: null, sampleSize: 0 });
      expect(firstFeatures.leagueHomeGoals!.value).toBeNull();

      for (const step of summary.lineage) {
        const v = await tx.modelVersion.findUniqueOrThrow({ where: { version: step.version } });
        expect(v.dataEnvironment).toBe('SYNTHETIC');
        expect(v.trainingWindowEnd).not.toBeNull();
        if (step.decision === 'PROMOTED') expect(step.holdoutSamples).toBeGreaterThanOrEqual(50);
      }
      const events = await tx.learningEvent.findMany({ where: { dataEnvironment: 'SYNTHETIC', evidence: { path: ['simulationRunId'], equals: summary.simulationRunId } } });
      expect(events.length).toBe(summary.learningSignalsRecorded);
      expect(await tx.learningEvent.count({ where: { dataEnvironment: { not: 'SYNTHETIC' }, createdAt: { gte: new Date(Date.now() - 600_000) }, evidence: { path: ['simulationRunId'], equals: summary.simulationRunId } } })).toBe(0);
    }, 600_000);
  });
});

describe('environment lineage and HISTORICAL → LIVE adoption', () => {
  const version = async (tx: Prisma.TransactionClient, name: string, env: 'SYNTHETIC' | 'HISTORICAL' | 'LIVE', parentVersionId: string, trainingWindowEnd?: Date) =>
    tx.modelVersion.create({ data: { version: name, status: 'EXPERIMENTAL', dataEnvironment: env, parentVersionId, trainingWindowEnd: trainingWindowEnd ?? null } });

  it('lets HISTORICAL learning seed a LIVE version, never the reverse, and never anything crossing SYNTHETIC', async () => {
    await inRollback(async (tx) => {
      const baseline = await new ModelRegistry(tx).baseline();
      await version(tx, 'env-h-to-l', 'LIVE', (await version(tx, 'env-h', 'HISTORICAL', baseline.id)).id);
    });
    for (const [parentEnv, childEnv] of [['LIVE', 'HISTORICAL'], ['SYNTHETIC', 'LIVE'], ['HISTORICAL', 'SYNTHETIC']] as const) {
      await inRollback(async (tx) => {
        const baseline = await new ModelRegistry(tx).baseline();
        const parent = await version(tx, `env-${parentEnv}`, parentEnv, baseline.id);
        await expect(version(tx, `env-${parentEnv}-${childEnv}`, childEnv, parent.id)).rejects.toThrow(/cannot produce/);
      });
    }
  });

  it('never uses a HISTORICAL version directly on LIVE data; adoption creates an audited LIVE version that stays in its own lineage', async () => {
    const upcoming = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'LIVE', status: 'SCHEDULED', matchDate: { gt: new Date() } }, orderBy: { matchDate: 'asc' } });
    const past = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'HISTORICAL', sourceId: { startsWith: 'en.1/2025-26/' } }, orderBy: { matchDate: 'asc' } });
    const historicalVersion = async (tx: Prisma.TransactionClient) => {
      const baseline = await new ModelRegistry(tx).baseline();
      const hist = await version(tx, 'adopt-src', 'HISTORICAL', baseline.id, new Date(past.matchDate.getTime() + 30 * DAY));
      await tx.featureWeight.createMany({ data: (await tx.featureWeight.findMany({ where: { modelVersionId: baseline.id } })).map((w) => ({ modelVersionId: hist.id, feature: w.feature, weight: w.weight })) });
      return { baseline, hist };
    };
    // A rejected statement aborts the PostgreSQL transaction, so the rejection is checked in its own transaction.
    await inRollback(async (tx) => {
      const { hist } = await historicalVersion(tx);
      await expect(
        tx.analysisRun.create({ data: { matchId: upcoming.id, modelVersionId: hist.id, dataEnvironment: 'LIVE', status: 'RUNNING', asOf: new Date() } }),
      ).rejects.toThrow(/cannot be used or measured/);
    });
    await inRollback(async (tx) => {
      const registry = new ModelRegistry(tx);
      const { baseline, hist } = await historicalVersion(tx);

      const adopted = await registry.adoptForLive(hist);
      expect(adopted).toMatchObject({ dataEnvironment: 'LIVE', status: 'ACTIVE', parentVersionId: hist.id });
      expect((await registry.activeFor('LIVE')).id).toBe(adopted.id);
      expect((await registry.usableFor('LIVE', new Date())).id).toBe(adopted.id);
      // Before its training window ended it must fall back to the baseline, not to its HISTORICAL parent.
      expect((await registry.usableFrom(adopted, past.matchDate)).id).toBe(baseline.id);
      expect(await tx.learningEvent.count({ where: { type: 'VERSION_PROMOTED', dataEnvironment: 'LIVE', toVersionId: adopted.id } })).toBe(1);
      await expect(registry.adoptForLive(adopted)).rejects.toThrow(/Only versions learned from HISTORICAL/);
    });
  });

  it('keeps after-the-fact backtests of LIVE matches out of real LIVE performance', async () => {
    const played = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'LIVE', status: 'FINISHED' }, orderBy: { matchDate: 'desc' } });
    await inRollback(async (tx) => {
      const res = await new AnalysisService(tx).run(played.id);
      expect(res.mode).toBe('BACKTEST');
      const engine = new EvaluationEngine(tx);
      expect((await engine.evaluatePending({ dataEnvironment: 'LIVE' })).evaluated).toBeGreaterThan(0);
      const prospectiveOnly = await engine.performance({ dataEnvironment: 'LIVE', includeSimulations: false });
      expect(prospectiveOnly.forecastsEvaluated).toBe(0);
      expect((await engine.performance({ dataEnvironment: 'LIVE', includeSimulations: true })).forecastsEvaluated).toBeGreaterThan(0);
    });
  });
});

describe('data quality', () => {
  it('reports no integrity errors on the current dataset and flags missing statistics as warnings', async () => {
    const report = await new DataQualityService(prisma).report();
    const failed = report.checks.filter((c) => c.status === 'FAIL');
    expect(failed).toEqual([]);
    const historical = report.coverage.find((c) => c.dataEnvironment === 'HISTORICAL')!;
    // OpenFootball supplies no statistics at all, so every finished match it owns starts without
    // them. Enrichment may since have filled some in, which is a gain, not a regression: assert
    // that the only matches holding statistics are ones an enrichment provider supplied.
    const enriched = await prisma.match.count({
      where: { dataEnvironment: 'HISTORICAL', status: 'FINISHED', stats: { some: { source: { not: 'openfootball' } } } },
    });
    expect(historical.withoutAnyStatistics).toBe(historical.finishedMatches - enriched);
    expect(await prisma.matchTeamStats.count({ where: { source: 'openfootball' } })).toBe(0);
    expect(report.checks.find((c) => c.check === 'missing statistics (HISTORICAL)')!.status).toBe('WARN');
  });

  it('detects planted integrity problems', async () => {
    await inRollback(async (tx) => {
      const m = await tx.match.findFirstOrThrow({ where: { dataEnvironment: 'LIVE', status: 'SCHEDULED' } });
      await tx.match.update({ where: { id: m.id }, data: { homeScore: 1 } });
      const report = await new DataQualityService(tx).report();
      expect(report.checks.find((c) => c.check === 'invalid scores')).toMatchObject({ status: 'FAIL', count: 1, examples: [m.id] });
      expect(report.status).toBe('ERRORS');
    });
  });
});
