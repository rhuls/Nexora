// Does the model's confidence match what happens, and if not, where?
//
// Two habits run through this file. Nothing is called a weakness on the strength of a small
// sample, and nothing is called an improvement unless it holds on observations that were not used
// to build it. Both exist because the easiest way to produce a convincing dashboard is to let
// noise through, and a convincing dashboard about noise is worse than none.

import { DEALER_OUTCOMES, DEALER_OUTCOME_COUNT, type Observation } from './observations.js';
import { handTotal } from './solver.js';
import {
  calibrate, chiSquareGoodnessOfFit, normalCdf, proportionTest, scoreForecasts,
  type Calibration, type GoodnessOfFit, type Interval, type ProportionTest,
} from './statistics.js';
import { countCards, type Composition } from './types.js';

const RANK_LABEL = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'];

export interface Segment {
  dimension: string;
  key: string;
  label: string;
}

const tenRichness = (remaining: Composition): number => {
  const total = countCards(remaining);
  if (total <= 0) return 0;
  // Ten-value cards are 16 of every 52, so this is above one when the shoe is rich in them.
  return remaining[9] / total / (16 / 52);
};

/** Every bucket an observation belongs to. One observation lands in several dimensions at once. */
export function segmentsOf(o: Observation): Segment[] {
  const [total, soft] = handTotal(o.playerCards);
  const isPair = o.playerCards.length === 2 && o.playerCards[0] === o.playerCards[1];
  const handType = isPair ? 'pair' : soft ? 'soft' : 'hard';
  const totalBucket = total <= 8 ? '4-8' : total <= 11 ? '9-11' : total <= 16 ? '12-16' : '17-21';
  const richness = tenRichness(o.remaining);
  const richnessBucket = richness < 0.92 ? 'ten-poor' : richness > 1.08 ? 'ten-rich' : 'neutral';

  return [
    { dimension: 'overall', key: 'all', label: 'All observations' },
    { dimension: 'handType', key: handType, label: `${handType} hands` },
    { dimension: 'upcard', key: String(o.dealerUpcard), label: `dealer ${RANK_LABEL[o.dealerUpcard]}` },
    { dimension: 'playerTotal', key: totalBucket, label: `player total ${totalBucket}` },
    { dimension: 'deckComposition', key: richnessBucket, label: `shoe ${richnessBucket}` },
    { dimension: 'playerDrew', key: o.cardsDrawnAfterForecast > 0 ? 'yes' : 'no', label: o.cardsDrawnAfterForecast > 0 ? 'player drew after the forecast' : 'no cards drawn after the forecast' },
  ];
}

export interface CategoryResult {
  category: string;
  forecastRate: number;
  observedRate: number;
  test: ProportionTest;
}

export interface SegmentEvaluation {
  segment: Segment;
  n: number;
  brier: number;
  logLoss: number;
  calibration: Calibration;
  goodnessOfFit: GoodnessOfFit;
  categories: CategoryResult[];
  /** Benjamini-Hochberg adjusted p-value for this segment's goodness-of-fit test. */
  adjustedPValue: number;
  /** True only when the sample is large enough, the test is usable, and it survives the correction. */
  flagged: boolean;
}

export interface EvaluationOptions {
  /** Below this, a segment is reported but never flagged. */
  minObservations?: number;
  /** False discovery rate for the multiple-comparison correction. */
  falseDiscoveryRate?: number;
  calibrationBins?: number;
}

function evaluateGroup(segment: Segment, group: readonly Observation[]): Omit<SegmentEvaluation, 'adjustedPValue' | 'flagged'> {
  const observedCounts = new Array(DEALER_OUTCOME_COUNT).fill(0);
  const expectedCounts = new Array(DEALER_OUTCOME_COUNT).fill(0);
  for (const o of group) {
    observedCounts[o.dealerOutcome] += 1;
    for (let k = 0; k < DEALER_OUTCOME_COUNT; k += 1) expectedCounts[k] += o.dealerDistribution[k];
  }
  const n = group.length;
  const scored = scoreForecasts(group.map((o) => o.dealerDistribution), group.map((o) => o.dealerOutcome));
  const pairs = group.flatMap((o) => o.dealerDistribution.map((forecast, k) => ({ forecast, occurred: o.dealerOutcome === k })));
  return {
    segment,
    n,
    brier: scored.brier,
    logLoss: scored.logLoss,
    calibration: calibrate(pairs, 10, Math.max(20, Math.floor(n / 20))),
    goodnessOfFit: chiSquareGoodnessOfFit(observedCounts, expectedCounts),
    categories: DEALER_OUTCOMES.map((category, k) => ({
      category,
      forecastRate: n === 0 ? 0 : expectedCounts[k] / n,
      observedRate: n === 0 ? 0 : observedCounts[k] / n,
      test: proportionTest(observedCounts[k], n, n === 0 ? 0 : expectedCounts[k] / n),
    })),
  };
}

/**
 * Benjamini-Hochberg. Dozens of segments tested at five percent would hand back a couple of
 * "weaknesses" from a model that is perfectly correct, so what is controlled is the share of
 * flags that are false rather than the chance of any single test misfiring.
 */
