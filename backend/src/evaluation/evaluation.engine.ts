import type { DataEnvironment, PredictionTarget, Prisma, PrismaClient } from '@prisma/client';
import type { ResultProbabilities } from '../models/types.js';
import { analyzeErrors, type ErrorAnalysis } from './error-analyzer.js';
import {
  actualNumeric,
  actualResultLabel,
  classificationMetrics,
  regressionMetrics,
  scoreNumeric,
  scoreResult,
  type ResultLabel,
} from './metrics.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface EvaluationFilter {
  dataEnvironment?: DataEnvironment;
  simulationRunId?: string | null;
  modelVersionId?: string;
  includeSimulations?: boolean;
  from?: Date;
  to?: Date;
}

const TARGETS: PredictionTarget[] = ['MATCH_RESULT', 'GOALS', 'CORNERS', 'CARDS', 'SHOTS', 'SHOTS_ON_TARGET'];

// Without simulations, only forecasts genuinely made before kickoff count; after-the-fact backtests are excluded.
// With simulations, each environment contributes only its latest completed simulation: re-running a replay of the
// same history must never double-count matches.
async function runWhere(db: Db, f: EvaluationFilter): Promise<Prisma.AnalysisRunWhereInput> {
  if (f.simulationRunId) return { simulationRunId: f.simulationRunId };
  if (!f.includeSimulations) return { simulationRunId: null, isSimulation: false };
  const latest = await db.simulationRun.findMany({
    where: { status: 'COMPLETED', ...(f.dataEnvironment ? { dataEnvironment: f.dataEnvironment } : {}) },
    orderBy: { startedAt: 'desc' },
    distinct: ['dataEnvironment'],
    select: { id: true },
  });
  return { OR: [{ simulationRunId: { in: latest.map((s) => s.id) } }, { simulationRunId: null }] };
}

export class EvaluationEngine {
  constructor(private readonly db: Db) {}

  // Compares every not-yet-evaluated forecast of a finished match with what actually happened.
  async evaluatePending(filter: EvaluationFilter = {}): Promise<{ evaluated: number; notEvaluable: number; byTarget: Record<string, number> }> {
    const pending = await this.db.prediction.findMany({
      where: {
        result: null,
        dataEnvironment: filter.dataEnvironment,
        modelVersionId: filter.modelVersionId,
        analysisRun: filter.simulationRunId ? { simulationRunId: filter.simulationRunId } : undefined,
        match: { status: 'FINISHED' },
      },
      include: { match: { select: { homeScore: true, awayScore: true, stats: { select: { corners: true, yellowCards: true, redCards: true, shots: true, shotsOnTarget: true } } } } },
    });
    let evaluated = 0;
    let notEvaluable = 0;
    const byTarget: Record<string, number> = {};
    const rows: Prisma.PredictionResultCreateManyInput[] = [];
    for (const p of pending) {
      let scored;
      if (p.target === 'MATCH_RESULT') {
        if (p.match.homeScore === null || p.match.awayScore === null || !p.probabilities || !p.predictedLabel) {
          notEvaluable += 1;
          continue;
        }
        scored = scoreResult(p.probabilities as unknown as ResultProbabilities, p.predictedLabel as ResultLabel, actualResultLabel(p.match.homeScore, p.match.awayScore));
      } else {
        const actual = actualNumeric(p.target, p.match);
        if (actual === null) {
          notEvaluable += 1;
          continue;
        }
        scored = scoreNumeric(p.target, p.predictedValue, actual);
      }
      rows.push({ predictionId: p.id, actualValue: scored.actualValue, actualLabel: scored.actualLabel, error: scored.error, absoluteError: scored.absoluteError, squaredError: scored.squaredError, wasCorrect: scored.wasCorrect });
      evaluated += 1;
      byTarget[p.target] = (byTarget[p.target] ?? 0) + 1;
    }
    if (rows.length > 0) await this.db.predictionResult.createMany({ data: rows, skipDuplicates: true });
    return { evaluated, notEvaluable, byTarget };
  }

