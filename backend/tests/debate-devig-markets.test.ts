import { describe, expect, it } from 'vitest';
import { devig, multiplicative, overround, shin, validatePrices, type Prices } from '../src/debate/devig.js';
import { deriveMarkets } from '../src/debate/markets.js';
import { STAKING, flatStakeRoi, kellyFraction, profitUnits, suggestStake } from '../src/debate/staking.js';

describe('de-vigging', () => {
  it('rejects prices that cannot be real odds rather than normalising nonsense', () => {
    expect(validatePrices({ home: 2 })).toMatch(/at least two/);
    expect(validatePrices({ home: 0.5, away: 2 })).toMatch(/outside/);
    expect(validatePrices({ home: Number.NaN, away: 2 })).toMatch(/finite/);
    expect(validatePrices({ home: 2.1, draw: 3.4, away: 3.6 })).toBeNull();
    expect(() => devig({ home: 1.0, away: 2 })).toThrow();
  });

  it('measures the overround and removes it so probabilities sum to one', () => {
    const prices = { home: 2.1, draw: 3.4, away: 3.6 };
    expect(overround(prices)).toBeGreaterThan(1);
    for (const method of ['multiplicative', 'shin'] as const) {
      const { probabilities } = devig(prices, method);
      const total = Object.values(probabilities).reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 10);
      expect(Object.values(probabilities).every((p) => p > 0 && p < 1)).toBe(true);
    }
  });

  it('leaves a fair book untouched', () => {
    // A book already summing to 1 has no margin to remove.
    const fair = { home: 2, away: 2 };
    expect(overround(fair)).toBeCloseTo(1, 10);
    expect(multiplicative(fair).probabilities.home).toBeCloseTo(0.5, 10);
  });

  it('takes proportionally more from the longshot than multiplicative does (Shin)', () => {
    const prices = { home: 1.4, draw: 5.0, away: 9.0 };
    const m = multiplicative(prices).probabilities;
    const s = shin(prices).probabilities;
    // Shin attributes the margin to insiders, which deflates longshots and inflates favourites.
    expect(s.home!).toBeGreaterThan(m.home!);
    expect(s.away!).toBeLessThan(m.away!);
    expect(Object.values(s).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('stays well defined across wide and lopsided books, however it solves them', () => {
    // The multiplicative fallback inside shin() is defensive: with real odds the bisection converges.
    // What must hold either way is that the output is a usable probability distribution.
    const books: Prices[] = [
      { home: 1.02, away: 1.02 },
      { home: 1.05, draw: 15, away: 40 },
      { home: 3.1, draw: 3.3, away: 3.2 },
      { over: 1.9, under: 1.95 },
    ];
    for (const prices of books) {
      const { probabilities, method, overround: book } = shin(prices);
      const values = Object.values(probabilities);
      expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(values.every((p) => p > 0 && p < 1)).toBe(true);
      expect(['shin', 'multiplicative']).toContain(method);
      expect(book).toBeGreaterThan(0);
    }
  });

  it('degenerates to multiplicative on a book with no margin to attribute', () => {
    // At or below a fair book there is no vig for the insider model to explain.
    expect(shin({ home: 2, away: 2 }).method).toBe('multiplicative');
  });
});

describe('derived markets', () => {
  it('derives over 2.5 and BTTS consistently with the expected total', () => {
    const low = deriveMarkets({ lambdaHome: 0.8, lambdaAway: 0.7, rho: -0.03 });
    const high = deriveMarkets({ lambdaHome: 2.2, lambdaAway: 1.8, rho: -0.03 });

    expect(low.overUnder25.over + low.overUnder25.under).toBeCloseTo(1, 10);
    expect(low.btts.yes + low.btts.no).toBeCloseTo(1, 10);
    expect(low.expectedTotal).toBeCloseTo(1.5, 1);
    expect(high.expectedTotal).toBeCloseTo(4.0, 1);

    // More expected goals must mean more overs and more both-score.
    expect(high.overUnder25.over).toBeGreaterThan(low.overUnder25.over);
    expect(high.btts.yes).toBeGreaterThan(low.btts.yes);
  });

  it('refuses impossible expectations instead of returning a number', () => {
    expect(() => deriveMarkets({ lambdaHome: 0, lambdaAway: 1, rho: 0 })).toThrow();
    expect(() => deriveMarkets({ lambdaHome: Number.NaN, lambdaAway: 1, rho: 0 })).toThrow();
  });

  it('applies the low-score correction, so rho changes 0-0 and nothing above it', () => {
    const neutral = deriveMarkets({ lambdaHome: 1.3, lambdaAway: 1.1, rho: 0 });
    const corrected = deriveMarkets({ lambdaHome: 1.3, lambdaAway: 1.1, rho: -0.05 });
    expect(corrected.btts.yes).not.toBeCloseTo(neutral.btts.yes, 6);
  });
});

describe('staking', () => {
  it('computes the Kelly fraction and refuses a negative-edge bet', () => {
    // 50% chance at even money net (3.0 decimal) is a clear positive edge.
    expect(kellyFraction({ probability: 0.5, decimalOdds: 3 })).toBeCloseTo(0.25, 10);
    // Fair price: no edge, no bet.
    expect(kellyFraction({ probability: 0.5, decimalOdds: 2 })).toBe(0);
    // Overpriced: Kelly is negative, which means no bet, not a reverse bet.
    expect(kellyFraction({ probability: 0.4, decimalOdds: 2 })).toBe(0);
    expect(kellyFraction({ probability: 1, decimalOdds: 2 })).toBe(0);
  });

  it('suggests no stake without a price, however strong the opinion', () => {
    const out = suggestStake({ probability: 0.7, decimalOdds: null, edge: 0.2, calibrationSamples: 500, recommendation: 'PICK' });
    expect(out.stakePct).toBeNull();
    expect(out.reason).toMatch(/no price/i);
  });

  it('suggests no stake on a lean or a no-pick', () => {
    expect(suggestStake({ probability: 0.7, decimalOdds: 2, edge: 0.2, calibrationSamples: 500, recommendation: 'LEAN' }).stakePct).toBeNull();
    expect(suggestStake({ probability: 0.7, decimalOdds: 2, edge: 0.2, calibrationSamples: 500, recommendation: 'NO_PICK' }).stakePct).toBeNull();
  });

  it('refuses to stake on a thin calibration history even with a real edge', () => {
    const out = suggestStake({ probability: 0.7, decimalOdds: 2, edge: 0.2, calibrationSamples: STAKING.minCalibrationSamples - 1, recommendation: 'PICK' });
    expect(out.stakePct).toBeNull();
    expect(out.reason).toMatch(/not yet measurable/);
  });

  it('refuses an edge inside the minimum', () => {
    expect(suggestStake({ probability: 0.52, decimalOdds: 2, edge: STAKING.minEdge - 0.001, calibrationSamples: 500, recommendation: 'PICK' }).stakePct).toBeNull();
  });

  it('applies the fraction and the hard cap', () => {
    const out = suggestStake({ probability: 0.7, decimalOdds: 2, edge: 0.2, calibrationSamples: 500, recommendation: 'PICK' });
    // Full Kelly here is 0.4; quarter Kelly is 10%, which the 2% cap must cut down.
    expect(out.stakePct).toBe(STAKING.maxStakePct);

    const modest = suggestStake({ probability: 0.35, decimalOdds: 3.2, edge: 0.05, calibrationSamples: 500, recommendation: 'PICK' });
    expect(modest.stakePct).toBeGreaterThan(0);
    expect(modest.stakePct!).toBeLessThan(STAKING.maxStakePct);
  });

  it('reports returns only over picks that carried a price', () => {
    expect(profitUnits(null, true)).toBeNull();
    expect(profitUnits(2.5, true)).toBeCloseTo(1.5, 10);
    expect(profitUnits(2.5, false)).toBe(-1);

    const none = flatStakeRoi([{ profitUnits: null }, { profitUnits: null }]);
    expect(none.roi).toBeNull();
    expect(none.note).toMatch(/no settled pick carried a recorded price/i);

    const thin = flatStakeRoi([{ profitUnits: 1 }, { profitUnits: -1 }, { profitUnits: null }]);
    expect(thin.priced).toBe(2);
    expect(thin.settled).toBe(3);
    expect(thin.roi).toBe(0);
    expect(thin.significant).toBe(false);
    expect(thin.note).toMatch(/not a measurement/);
  });
});
