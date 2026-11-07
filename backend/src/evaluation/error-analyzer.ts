import type { PredictionTarget } from '@prisma/client';

export const MIN_EVALUATION_SAMPLE = 50;

export type ErrorCategory = 'RANDOM_ERROR' | 'SYSTEMATIC_ERROR' | 'DATA_QUALITY_ERROR' | 'MODEL_ERROR' | 'SAMPLE_SIZE_UNCERTAINTY';

export interface ErrorRow {
  // Signed error (predicted - actual) for numeric targets; 1 - p(actual) for results.
  error: number;
  absoluteError: number;
  predicted: number;
  qualityStatus: 'GOOD' | 'WARNINGS' | null;
  features: Record<string, number | null>;
}

export interface ErrorFinding {
  category: ErrorCategory;
  explanation: string;
  evidence: Record<string, number>;
}

export interface ErrorAnalysis {
  target: PredictionTarget;
  n: number;
  findings: ErrorFinding[];
  featureAssociations: Array<{ feature: string; correlation: number; n: number; note: string }>;
  largeErrors: { count: number; share: number; threshold: number; pattern: 'ISOLATED' | 'RECURRING' };
}

const r = (v: number, p = 3) => Math.round(v * 10 ** p) / 10 ** p;

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// Classifies where error comes from. Findings describe associations in past forecasts; none of them proves a cause.
export function analyzeErrors(target: PredictionTarget, rows: ErrorRow[], calibrationError?: number | null): ErrorAnalysis {
  const n = rows.length;
  const findings: ErrorFinding[] = [];
  const errors = rows.map((x) => x.error);
  const mean = n === 0 ? 0 : errors.reduce((a, b) => a + b, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(errors.reduce((s, e) => s + (e - mean) ** 2, 0) / (n - 1));
  const rmse = n === 0 ? 0 : Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / n);

  if (n < MIN_EVALUATION_SAMPLE) {
    findings.push({ category: 'SAMPLE_SIZE_UNCERTAINTY', explanation: `Only ${n} evaluated forecasts (minimum ${MIN_EVALUATION_SAMPLE}); conclusions are provisional.`, evidence: { n, minimum: MIN_EVALUATION_SAMPLE } });
  }

  if (target !== 'MATCH_RESULT' && n >= 10 && sd > 0) {
    const t = mean / (sd / Math.sqrt(n));
    if (Math.abs(t) >= 2) {
      findings.push({
        category: 'SYSTEMATIC_ERROR',
        explanation: `Forecasts are consistently ${mean > 0 ? 'too high' : 'too low'} by ${r(Math.abs(mean), 2)} on average (t = ${r(t, 2)}), which random noise alone rarely produces.`,
        evidence: { meanError: r(mean), t: r(t, 2), n },
      });
    }
  }

  if (target === 'GOALS' && n >= 10) {
    const meanPredicted = rows.reduce((s, x) => s + x.predicted, 0) / n;
    const mse = rmse * rmse;
    const ratio = meanPredicted > 0 ? mse / meanPredicted : 0;
    if (ratio >= 0.7 && ratio <= 1.3) {
      findings.push({ category: 'RANDOM_ERROR', explanation: `Squared error (${r(mse, 2)}) is close to the variance expected from goal-scoring randomness (${r(meanPredicted, 2)}); most of the error is irreducible noise.`, evidence: { mse: r(mse), expectedVariance: r(meanPredicted), ratio: r(ratio) } });
    } else if (ratio > 1.3) {
      findings.push({ category: 'MODEL_ERROR', explanation: `Squared error is ${r(ratio, 2)}× the variance expected from randomness alone, suggesting the expected-goal levels themselves are off.`, evidence: { mse: r(mse), expectedVariance: r(meanPredicted), ratio: r(ratio) } });
    }
  }
  if (target === 'MATCH_RESULT' && calibrationError !== undefined && calibrationError !== null && n >= 10) {
    if (calibrationError <= 0.05) findings.push({ category: 'RANDOM_ERROR', explanation: `Stated probabilities are well calibrated (ECE ${r(calibrationError)}); remaining misses are consistent with the uncertainty the model reported.`, evidence: { ece: r(calibrationError) } });
    else findings.push({ category: 'MODEL_ERROR', explanation: `Stated probabilities are miscalibrated (ECE ${r(calibrationError)}); confidence does not match observed frequencies.`, evidence: { ece: r(calibrationError) } });
  }

  const good = rows.filter((x) => x.qualityStatus === 'GOOD');
  const warned = rows.filter((x) => x.qualityStatus === 'WARNINGS');
  if (good.length >= 20 && warned.length >= 20) {
    const maeGood = good.reduce((s, x) => s + x.absoluteError, 0) / good.length;
    const maeWarned = warned.reduce((s, x) => s + x.absoluteError, 0) / warned.length;
    if (maeGood > 0 && maeWarned / maeGood >= 1.2) {
      findings.push({ category: 'DATA_QUALITY_ERROR', explanation: `Forecasts made with data-quality warnings have ${r(maeWarned / maeGood, 2)}× the error of those without; gaps in the inputs are associated with worse forecasts.`, evidence: { maeGood: r(maeGood), maeWarnings: r(maeWarned), nGood: good.length, nWarnings: warned.length } });
    }
  } else if (warned.length > 0 && good.length === 0) {
    findings.push({ category: 'DATA_QUALITY_ERROR', explanation: `All ${warned.length} forecasts were made with data-quality warnings, so data gaps cannot be separated from other error sources.`, evidence: { nWarnings: warned.length } });
  }

  const featureNames = [...new Set(rows.flatMap((x) => Object.keys(x.features)))];
  const associations = featureNames
    .map((feature) => {
      const pairs = rows.filter((x) => x.features[feature] !== null && x.features[feature] !== undefined);
      if (pairs.length < 30) return null;
      const c = pearson(pairs.map((x) => x.features[feature]!), pairs.map((x) => x.error));
      return c === null ? null : { feature, correlation: r(c), n: pairs.length };
    })
    .filter((a): a is { feature: string; correlation: number; n: number } => a !== null && Math.abs(a.correlation) >= 0.15)
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
    .slice(0, 5)
    .map((a) => ({ ...a, note: `Higher ${a.feature} is associated with ${a.correlation > 0 ? 'larger positive' : 'more negative'} errors (r = ${a.correlation}, n = ${a.n}); treat as a learning signal, not a cause.` }));

  const threshold = 2 * rmse;
  const large = rows.filter((x) => Math.abs(x.error) > threshold && threshold > 0).length;
  const share = n === 0 ? 0 : large / n;
  return {
    target,
    n,
    findings,
    featureAssociations: associations,
    largeErrors: { count: large, share: r(share), threshold: r(threshold), pattern: share > 0.05 ? 'RECURRING' : 'ISOLATED' },
  };
}
