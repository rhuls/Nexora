import type { FeatureName, MatchFeatureVector } from '../features/feature-engineering.service.js';
import { RatingDifferentialModel } from './data-analysis.model.js';
import { PoissonBlendModel } from './mathematical.model.js';
import { DixonColesModel, EloCalibratedModel } from './rating.models.js';
import { ModelOutputSchema, type IDataAnalysisModel, type IMathematicalModel, type ModelContext, type ModelOutput } from './types.js';

export type AdapterResult = { ok: true; output: ModelOutput } | { ok: false; model: string; error: string };

// Features only an enrichment provider (match statistics, player data, availability) can populate. Until Step 3B
// validates them walk-forward, they must not move real-data result or goal forecasts; corners/cards/shots may use them.
export const ENRICHMENT_ONLY_FEATURES: readonly FeatureName[] = [
  'shotsHomeAverage', 'shotsAwayAverage', 'shotsOnTargetHomeAverage', 'shotsOnTargetAwayAverage',
  'cornersHomeAverage', 'cornersAwayAverage', 'possessionHomeAverage', 'possessionAwayAverage',
  'cardsHomeAverage', 'cardsAwayAverage',
  'availabilityHomeImpact', 'availabilityAwayImpact', 'availabilityHomeAttacking', 'availabilityAwayAttacking',
  'availabilityHomeDefensive', 'availabilityAwayDefensive',
  'h2hCornersAverage', 'h2hCardsAverage', 'h2hShotsAverage', 'h2hShotsOnTargetAverage',
  'goalsPerShotOnTarget',
];
const RESULT_SIDE_TARGETS = ['MATCH_RESULT', 'GOALS'] as const;

export function withoutEnrichmentFeatures(vector: MatchFeatureVector): MatchFeatureVector {
  const features = { ...vector.features };
  for (const f of ENRICHMENT_ONLY_FEATURES) features[f] = { ...features[f], value: null, sampleSize: 0 };
  return { ...vector, features };
}

// Synthetic data has always carried statistics and keeps its original behaviour; real data gets the guarded split.
async function guarded(vector: MatchFeatureVector, invoke: (v: MatchFeatureVector) => Promise<AdapterResult>): Promise<AdapterResult> {
  if (vector.dataEnvironment === 'SYNTHETIC') return invoke(vector);
  const resultSide = await invoke(withoutEnrichmentFeatures(vector));
  if (!resultSide.ok) return resultSide;
  const full = await invoke(vector);
  if (!full.ok) return resultSide;
  const forecasts: ModelOutput['forecasts'] = { ...full.output.forecasts };
  for (const t of RESULT_SIDE_TARGETS) {
    if (resultSide.output.forecasts[t] === undefined) delete forecasts[t];
    else forecasts[t] = resultSide.output.forecasts[t] as never;
  }
  return { ok: true, output: { ...resultSide.output, forecasts } };
}

// Adapters isolate the engine from model implementations: outputs are validated and failures are contained.
abstract class ValidatingAdapter {
  protected validate(model: string, kind: ModelOutput['modelKind'], raw: unknown): AdapterResult {
    const parsed = ModelOutputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, model, error: `Invalid output: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    if (parsed.data.modelKind !== kind) return { ok: false, model, error: `Expected a ${kind} model output, received ${parsed.data.modelKind}` };
    return { ok: true, output: parsed.data };
  }
}

export class MathematicalModelAdapter extends ValidatingAdapter {
  constructor(readonly model: IMathematicalModel) {
    super();
  }

  async run(features: MatchFeatureVector, context: ModelContext): Promise<AdapterResult> {
    return guarded(features, (v) => this.invoke(v, context));
  }

  private async invoke(features: MatchFeatureVector, context: ModelContext): Promise<AdapterResult> {
    try {
      return this.validate(this.model.id, 'MATHEMATICAL', await this.model.calculate(features, context));
    } catch (error) {
      return { ok: false, model: this.model.id, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export class DataAnalysisModelAdapter extends ValidatingAdapter {
  constructor(readonly model: IDataAnalysisModel) {
    super();
  }

  async run(features: MatchFeatureVector, context: ModelContext): Promise<AdapterResult> {
    return guarded(features, (v) => this.invoke(v, context));
  }

  private async invoke(features: MatchFeatureVector, context: ModelContext): Promise<AdapterResult> {
    try {
      return this.validate(this.model.id, 'DATA_ANALYSIS', await this.model.analyze(features, context));
    } catch (error) {
      return { ok: false, model: this.model.id, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export interface ModelAdapters {
  mathematical: MathematicalModelAdapter;
  dataAnalysis: DataAnalysisModelAdapter;
}

// legacy: form-window Poisson blend + rating differential. ratings: Dixon-Coles + calibrated Elo (wrapping legacy).
export type ModelSet = 'legacy' | 'ratings';
// 'ratings' became the default after a read-only walk-forward comparison on 1,105 EPL matches (npm run compare:models).
export const DEFAULT_MODEL_SET: ModelSet = 'ratings';

// Swap the mock implementations for the real models here; nothing else in Nexora needs to change.
export function createModelAdapters(set: ModelSet = DEFAULT_MODEL_SET): ModelAdapters {
  if (set === 'ratings') return { mathematical: new MathematicalModelAdapter(new DixonColesModel()), dataAnalysis: new DataAnalysisModelAdapter(new EloCalibratedModel()) };
  return { mathematical: new MathematicalModelAdapter(new PoissonBlendModel()), dataAnalysis: new DataAnalysisModelAdapter(new RatingDifferentialModel()) };
}
