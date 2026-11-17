import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyCalibration, compareOnValidation, evaluate, fitCalibration,
  rollingWindows, segmentsOf, splitHash, splitObservations,
} from '../src/blackjack/evaluation.js';
import { simulateObservations, type Observation } from '../src/blackjack/observations.js';
import { scoreForecasts } from '../src/blackjack/statistics.js';
import { DEFAULT_RULES } from '../src/blackjack/types.js';

let observations: Observation[] = [];

beforeAll(() => {
  observations = simulateObservations({ rounds: 24_000, rules: DEFAULT_RULES, seed: 4242, policy: 'stand' });
});

/** Moves probability between two dealer outcomes, making a model that is genuinely wrong. */
function distort(list: readonly Observation[], shift: number): Observation[] {
  return list.map((o) => {
    const d = [...o.dealerDistribution];
    const moved = Math.min(shift, d[5]);
    d[5] -= moved;
    d[3] += moved;
    return { ...o, dealerDistribution: d };
  });
}

describe('segmentation', () => {
  it('files a hand under every dimension at once', () => {
    const dimensions = segmentsOf(observations[0]).map((s) => s.dimension);
    expect(dimensions).toEqual(['overall', 'handType', 'upcard', 'playerTotal', 'deckComposition', 'playerDrew']);
  });

  it('tells hard, soft and pairs apart', () => {
    const kindOf = (cards: number[]): string => segmentsOf({ ...observations[0], playerCards: cards }).find((s) => s.dimension === 'handType')!.key;
    expect(kindOf([7, 7])).toBe('pair');
    expect(kindOf([0, 5])).toBe('soft');
    expect(kindOf([9, 5])).toBe('hard');
  });

  it('separates hands where the player drew after the forecast was made', () => {
    const drewKey = (drawn: number): string => segmentsOf({ ...observations[0], cardsDrawnAfterForecast: drawn }).find((s) => s.dimension === 'playerDrew')!.key;
    expect(drewKey(0)).toBe('no');
    expect(drewKey(2)).toBe('yes');
  });
});

describe('evaluating the solver', () => {
  it('finds no weakness in a model that is actually correct', () => {
    // The whole engine turns on this. These forecasts come from exact enumeration, so anything
    // reported as a weakness here would be noise that the corrections failed to hold back.
    const result = evaluate(observations);
    expect(result.n).toBeGreaterThan(20_000);
    expect(result.overall.goodnessOfFit.pValue).toBeGreaterThan(0.01);
    expect(result.overall.calibration.ece).toBeLessThan(0.01);
    expect(result.weaknesses).toHaveLength(0);
  });

  it('does find a weakness when the forecast really is wrong', () => {
    const result = evaluate(distort(observations, 0.04));
    expect(result.weaknesses.length).toBeGreaterThan(0);
    expect(result.overall.goodnessOfFit.pValue).toBeLessThan(0.001);
    expect(result.overall.flagged).toBe(true);
  });

  it('refuses to flag a segment too small to judge, and names it instead', () => {
    const tiny = observations.slice(0, 50);
    const result = evaluate(tiny, { minObservations: 400 });
    expect(result.weaknesses).toHaveLength(0);
    expect(result.insufficient.length).toBeGreaterThan(0);
    expect(result.insufficient.some((s) => s.segment.dimension === 'overall')).toBe(true);
  });

  it('reports every segment it looked at, flagged or not', () => {
    const result = evaluate(observations);
    expect(result.segments.length).toBeGreaterThan(10);
    expect(result.segments.every((s) => s.n > 0)).toBe(true);
    expect(result.segments.every((s) => s.adjustedPValue >= s.goodnessOfFit.pValue - 1e-12)).toBe(true);
  });
});

describe('rolling windows', () => {
  it('reports a window per block and nothing for a remainder too short to fill one', () => {
    const windows = rollingWindows(observations, 5000);
    expect(windows).toHaveLength(Math.floor(observations.length / 5000));
    expect(windows.every((w) => w.n === 5000)).toBe(true);
    // A correct model does not drift, so every window should look much like every other.
    const briers = windows.map((w) => w.brier);
    expect(Math.max(...briers) - Math.min(...briers)).toBeLessThan(0.05);
  });
});

