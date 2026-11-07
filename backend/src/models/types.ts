import { z } from 'zod';
import type { MatchFeatureVector } from '../features/feature-engineering.service.js';

export const FEATURE_GROUPS = ['recentForm', 'shotsOnTarget', 'goals', 'availability', 'homeAway', 'h2h', 'corners', 'discipline'] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];
export type FeatureWeights = Record<FeatureGroup, number>;

export const NUMERIC_TARGETS = ['GOALS', 'CORNERS', 'CARDS', 'SHOTS', 'SHOTS_ON_TARGET'] as const;
export type NumericTarget = (typeof NUMERIC_TARGETS)[number];

export const ResultProbabilitiesSchema = z
  .object({ home: z.number().min(0).max(1), draw: z.number().min(0).max(1), away: z.number().min(0).max(1) })
  .refine((p) => Math.abs(p.home + p.draw + p.away - 1) < 1e-6, { message: 'Result probabilities must sum to 1' });

export type ResultProbabilities = z.infer<typeof ResultProbabilitiesSchema>;

const nonNegative = z.number().finite().min(0);

export const ModelOutputSchema = z.object({
  model: z.string().min(1),
  modelKind: z.enum(['MATHEMATICAL', 'DATA_ANALYSIS']),
  implementationVersion: z.string().min(1),
  forecasts: z.object({
    MATCH_RESULT: ResultProbabilitiesSchema.optional(),
    GOALS: nonNegative.optional(),
    CORNERS: nonNegative.optional(),
    CARDS: nonNegative.optional(),
    SHOTS: nonNegative.optional(),
    SHOTS_ON_TARGET: nonNegative.optional(),
  }),
  // Named intermediate quantities (e.g. expected home goals) so every forecast can be explained.
  components: z.record(z.string(), z.number().finite()),
  notes: z.array(z.string()),
});

export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export interface ModelContext {
  weights: FeatureWeights;
  modelVersion: string;
}

// Your mathematics model plugs in here. It must be a pure function of the features it is given.
export interface IMathematicalModel {
  readonly id: string;
  readonly implementationVersion: string;
  calculate(features: MatchFeatureVector, context: ModelContext): ModelOutput | Promise<ModelOutput>;
}

// Your data-analysis model plugs in here, independently of the mathematical model.
export interface IDataAnalysisModel {
  readonly id: string;
  readonly implementationVersion: string;
  analyze(features: MatchFeatureVector, context: ModelContext): ModelOutput | Promise<ModelOutput>;
}

export function normalizeWeights(weights: Partial<Record<string, number>>): FeatureWeights {
  const raw = Object.fromEntries(FEATURE_GROUPS.map((g) => [g, Math.max(0, weights[g] ?? 0)])) as FeatureWeights;
  const total = FEATURE_GROUPS.reduce((s, g) => s + raw[g], 0);
  if (total <= 0) throw new Error('Feature weights must have a positive total');
  return Object.fromEntries(FEATURE_GROUPS.map((g) => [g, Math.round((raw[g] / total) * 1e6) / 1e6])) as FeatureWeights;
}