function adjustPValues(pValues: readonly number[], fdr: number): { adjusted: number[]; rejected: boolean[] } {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = order.length;
  const adjusted = new Array(m).fill(1);
  let previous = 1;
  for (let rank = m - 1; rank >= 0; rank -= 1) {
    const value = Math.min(previous, (order[rank].p * m) / (rank + 1));
    adjusted[order[rank].i] = value;
    previous = value;
  }
  return { adjusted, rejected: adjusted.map((p) => p <= fdr) };
}

export interface Evaluation {
  n: number;
  overall: SegmentEvaluation;
  segments: SegmentEvaluation[];
  weaknesses: SegmentEvaluation[];
  /** Segments too thinly populated to say anything about, named so the silence is explicit. */
  insufficient: Array<{ segment: Segment; n: number }>;
}

export function evaluate(observations: readonly Observation[], options: EvaluationOptions = {}): Evaluation {
  const { minObservations = 400, falseDiscoveryRate = 0.05 } = options;
  const groups = new Map<string, { segment: Segment; items: Observation[] }>();
  for (const o of observations) {
    for (const segment of segmentsOf(o)) {
      const key = `${segment.dimension}:${segment.key}`;
      const entry = groups.get(key) ?? { segment, items: [] };
      entry.items.push(o);
      groups.set(key, entry);
    }
  }

  const testable: Array<Omit<SegmentEvaluation, 'adjustedPValue' | 'flagged'>> = [];
  const insufficient: Array<{ segment: Segment; n: number }> = [];
  for (const { segment, items } of groups.values()) {
    const result = evaluateGroup(segment, items);
    if (items.length < minObservations || !result.goodnessOfFit.usable) insufficient.push({ segment, n: items.length });
    testable.push(result);
  }

  const eligible = testable.filter((r) => r.n >= minObservations && r.goodnessOfFit.usable);
  const { adjusted, rejected } = adjustPValues(eligible.map((r) => r.goodnessOfFit.pValue), falseDiscoveryRate);
  const adjustedBySegment = new Map<string, { adjusted: number; rejected: boolean }>();
  eligible.forEach((r, i) => adjustedBySegment.set(`${r.segment.dimension}:${r.segment.key}`, { adjusted: adjusted[i], rejected: rejected[i] }));

  const segments: SegmentEvaluation[] = testable.map((r) => {
    const found = adjustedBySegment.get(`${r.segment.dimension}:${r.segment.key}`);
    return { ...r, adjustedPValue: found?.adjusted ?? 1, flagged: found?.rejected ?? false };
  });
  // Every observation carries the overall segment, so it exists whenever anything does. With no
  // observations at all there is nothing to report and an empty evaluation is the honest answer.
  const overall = segments.find((s) => s.segment.dimension === 'overall')
    ?? { ...evaluateGroup({ dimension: 'overall', key: 'all', label: 'All observations' }, observations), adjustedPValue: 1, flagged: false };

  return {
    n: observations.length,
    overall,
    segments: segments.sort((a, b) => a.goodnessOfFit.pValue - b.goodnessOfFit.pValue),
    weaknesses: segments.filter((s) => s.flagged).sort((a, b) => a.adjustedPValue - b.adjustedPValue),
    insufficient,
  };
}

// ---- Rolling windows ----

export interface Window {
  from: number;
  to: number;
  n: number;
  brier: number;
  logLoss: number;
  ece: number;
  bias: number;
}

/** Metrics over successive blocks, so a model that is drifting can be told from one that is not. */
export function rollingWindows(observations: readonly Observation[], windowSize = 2000): Window[] {
  const out: Window[] = [];
  for (let start = 0; start + windowSize <= observations.length; start += windowSize) {
    const slice = observations.slice(start, start + windowSize);
    const scored = scoreForecasts(slice.map((o) => o.dealerDistribution), slice.map((o) => o.dealerOutcome));
    const cal = calibrate(slice.flatMap((o) => o.dealerDistribution.map((forecast, k) => ({ forecast, occurred: o.dealerOutcome === k }))), 10, 50);
    out.push({ from: start, to: start + windowSize, n: slice.length, brier: scored.brier, logLoss: scored.logLoss, ece: cal.ece, bias: cal.bias });
  }
  return out;
}

// ---- Recalibration, and the trial it has to survive ----

