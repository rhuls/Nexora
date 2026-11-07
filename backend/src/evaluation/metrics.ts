import type { ConfidenceLevel, PredictionTarget } from '@prisma/client';
import type { ResultProbabilities } from '../models/types.js';

export type ResultLabel = 'HOME' | 'DRAW' | 'AWAY';
export const RESULT_LABELS: readonly ResultLabel[] = ['HOME', 'DRAW', 'AWAY'];

// |error| at or below this counts as a correct numeric forecast.
export const TOLERANCE: Record<Exclude<PredictionTarget, 'MATCH_RESULT'>, number> = { GOALS: 1, CORNERS: 2, CARDS: 1.5, SHOTS: 4, SHOTS_ON_TARGET: 2 };

const EPS = 1e-12;
const r = (v: number, p = 4) => Math.round(v * 10 ** p) / 10 ** p;

export interface ActualStats {
  homeScore: number | null;
  awayScore: number | null;
  stats: Array<{ corners: number | null; yellowCards: number | null; redCards: number | null; shots: number | null; shotsOnTarget: number | null }>;
}

export function actualResultLabel(homeScore: number, awayScore: number): ResultLabel {
  return homeScore > awayScore ? 'HOME' : homeScore < awayScore ? 'AWAY' : 'DRAW';
}

// Numeric actuals need both teams' values; a missing side makes the target not evaluable rather than zero.
export function actualNumeric(target: Exclude<PredictionTarget, 'MATCH_RESULT'>, m: ActualStats): number | null {
  if (target === 'GOALS') return m.homeScore === null || m.awayScore === null ? null : m.homeScore + m.awayScore;
  if (m.stats.length !== 2) return null;
  const pick = (f: (s: ActualStats['stats'][number]) => number | null) => {
    const values = m.stats.map(f);
    return values.some((v) => v === null) ? null : (values as number[]).reduce((a, b) => a + b, 0);
  };
  switch (target) {
    case 'CORNERS':
      return pick((s) => s.corners);
    case 'CARDS':
      return pick((s) => (s.yellowCards === null || s.redCards === null ? null : s.yellowCards + s.redCards));
    case 'SHOTS':
      return pick((s) => s.shots);
    case 'SHOTS_ON_TARGET':
      return pick((s) => s.shotsOnTarget);
  }
}

export function brier(p: ResultProbabilities, actual: ResultLabel): number {
  const o = (l: ResultLabel) => (l === actual ? 1 : 0);
  return (p.home - o('HOME')) ** 2 + (p.draw - o('DRAW')) ** 2 + (p.away - o('AWAY')) ** 2;
}

export const probabilityOf = (p: ResultProbabilities, l: ResultLabel) => (l === 'HOME' ? p.home : l === 'DRAW' ? p.draw : p.away);

export interface ScoredRow {
  predictedValue: number;
  actualValue: number;
  error: number;
  absoluteError: number;
  squaredError: number;
  wasCorrect: boolean;
  actualLabel: string | null;
}

export function scoreResult(p: ResultProbabilities, predicted: ResultLabel, actual: ResultLabel): ScoredRow {
  const pActual = probabilityOf(p, actual);
  return { predictedValue: probabilityOf(p, predicted), actualValue: r(pActual, 6), error: r(1 - pActual, 6), absoluteError: r(1 - pActual, 6), squaredError: r(brier(p, actual), 6), wasCorrect: predicted === actual, actualLabel: actual };
}

export function scoreNumeric(target: Exclude<PredictionTarget, 'MATCH_RESULT'>, predicted: number, actual: number): ScoredRow {
  const error = predicted - actual;
  return { predictedValue: predicted, actualValue: actual, error: r(error, 6), absoluteError: r(Math.abs(error), 6), squaredError: r(error * error, 6), wasCorrect: Math.abs(error) <= TOLERANCE[target], actualLabel: null };
}

export interface ClassificationRow {
  predicted: ResultLabel;
  actual: ResultLabel;
  probabilities: ResultProbabilities;
  confidence: ConfidenceLevel;
}

export interface CalibrationBin {
  from: number;
  to: number;
  n: number;
  meanPredicted: number | null;
  observed: number | null;
}

