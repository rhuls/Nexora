// Scoring probability forecasts, and deciding whether a gap between forecast and outcome is
// evidence of anything.
//
// Nothing here knows about blackjack. These are the measurements a probabilistic forecast is held
// to, kept separate so they can be tested against values worked out by hand rather than against
// whatever this codebase happens to produce.

/** Natural log, floored so a zero probability costs a large finite amount rather than infinity. */
export const LOG_LOSS_EPSILON = 1e-15;

export interface ScoredForecasts {
  n: number;
  /** Multi-class Brier score: mean squared error over the whole probability vector. 0 is perfect, 2 is worst. */
  brier: number;
  /** Mean negative log likelihood of the outcomes that actually happened. */
  logLoss: number;
  /** How many outcomes were assigned a probability small enough to need the floor. */
  clamped: number;
}

/**
 * Scores a set of categorical forecasts against what happened.
 *
 * `forecasts[i]` is a probability vector over the same categories for every i, and `outcomes[i]` is
 * the index that occurred. Both measures are proper scoring rules: each is minimised by reporting
 * one's true beliefs, so neither can be improved by hedging.
 */
export function scoreForecasts(forecasts: readonly (readonly number[])[], outcomes: readonly number[]): ScoredForecasts {
  if (forecasts.length !== outcomes.length) throw new Error('A forecast is needed for every outcome');
  let brierSum = 0;
  let logLossSum = 0;
  let clamped = 0;
  for (let i = 0; i < forecasts.length; i += 1) {
    const f = forecasts[i];
    const actual = outcomes[i];
    if (!Number.isInteger(actual) || actual < 0 || actual >= f.length) throw new Error(`Outcome ${actual} is not a category of forecast ${i}`);
    for (let k = 0; k < f.length; k += 1) {
      const diff = f[k] - (k === actual ? 1 : 0);
      brierSum += diff * diff;
    }
    const p = f[actual];
    if (p < LOG_LOSS_EPSILON) clamped += 1;
    logLossSum -= Math.log(Math.max(p, LOG_LOSS_EPSILON));
  }
  const n = forecasts.length;
  return { n, brier: n === 0 ? 0 : brierSum / n, logLoss: n === 0 ? 0 : logLossSum / n, clamped };
}

// ---- Intervals ----

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion. Preferred over the normal approximation because
 * it stays inside [0, 1] and keeps its coverage when the count is small or the rate is near an end,
 * which is exactly where a reading would otherwise be mistaken for evidence.
 */
export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // At 0 or n successes the bound is exactly 0 or 1, and arithmetic error of a part in 10^16 would
  // otherwise leave it a hair inside. That hair is enough to make a forecast of certainty read as
  // lying outside its own interval, so it is snapped away.
  const snap = (v: number): number => (v < 1e-12 ? 0 : v > 1 - 1e-12 ? 1 : v);
  return { low: snap(Math.max(0, (centre - spread) / denominator)), high: snap(Math.min(1, (centre + spread) / denominator)) };
}

// ---- Distributions ----

/** Abramowitz & Stegun 7.1.26: |error| < 1.5e-7, which is far finer than any sample here resolves. */
function erf(x: number): number {
  const sign = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Regularised lower incomplete gamma P(s, x), by series below the diagonal and continued fraction above. */
function lowerGamma(s: number, x: number): number {
  if (x < 0 || s <= 0) return Number.NaN;
  if (x === 0) return 0;
  const logGammaS = logGamma(s);
  if (x < s + 1) {
    let term = 1 / s;
    let sum = term;
    for (let k = 1; k < 1000; k += 1) {
      term *= x / (s + k);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGammaS);
  }
  // Lentz's algorithm for the continued fraction of the upper incomplete gamma.
  const tiny = 1e-300;
  let b = x + 1 - s;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 - Math.exp(-x + s * Math.log(x) - logGammaS) * h;
}

/** Lanczos approximation. */
function logGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i += 1) a += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** P(X >= statistic) for a chi-square variable with `df` degrees of freedom. */
export function chiSquarePValue(statistic: number, df: number): number {
  if (!(statistic >= 0) || df <= 0) return Number.NaN;
  if (statistic === 0) return 1;
  return 1 - lowerGamma(df / 2, statistic / 2);
}

// ---- Tests ----

export interface GoodnessOfFit {
  statistic: number;
  df: number;
  pValue: number;
  /** Categories whose expected count is too small for the approximation to hold. */
  lowExpectedCategories: number;
  usable: boolean;
}

/**
 * Pearson's chi-square test of whether counts came from the expected distribution.
 *
 * `usable` is false when any expected count is under five, where the statistic no longer follows a
 * chi-square distribution closely enough for its p-value to mean what it says.
 */