/** Deterministic 32-bit FNV-1a, so the same observation always lands in the same split. */
export function splitHash(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface Split<T> {
  training: T[];
  validation: T[];
}

/** Splits by a hash of each observation's own identity rather than by position or by chance. */
export function splitObservations(observations: readonly Observation[], trainingShare = 0.7, salt = 'nexora'): Split<Observation> {
  const training: Observation[] = [];
  const validation: Observation[] = [];
  observations.forEach((o, index) => {
    const key = `${salt}|${o.modelVersion}|${index}|${o.dealerUpcard}|${o.playerCards.join('')}|${o.dealerFinalCards.join('')}`;
    ((splitHash(key) % 10_000) / 10_000 < trainingShare ? training : validation).push(o);
  });
  return { training, validation };
}

export interface Adjustment {
  dimension: string;
  key: string;
  /** One multiplier per dealer outcome, applied to the solver's forecast before renormalising. */
  factors: number[];
  n: number;
}

export interface CalibrationModel {
  /** How much evidence it takes to move a factor appreciably; higher means more conservative. */
  priorStrength: number;
  adjustments: Adjustment[];
}

/**
 * Fits multiplicative corrections per dealer upcard from the training half.
 *
 * Each factor is a Dirichlet posterior mean divided by what the solver said, so a segment with
 * little evidence returns a factor near one and changes nothing. The prior is the solver's own
 * forecast: the model has to be argued out of its position, not into it.
 */
export function fitCalibration(training: readonly Observation[], priorStrength = 2000): CalibrationModel {
  const byUpcard = new Map<number, Observation[]>();
  for (const o of training) {
    const list = byUpcard.get(o.dealerUpcard) ?? [];
    list.push(o);
    byUpcard.set(o.dealerUpcard, list);
  }
  const adjustments: Adjustment[] = [];
  for (const [upcard, group] of byUpcard) {
    const observedCounts = new Array(DEALER_OUTCOME_COUNT).fill(0);
    const expectedRates = new Array(DEALER_OUTCOME_COUNT).fill(0);
    for (const o of group) {
      observedCounts[o.dealerOutcome] += 1;
      for (let k = 0; k < DEALER_OUTCOME_COUNT; k += 1) expectedRates[k] += o.dealerDistribution[k];
    }
    const n = group.length;
    const factors = new Array(DEALER_OUTCOME_COUNT).fill(1);
    for (let k = 0; k < DEALER_OUTCOME_COUNT; k += 1) {
      const prior = expectedRates[k] / n;
      if (prior <= 0) continue;
      const posterior = (observedCounts[k] + priorStrength * prior) / (n + priorStrength);
      factors[k] = posterior / prior;
    }
    adjustments.push({ dimension: 'upcard', key: String(upcard), factors, n });
  }
  return { priorStrength, adjustments };
}

export function applyCalibration(model: CalibrationModel, o: Observation): number[] {
  const adjustment = model.adjustments.find((a) => a.dimension === 'upcard' && a.key === String(o.dealerUpcard));
  if (!adjustment) return [...o.dealerDistribution];
  const raw = o.dealerDistribution.map((p, k) => p * adjustment.factors[k]);
  const total = raw.reduce((sum, p) => sum + p, 0);
  return total > 0 ? raw.map((p) => p / total) : [...o.dealerDistribution];
}

export interface PairedComparison {
  n: number;
  baselineLogLoss: number;
  candidateLogLoss: number;
  baselineBrier: number;
  candidateBrier: number;
  /** Mean per-observation improvement in log loss. Positive means the candidate did better. */
  meanImprovement: number;
  interval: Interval;
  z: number;
  pValue: number;
  /** The only question that matters: did it beat the baseline on observations it never saw? */
  justified: boolean;
}

/**
 * Compares a candidate against the baseline on held-out observations, hand by hand.
 *
 * Pairing matters: both models saw the same hands, so comparing their per-hand losses directly
 * removes the variance of the hands themselves and leaves only the difference between the models.
 */
export function compareOnValidation(validation: readonly Observation[], candidate: (o: Observation) => number[]): PairedComparison {
  const n = validation.length;
  if (n === 0) {
    return { n: 0, baselineLogLoss: 0, candidateLogLoss: 0, baselineBrier: 0, candidateBrier: 0, meanImprovement: 0, interval: { low: 0, high: 0 }, z: 0, pValue: 1, justified: false };
  }
  const base = scoreForecasts(validation.map((o) => o.dealerDistribution), validation.map((o) => o.dealerOutcome));
  const candidateForecasts = validation.map(candidate);
  const cand = scoreForecasts(candidateForecasts, validation.map((o) => o.dealerOutcome));

  const diffs = validation.map((o, i) => {
    const p0 = Math.max(o.dealerDistribution[o.dealerOutcome], 1e-15);
    const p1 = Math.max(candidateForecasts[i][o.dealerOutcome], 1e-15);
    return -Math.log(p0) - -Math.log(p1); // positive when the candidate assigned more probability
  });
  const mean = diffs.reduce((sum, d) => sum + d, 0) / n;
  const variance = diffs.reduce((sum, d) => sum + (d - mean) ** 2, 0) / Math.max(1, n - 1);
  const stdError = Math.sqrt(variance / n);
  const z = stdError === 0 ? 0 : mean / stdError;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  const half = 1.959963984540054 * stdError;
  return {
    n,
    baselineLogLoss: base.logLoss,
    candidateLogLoss: cand.logLoss,
    baselineBrier: base.brier,
    candidateBrier: cand.brier,
    meanImprovement: mean,
    interval: { low: mean - half, high: mean + half },
    z,
    pValue,
    // Better on held-out data, and by more than the interval's width allows to be chance.
    justified: mean > 0 && pValue < 0.05 && mean - half > 0,
  };
}
