import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../src/data/synthetic/prng.js';
import {
  calibrate, chiSquareGoodnessOfFit, chiSquarePValue, LOG_LOSS_EPSILON,
  normalCdf, proportionTest, scoreForecasts, wilsonInterval,
} from '../src/blackjack/statistics.js';

const draw = (rng: SeededRandom, probabilities: readonly number[]): number => {
  let roll = rng.next();
  for (let i = 0; i < probabilities.length; i += 1) {
    roll -= probabilities[i];
    if (roll <= 0) return i;
  }
  return probabilities.length - 1;
};

describe('scoring forecasts', () => {
  it('matches values worked out by hand', () => {
    // (0.7-1)^2 + (0.3-0)^2 = 0.18, and -ln(0.7) = 0.356675.
    const s = scoreForecasts([[0.7, 0.3]], [0]);
    expect(s.brier).toBeCloseTo(0.18, 12);
    expect(s.logLoss).toBeCloseTo(-Math.log(0.7), 12);
    expect(s.clamped).toBe(0);
  });

  it('scores certainty at nothing when right and at the limit when wrong', () => {
    expect(scoreForecasts([[1, 0]], [0]).brier).toBeCloseTo(0, 12);
    expect(scoreForecasts([[1, 0]], [0]).logLoss).toBeCloseTo(0, 12);
    const wrong = scoreForecasts([[0, 1]], [0]);
    expect(wrong.brier).toBeCloseTo(2, 12);
    expect(wrong.logLoss).toBeCloseTo(-Math.log(LOG_LOSS_EPSILON), 6);
    expect(wrong.clamped).toBe(1);
  });

  it('is a proper scoring rule: honesty beats every distortion', () => {
    // Generated from a known distribution, the true probabilities must score best. If this failed,
    // the engine could be gamed into preferring a confidently wrong model.
    const truth = [0.5, 0.3, 0.2];
    const rng = new SeededRandom(11);
    const outcomes = Array.from({ length: 40_000 }, () => draw(rng, truth));
    const honest = scoreForecasts(outcomes.map(() => truth), outcomes);
    for (const distorted of [[0.6, 0.25, 0.15], [0.4, 0.35, 0.25], [0.8, 0.1, 0.1], [1 / 3, 1 / 3, 1 / 3]]) {
      const scored = scoreForecasts(outcomes.map(() => distorted), outcomes);
      expect(scored.brier).toBeGreaterThan(honest.brier);
      expect(scored.logLoss).toBeGreaterThan(honest.logLoss);
    }
  });

  it('refuses a forecast that does not cover the outcome', () => {
    expect(() => scoreForecasts([[0.5, 0.5]], [2])).toThrow();
    expect(() => scoreForecasts([[1]], [])).toThrow();
  });
});