  async performance(filter: EvaluationFilter) {
    const predictions = await this.db.prediction.findMany({
      where: {
        dataEnvironment: filter.dataEnvironment,
        modelVersionId: filter.modelVersionId,
        analysisRun: await runWhere(this.db, filter),
        result: { isNot: null },
        match: filter.from || filter.to ? { matchDate: { gte: filter.from, lt: filter.to } } : undefined,
      },
      include: {
        result: true,
        match: { select: { matchDate: true, competition: { select: { id: true, name: true } } } },
        modelVersion: { select: { version: true } },
      },
      orderBy: { match: { matchDate: 'asc' } },
    });

    const byTarget: Record<string, unknown> = {};
    const errors: ErrorAnalysis[] = [];
    for (const target of TARGETS) {
      const rows = predictions.filter((p) => p.target === target);
      if (rows.length === 0) continue;
      const featureRows = rows.map((p) => {
        const used = p.featuresUsed as { qualityStatus?: 'GOOD' | 'WARNINGS'; values?: Record<string, number | null> };
        return { error: p.result!.error, absoluteError: p.result!.absoluteError, predicted: p.predictedValue, qualityStatus: used.qualityStatus ?? null, features: used.values ?? {} };
      });
      const byCompetition: Record<string, { competition: string; n: number; metric: number }> = {};
      if (target === 'MATCH_RESULT') {
        const cls = classificationMetrics(
          rows.map((p) => ({ predicted: p.predictedLabel as ResultLabel, actual: p.result!.actualLabel as ResultLabel, probabilities: p.probabilities as unknown as ResultProbabilities, confidence: p.confidence })),
        )!;
        for (const p of rows) {
          const c = (byCompetition[p.match.competition.id] ??= { competition: p.match.competition.name, n: 0, metric: 0 });
          c.n += 1;
          c.metric += p.result!.wasCorrect ? 1 : 0;
        }
        for (const c of Object.values(byCompetition)) c.metric = Math.round((c.metric / c.n) * 1e4) / 1e4;
        byTarget[target] = { ...cls, byCompetition: Object.values(byCompetition), competitionMetric: 'accuracy' };
        errors.push(analyzeErrors(target, featureRows, cls.expectedCalibrationError));
      } else {
        const reg = regressionMetrics(target, rows.map((p) => ({ predicted: p.predictedValue, actual: p.result!.actualValue, confidence: p.confidence })))!;
        for (const p of rows) {
          const c = (byCompetition[p.match.competition.id] ??= { competition: p.match.competition.name, n: 0, metric: 0 });
          c.n += 1;
          c.metric += p.result!.absoluteError;
        }
        for (const c of Object.values(byCompetition)) c.metric = Math.round((c.metric / c.n) * 1e4) / 1e4;
        byTarget[target] = { ...reg, byCompetition: Object.values(byCompetition), competitionMetric: 'mae' };
        errors.push(analyzeErrors(target, featureRows));
      }
    }

    // Error over time (monthly), so dashboards can show whether performance is drifting.
    const monthly: Record<string, { month: string; target: string; n: number; meanAbsoluteError: number }> = {};
    for (const p of predictions) {
      const month = p.match.matchDate.toISOString().slice(0, 7);
      const k = `${month}|${p.target}`;
      const m = (monthly[k] ??= { month, target: p.target, n: 0, meanAbsoluteError: 0 });
      m.n += 1;
      m.meanAbsoluteError += p.result!.absoluteError;
    }
    for (const m of Object.values(monthly)) m.meanAbsoluteError = Math.round((m.meanAbsoluteError / m.n) * 1e4) / 1e4;

    const versions = [...new Set(predictions.map((p) => p.modelVersion.version))];
    return {
      filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() },
      matchesEvaluated: new Set(predictions.map((p) => p.matchId)).size,
      forecastsEvaluated: predictions.length,
      modelVersions: versions,
      window: predictions.length > 0 ? { from: predictions[0]!.match.matchDate.toISOString(), to: predictions.at(-1)!.match.matchDate.toISOString() } : null,
      byTarget,
      errorAnalysis: errors,
      overTime: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month) || a.target.localeCompare(b.target)),
    };
  }
}