export function chiSquareGoodnessOfFit(observed: readonly number[], expected: readonly number[]): GoodnessOfFit {
  if (observed.length !== expected.length) throw new Error('Observed and expected must describe the same categories');
  let statistic = 0;
  let lowExpectedCategories = 0;
  let df = 0;
  for (let i = 0; i < observed.length; i += 1) {
    if (expected[i] <= 0) {
      // A category the model ruled out entirely: it contributes no degree of freedom, but an
      // observation there is a flat contradiction rather than a large statistic.
      if (observed[i] > 0) return { statistic: Number.POSITIVE_INFINITY, df: Math.max(1, observed.length - 1), pValue: 0, lowExpectedCategories, usable: true };
      continue;
    }
    if (expected[i] < 5) lowExpectedCategories += 1;
    const diff = observed[i] - expected[i];
    statistic += (diff * diff) / expected[i];
    df += 1;
  }
  df = Math.max(1, df - 1);
  return { statistic, df, pValue: chiSquarePValue(statistic, df), lowExpectedCategories, usable: lowExpectedCategories === 0 };
}

export interface ProportionTest {
  observed: number;
  expected: number;
  n: number;
  /** Observed rate minus expected rate. Positive means it happened more often than forecast. */
  difference: number;
  z: number;
  pValue: number;
  interval: Interval;
  significant: boolean;
}

/**
 * Tests an observed count against the number of occurrences a known probability predicts.
 *
 * This is the question "did this happen more often than the model said", asked properly: the
 * p-value is two-sided, and the interval is around the observed rate so the size of any gap can be
 * read, not just its presence.
 */
export function proportionTest(successes: number, n: number, expectedRate: number, alpha = 0.05): ProportionTest {
  const interval = wilsonInterval(successes, n);
  if (n <= 0) return { observed: 0, expected: 0, n: 0, difference: 0, z: 0, pValue: 1, interval, significant: false };
  const expected = expectedRate * n;
  const variance = n * expectedRate * (1 - expectedRate);
  // A rate of exactly 0 or 1 leaves no variance to test against; any observation agrees or contradicts outright.
  if (variance <= 0) {
    const contradicted = (expectedRate === 0 && successes > 0) || (expectedRate === 1 && successes < n);
    return { observed: successes, expected, n, difference: successes / n - expectedRate, z: contradicted ? Number.POSITIVE_INFINITY : 0, pValue: contradicted ? 0 : 1, interval, significant: contradicted };
  }
  // Continuity correction: the count is discrete and the normal curve is not.
  const rawDiff = successes - expected;
  const corrected = Math.sign(rawDiff) * Math.max(0, Math.abs(rawDiff) - 0.5);
  const z = corrected / Math.sqrt(variance);
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { observed: successes, expected, n, difference: successes / n - expectedRate, z, pValue, interval, significant: pValue < alpha };
}

// ---- Calibration ----

export interface CalibrationBin {
  lower: number;
  upper: number;
  n: number;
  meanForecast: number;
  observedRate: number;
  interval: Interval;
  /** True when the forecast rate for this bin lies outside the observed interval. */
  outsideInterval: boolean;
}

export interface Calibration {
  bins: CalibrationBin[];
  n: number;
  /** Expected calibration error: the average gap between forecast and outcome, weighted by bin size. */
  ece: number;
  /** The largest gap in any bin holding at least `minBinSize` forecasts. */
  maxGap: number;
  /** Forecast minus observed across everything. Positive means the model is systematically high. */
  bias: number;
}

/**
 * Bins forecasts by the probability they assigned and compares each bin with what happened in it.
 *
 * A model is calibrated when, among the times it said thirty percent, the thing happened about
 * thirty percent of the time. That is a weaker claim than being right, and a different one: it is
 * the claim this engine can actually check.
 */
export function calibrate(pairs: readonly { forecast: number; occurred: boolean }[], binCount = 10, minBinSize = 20): Calibration {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < binCount; b += 1) {
    const lower = b / binCount;
    const upper = (b + 1) / binCount;
    const inBin = pairs.filter((p) => (b === binCount - 1 ? p.forecast >= lower && p.forecast <= upper : p.forecast >= lower && p.forecast < upper));
    const n = inBin.length;
    const successes = inBin.filter((p) => p.occurred).length;
    const meanForecast = n === 0 ? (lower + upper) / 2 : inBin.reduce((sum, p) => sum + p.forecast, 0) / n;
    const observedRate = n === 0 ? 0 : successes / n;
    const interval = wilsonInterval(successes, n);
    bins.push({
      lower,
      upper,
      n,
      meanForecast,
      observedRate,
      interval,
      outsideInterval: n >= minBinSize && (meanForecast < interval.low || meanForecast > interval.high),
    });
  }
  const n = pairs.length;
  const ece = n === 0 ? 0 : bins.reduce((sum, b) => sum + (b.n / n) * Math.abs(b.observedRate - b.meanForecast), 0);
  const maxGap = bins.filter((b) => b.n >= minBinSize).reduce((worst, b) => Math.max(worst, Math.abs(b.observedRate - b.meanForecast)), 0);
  const bias = n === 0 ? 0 : pairs.reduce((sum, p) => sum + p.forecast - (p.occurred ? 1 : 0), 0) / n;
  return { bins, n, ece, maxGap, bias };
}