describe('intervals', () => {
  it('matches the published Wilson interval for 5 of 10', () => {
    const i = wilsonInterval(5, 10);
    expect(i.low).toBeCloseTo(0.2366, 4);
    expect(i.high).toBeCloseTo(0.7634, 4);
  });

  it('stays inside [0,1] at the extremes, where the normal approximation would not', () => {
    const none = wilsonInterval(0, 10);
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0);
    expect(none.high).toBeLessThan(1);
    const all = wilsonInterval(10, 10);
    expect(all.high).toBe(1);
    expect(all.low).toBeGreaterThan(0);
  });

  it('narrows as evidence accumulates', () => {
    const widths = [10, 100, 1000, 10_000].map((n) => {
      const i = wilsonInterval(n / 2, n);
      return i.high - i.low;
    });
    for (let i = 1; i < widths.length; i += 1) expect(widths[i]).toBeLessThan(widths[i - 1]);
  });

  it('says nothing at all when there is no evidence', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('distributions', () => {
  it('reproduces known normal values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.959963984540054)).toBeCloseTo(0.025, 5);
    expect(normalCdf(-6)).toBeLessThan(1e-8);
  });

  it('reproduces known chi-square critical values', () => {
    // The 5% critical values from any table: 3.841 at 1 df, 5.991 at 2, 11.070 at 5.
    expect(chiSquarePValue(3.8414588, 1)).toBeCloseTo(0.05, 4);
    expect(chiSquarePValue(5.9914645, 2)).toBeCloseTo(0.05, 4);
    expect(chiSquarePValue(11.070498, 5)).toBeCloseTo(0.05, 4);
    expect(chiSquarePValue(0, 3)).toBe(1);
    expect(chiSquarePValue(1000, 1)).toBeLessThan(1e-12);
  });
});

describe('goodness of fit', () => {
  it('finds nothing wrong when the counts are exactly what was expected', () => {
    const r = chiSquareGoodnessOfFit([50, 30, 20], [50, 30, 20]);
    expect(r.statistic).toBeCloseTo(0, 12);
    expect(r.pValue).toBe(1);
    expect(r.df).toBe(2);
  });

  it('keeps its false-positive rate near the level it claims', () => {
    // Twelve hundred runs drawn from exactly the expected distribution: about 5% should trip at
    // p < 0.05 and no more, or every reading this engine makes would be noise dressed as evidence.
    const truth = [0.4, 0.35, 0.25];
    const rng = new SeededRandom(7);
    let flagged = 0;
    const runs = 1200;
    for (let run = 0; run < runs; run += 1) {
      const counts = [0, 0, 0];
      for (let i = 0; i < 400; i += 1) counts[draw(rng, truth)] += 1;
      if (chiSquareGoodnessOfFit(counts, truth.map((p) => p * 400)).pValue < 0.05) flagged += 1;
    }
    expect(flagged / runs).toBeGreaterThan(0.02);
    expect(flagged / runs).toBeLessThan(0.09);
  });

  it('detects a distribution that really is different', () => {
    const rng = new SeededRandom(3);
    const counts = [0, 0, 0];
    for (let i = 0; i < 4000; i += 1) counts[draw(rng, [0.5, 0.3, 0.2])] += 1;
    const r = chiSquareGoodnessOfFit(counts, [0.4, 0.35, 0.25].map((p) => p * 4000));
    expect(r.pValue).toBeLessThan(0.001);
  });

  it('marks a result unusable rather than reporting a p-value the sample cannot support', () => {
    const r = chiSquareGoodnessOfFit([3, 1, 0], [2, 1, 1]);
    expect(r.usable).toBe(false);
    expect(r.lowExpectedCategories).toBeGreaterThan(0);
  });

  it('treats an outcome the model ruled out as a flat contradiction', () => {
    const r = chiSquareGoodnessOfFit([1, 99], [0, 100]);
    expect(r.pValue).toBe(0);
    expect(r.statistic).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('testing a rate against a forecast', () => {
  it('does not flag a count that matches the forecast', () => {
    const r = proportionTest(300, 1000, 0.3);
    expect(r.significant).toBe(false);
    expect(r.pValue).toBeGreaterThan(0.9);
    expect(r.difference).toBeCloseTo(0, 12);
  });

  it('flags a rate that is genuinely off, and reports which way', () => {
    const r = proportionTest(400, 1000, 0.3);
    expect(r.significant).toBe(true);
    expect(r.pValue).toBeLessThan(1e-10);
    expect(r.difference).toBeCloseTo(0.1, 12);
  });

  it('refuses to call a small sample evidence', () => {
    // Three from four is a 75% rate against a 30% forecast, and still proves nothing.
    const r = proportionTest(3, 4, 0.3);
    expect(r.significant).toBe(false);
    expect(r.interval.high).toBeGreaterThan(0.9);
  });

  it('handles a forecast of certainty without dividing by zero', () => {
    expect(proportionTest(10, 10, 1).significant).toBe(false);
    expect(proportionTest(9, 10, 1).significant).toBe(true);
    expect(proportionTest(0, 10, 0).significant).toBe(false);
    expect(proportionTest(1, 10, 0).significant).toBe(true);
  });
});

describe('calibration', () => {
  it('reports a calibrated forecaster as calibrated', () => {
    // Forecasts spread over [0,1], outcomes drawn at exactly the stated probability.
    const rng = new SeededRandom(5);
    const pairs = Array.from({ length: 50_000 }, () => {
      const forecast = rng.next();
      return { forecast, occurred: rng.next() < forecast };
    });
    const c = calibrate(pairs);
    expect(c.ece).toBeLessThan(0.01);
    expect(Math.abs(c.bias)).toBeLessThan(0.01);
    expect(c.bins.filter((b) => b.outsideInterval)).toHaveLength(0);
  });

  it('catches a forecaster that is systematically too confident', () => {
    // Says p, but the thing happens at p - 0.1.
    const rng = new SeededRandom(9);
    const pairs = Array.from({ length: 50_000 }, () => {
      const forecast = 0.2 + rng.next() * 0.6;
      return { forecast, occurred: rng.next() < forecast - 0.1 };
    });
    const c = calibrate(pairs);
    expect(c.bias).toBeGreaterThan(0.08);
    expect(c.ece).toBeGreaterThan(0.08);
    expect(c.bins.filter((b) => b.outsideInterval).length).toBeGreaterThan(3);
  });

  it('does not call a thinly populated bin miscalibrated', () => {
    const pairs = [{ forecast: 0.05, occurred: true }, { forecast: 0.95, occurred: false }];
    const c = calibrate(pairs);
    expect(c.bins.every((b) => !b.outsideInterval)).toBe(true);
  });

  it('puts every forecast in exactly one bin, including the endpoints', () => {
    const pairs = [0, 0.1, 0.5, 0.9, 1].map((forecast) => ({ forecast, occurred: true }));
    const c = calibrate(pairs, 10, 1);
    expect(c.bins.reduce((sum, b) => sum + b.n, 0)).toBe(pairs.length);
    expect(c.n).toBe(5);
  });
});
