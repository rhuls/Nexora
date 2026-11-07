import type { DataEnvironment } from '@prisma/client';
import { DATA_UNAVAILABLE, type DataUnavailable } from '../utils/data-availability.js';

export interface Metric {
  value: number | DataUnavailable;
  // Matches that actually supplied this value; never padded with zeros.
  sampleSize: number;
  window: number;
}

export interface AnalysisMetadata {
  source: 'nexora-knowledge';
  analyzer: string;
  version: string;
  calculationWindow: number;
  sampleSize: number;
  cutoff: string;
  dataEnvironments: DataEnvironment[];
}

export const round = (value: number, places = 3): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export function mean(values: readonly (number | null)[], window: number): Metric {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return { value: DATA_UNAVAILABLE, sampleSize: 0, window };
  return { value: round(known.reduce((a, b) => a + b, 0) / known.length), sampleSize: known.length, window };
}

// Weighted mean over rows whose value is known; weights of missing rows are dropped, not redistributed as zeros.
export function weightedMean(values: readonly (number | null)[], weights: readonly number[], window: number): Metric {
  let sum = 0;
  let totalWeight = 0;
  let n = 0;
  values.forEach((v, i) => {
    if (v === null) return;
    sum += v * weights[i]!;
    totalWeight += weights[i]!;
    n += 1;
  });
  if (n === 0 || totalWeight === 0) return { value: DATA_UNAVAILABLE, sampleSize: 0, window };
  return { value: round(sum / totalWeight), sampleSize: n, window };
}

export function describeGap(label: string, metric: Metric, used: number, subject: string): string | null {
  if (used === 0) return null;
  if (metric.sampleSize === 0) return `${label} unavailable for all ${used} ${subject}.`;
  if (metric.sampleSize < used) return `${label} unavailable for ${used - metric.sampleSize} of ${used} ${subject}.`;
  return null;
}