describe('splitting', () => {
  it('is deterministic and reproducible', () => {
    expect(splitHash('abc')).toBe(splitHash('abc'));
    expect(splitHash('abc')).not.toBe(splitHash('abd'));
    const a = splitObservations(observations);
    const b = splitObservations(observations);
    expect(a.training.length).toBe(b.training.length);
    expect(a.validation.length).toBe(b.validation.length);
  });

  it('uses every observation exactly once, at roughly the share asked for', () => {
    const { training, validation } = splitObservations(observations, 0.7);
    expect(training.length + validation.length).toBe(observations.length);
    expect(training.length / observations.length).toBeGreaterThan(0.66);
    expect(training.length / observations.length).toBeLessThan(0.74);
  });
});

describe('recalibration has to earn its place', () => {
  it('is not justified against a model that was already correct', () => {
    const { training, validation } = splitObservations(observations);
    const model = fitCalibration(training);
    const comparison = compareOnValidation(validation, (o) => applyCalibration(model, o));
    expect(comparison.justified).toBe(false);
    // The factors do wobble: a rare outcome seen a couple of thousand times carries a few percent
    // of sampling noise, and fitting it is what fitting noise looks like. What must hold is that
    // the wobble buys nothing on hands the fit never saw.
    expect(Math.abs(comparison.meanImprovement)).toBeLessThan(0.002);
    for (const adjustment of model.adjustments) {
      for (const factor of adjustment.factors) expect(Math.abs(factor - 1)).toBeLessThan(0.25);
    }
  });

  it('is justified when there is a real bias to remove, and removes most of it', () => {
    const wrong = distort(observations, 0.05);
    const { training, validation } = splitObservations(wrong);
    const model = fitCalibration(training);
    const comparison = compareOnValidation(validation, (o) => applyCalibration(model, o));

    expect(comparison.justified).toBe(true);
    expect(comparison.candidateLogLoss).toBeLessThan(comparison.baselineLogLoss);
    expect(comparison.candidateBrier).toBeLessThan(comparison.baselineBrier);
    expect(comparison.interval.low).toBeGreaterThan(0);
  });

  it('does not let a model look good by being scored on what it was fitted to', () => {
    // Fit on noise that cannot generalise: a tiny training sample whose quirks are its own. In
    // sample the candidate must look better, and out of sample it must not be accepted.
    const wrong = distort(observations, 0);
    const { training, validation } = splitObservations(wrong, 0.02, 'overfit');
    const model = fitCalibration(training, 1);

    const inSample = compareOnValidation(training, (o) => applyCalibration(model, o));
    const outOfSample = compareOnValidation(validation, (o) => applyCalibration(model, o));

    expect(inSample.meanImprovement).toBeGreaterThan(outOfSample.meanImprovement);
    expect(outOfSample.justified).toBe(false);
  });

  it('leaves a forecast alone when it has never seen that upcard', () => {
    const model = fitCalibration(observations.filter((o) => o.dealerUpcard !== 0));
    const ace = observations.find((o) => o.dealerUpcard === 0)!;
    expect(applyCalibration(model, ace)).toEqual(ace.dealerDistribution);
  });

  it('always returns a probability distribution', () => {
    const model = fitCalibration(distort(observations, 0.06).slice(0, 5000));
    for (const o of observations.slice(0, 200)) {
      const adjusted = applyCalibration(model, o);
      expect(adjusted.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 10);
      expect(adjusted.every((p) => p >= 0 && p <= 1)).toBe(true);
    }
  });

  it('says nothing rather than something when there is nothing to compare', () => {
    const comparison = compareOnValidation([], (o) => o.dealerDistribution);
    expect(comparison.justified).toBe(false);
    expect(comparison.n).toBe(0);
  });
});

describe('the scoring the comparison relies on', () => {
  it('agrees with the paired comparison about which model did better', () => {
    const wrong = distort(observations, 0.05);
    const { training, validation } = splitObservations(wrong);
    const model = fitCalibration(training);
    const comparison = compareOnValidation(validation, (o) => applyCalibration(model, o));
    const direct = scoreForecasts(validation.map((o) => applyCalibration(model, o)), validation.map((o) => o.dealerOutcome));
    expect(direct.logLoss).toBeCloseTo(comparison.candidateLogLoss, 12);
  });
});