export function classificationMetrics(rows: ClassificationRow[]) {
  const n = rows.length;
  if (n === 0) return null;
  const accuracy = rows.filter((x) => x.predicted === x.actual).length / n;
  const perClass = Object.fromEntries(
    RESULT_LABELS.map((l) => {
      const tp = rows.filter((x) => x.predicted === l && x.actual === l).length;
      const fp = rows.filter((x) => x.predicted === l && x.actual !== l).length;
      const fn = rows.filter((x) => x.predicted !== l && x.actual === l).length;
      const support = tp + fn;
      // A class that occurs but is never predicted has precision 0, not "undefined" — otherwise macro scores are inflated.
      const precision = tp + fp === 0 ? (support > 0 ? 0 : null) : tp / (tp + fp);
      const recall = support === 0 ? null : tp / support;
      const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
      return [l, { support: tp + fn, predicted: tp + fp, precision: precision === null ? null : r(precision), recall: recall === null ? null : r(recall), f1: f1 === null ? null : r(f1) }];
    }),
  ) as Record<ResultLabel, { support: number; predicted: number; precision: number | null; recall: number | null; f1: number | null }>;
  const macro = (k: 'precision' | 'recall' | 'f1') => {
    const values = RESULT_LABELS.map((l) => perClass[l][k]).filter((v): v is number => v !== null);
    return values.length === 0 ? null : r(values.reduce((a, b) => a + b, 0) / values.length);
  };
  const brierMean = rows.reduce((s, x) => s + brier(x.probabilities, x.actual), 0) / n;
  const logLoss = rows.reduce((s, x) => s - Math.log(Math.max(EPS, probabilityOf(x.probabilities, x.actual))), 0) / n;

  const edges = [0, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0000001];
  const bins: CalibrationBin[] = edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1]!;
    const inBin = rows.filter((x) => {
      const p = probabilityOf(x.probabilities, x.predicted);
      return p >= from && p < to;
    });
    return {
      from,
      to: Math.min(1, to),
      n: inBin.length,
      meanPredicted: inBin.length === 0 ? null : r(inBin.reduce((s, x) => s + probabilityOf(x.probabilities, x.predicted), 0) / inBin.length),
      observed: inBin.length === 0 ? null : r(inBin.filter((x) => x.predicted === x.actual).length / inBin.length),
    };
  });
  const ece = bins.reduce((s, b) => (b.n === 0 ? s : s + (b.n / n) * Math.abs(b.meanPredicted! - b.observed!)), 0);
  const group = <K extends string>(key: (x: ClassificationRow) => K) => {
    const out: Record<string, { n: number; accuracy: number }> = {};
    for (const x of rows) {
      const k = key(x);
      out[k] ??= { n: 0, accuracy: 0 };
      out[k].n += 1;
      out[k].accuracy += x.predicted === x.actual ? 1 : 0;
    }
    for (const k of Object.keys(out)) out[k]!.accuracy = r(out[k]!.accuracy / out[k]!.n);
    return out;
  };

  return {
    n,
    accuracy: r(accuracy),
    precisionMacro: macro('precision'),
    recallMacro: macro('recall'),
    f1Macro: macro('f1'),
    brier: r(brierMean),
    logLoss: r(logLoss),
    expectedCalibrationError: r(ece),
    perClass,
    calibration: bins,
    byConfidence: group((x) => x.confidence),
    byPredictedOutcome: group((x) => x.predicted),
  };
}

export interface RegressionRow {
  predicted: number;
  actual: number;
  confidence: ConfidenceLevel;
}

export function regressionMetrics(target: Exclude<PredictionTarget, 'MATCH_RESULT'>, rows: RegressionRow[]) {
  const n = rows.length;
  if (n === 0) return null;
  const errors = rows.map((x) => x.predicted - x.actual);
  const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / n;
  const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / n);
  const bias = errors.reduce((s, e) => s + e, 0) / n;
  const within = errors.filter((e) => Math.abs(e) <= TOLERANCE[target]).length / n;
  const byConfidence: Record<string, { n: number; mae: number }> = {};
  rows.forEach((x, i) => {
    byConfidence[x.confidence] ??= { n: 0, mae: 0 };
    byConfidence[x.confidence]!.n += 1;
    byConfidence[x.confidence]!.mae += Math.abs(errors[i]!);
  });
  for (const k of Object.keys(byConfidence)) byConfidence[k]!.mae = r(byConfidence[k]!.mae / byConfidence[k]!.n);
  return { n, mae: r(mae), rmse: r(rmse), bias: r(bias), withinTolerance: r(within), tolerance: TOLERANCE[target], meanActual: r(rows.reduce((s, x) => s + x.actual, 0) / n), byConfidence };
}
