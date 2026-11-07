import { ensemble } from '../analysis/engine.js';
import { brier, type ResultLabel } from '../evaluation/metrics.js';
import type { MatchFeatureVector } from '../features/feature-engineering.service.js';
import type { ModelAdapters } from '../models/adapters.js';
import { FEATURE_GROUPS, NUMERIC_TARGETS, normalizeWeights, type FeatureGroup, type FeatureWeights, type NumericTarget } from '../models/types.js';

export const GUARDRAILS = {
  minTrainingSamples: 50,
  minValidationSamples: 50,
  maxTrainingSamples: 400,
  minTrainingImprovement: 0.005,
  minValidationImprovement: 0.01,
  maxTargetDegradation: 0.03,
  minPairedZ: 1.28,
  weightBounds: [0.01, 0.6] as const,
  stepMultipliers: [0.7, 1.4] as const,
  maxChangesPerProposal: 2,
} as const;

export type Target = 'MATCH_RESULT' | NumericTarget;

export interface LearningSample {
  matchId: string;
  cutoff: Date;
  resultKnownAt: Date;
  vector: MatchFeatureVector;
  actual: { result: ResultLabel | null; numeric: Partial<Record<NumericTarget, number>> };
}

type SampleLosses = Partial<Record<Target, number>>;

export interface WeightEvaluation {
  perSample: SampleLosses[];
  meanLoss: Partial<Record<Target, { loss: number; n: number }>>;
}

export interface LearningSignal {
  feature: FeatureGroup;
  weight: number;
  // Relative change in composite loss when this feature's weight is halved; positive means the feature was useful.
  usefulness: number;
}

export interface Proposal {
  status: 'PROPOSED' | 'NO_IMPROVEMENT' | 'INSUFFICIENT_DATA';
  reason: string;
  weights: FeatureWeights;
  changes: Array<{ feature: FeatureGroup; from: number; to: number; relativeImprovement: number }>;
  trainingImprovement: number;
  signals: LearningSignal[];
  samples: number;
}

export interface ValidationDecision {
  decision: 'PROMOTE' | 'REJECT' | 'INSUFFICIENT_DATA';
  reason: string;
  samples: number;
  compositeImprovement: number;
  pairedZ: number;
  perTarget: Partial<Record<Target, { current: number; candidate: number; change: number; n: number }>>;
}

const r = (v: number, p = 4) => Math.round(v * 10 ** p) / 10 ** p;

export class LearningEngine {
  constructor(private readonly adapters: ModelAdapters) {}

  async evaluateWeights(weights: FeatureWeights, samples: LearningSample[]): Promise<WeightEvaluation> {
    const perSample: SampleLosses[] = [];
    for (const s of samples) {
      const context = { weights, modelVersion: 'offline-evaluation' };
      const results = await Promise.all([this.adapters.mathematical.run(s.vector, context), this.adapters.dataAnalysis.run(s.vector, context)]);
      const combined = ensemble(results.flatMap((x) => (x.ok ? [x.output] : [])));
      const losses: SampleLosses = {};
      if (combined.MATCH_RESULT && s.actual.result) losses.MATCH_RESULT = brier(combined.MATCH_RESULT, s.actual.result);
      for (const t of NUMERIC_TARGETS) {
        const f = combined.numeric[t];
        const a = s.actual.numeric[t];
        if (f && a !== undefined) losses[t] = Math.abs(f.value - a);
      }
      perSample.push(losses);
    }
    const meanLoss: WeightEvaluation['meanLoss'] = {};
    for (const t of ['MATCH_RESULT', ...NUMERIC_TARGETS] as Target[]) {
      const values = perSample.map((l) => l[t]).filter((v): v is number => v !== undefined);
      if (values.length > 0) meanLoss[t] = { loss: values.reduce((a, b) => a + b, 0) / values.length, n: values.length };
    }
    return { perSample, meanLoss };
  }

  // Mean over targets of loss relative to a reference; 1.0 = same as reference, lower is better.
  static composite(candidate: WeightEvaluation, reference: WeightEvaluation): number {
    const ratios = (Object.keys(reference.meanLoss) as Target[])
      .filter((t) => candidate.meanLoss[t] && reference.meanLoss[t]!.loss > 0)
      .map((t) => candidate.meanLoss[t]!.loss / reference.meanLoss[t]!.loss);
    return ratios.length === 0 ? 1 : ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }

  static perSampleComposite(e: WeightEvaluation, reference: WeightEvaluation): number[] {
    return e.perSample.map((losses) => {
      const parts = (Object.keys(losses) as Target[]).filter((t) => reference.meanLoss[t] && reference.meanLoss[t]!.loss > 0).map((t) => losses[t]! / reference.meanLoss[t]!.loss);
      return parts.length === 0 ? 0 : parts.reduce((a, b) => a + b, 0) / parts.length;
    });
  }

  private adjust(weights: FeatureWeights, feature: FeatureGroup, multiplier: number): FeatureWeights {
    const [lo, hi] = GUARDRAILS.weightBounds;
    return normalizeWeights({ ...weights, [feature]: Math.min(hi, Math.max(lo, weights[feature] * multiplier)) });
  }

  async signals(weights: FeatureWeights, samples: LearningSample[], reference?: WeightEvaluation): Promise<LearningSignal[]> {
    const ref = reference ?? (await this.evaluateWeights(weights, samples));
    const out: LearningSignal[] = [];
    for (const feature of FEATURE_GROUPS) {
      const ablated = await this.evaluateWeights(this.adjust(weights, feature, 0.5), samples);
      out.push({ feature, weight: weights[feature], usefulness: r(LearningEngine.composite(ablated, ref) - 1, 5) });
    }
    return out.sort((a, b) => b.usefulness - a.usefulness);
  }

  // Proposes at most a few bounded weight changes that lower loss on past, already-evaluated forecasts.
  async propose(current: FeatureWeights, history: LearningSample[]): Promise<Proposal> {
    const samples = history.slice(-GUARDRAILS.maxTrainingSamples);
    if (samples.length < GUARDRAILS.minTrainingSamples) {
      return { status: 'INSUFFICIENT_DATA', reason: `Only ${samples.length} evaluated matches; learning requires at least ${GUARDRAILS.minTrainingSamples}.`, weights: current, changes: [], trainingImprovement: 0, signals: [], samples: samples.length };
    }
    const reference = await this.evaluateWeights(current, samples);
    const signals = await this.signals(current, samples, reference);

    let weights = current;
    let currentComposite = 1;
    const changes: Proposal['changes'] = [];
    for (let step = 0; step < GUARDRAILS.maxChangesPerProposal; step += 1) {
      let best: { feature: FeatureGroup; weights: FeatureWeights; composite: number } | null = null;
      for (const feature of FEATURE_GROUPS) {
        if (changes.some((c) => c.feature === feature)) continue;
        for (const m of GUARDRAILS.stepMultipliers) {
          const trial = this.adjust(weights, feature, m);
          if (trial[feature] === weights[feature]) continue;
          const composite = LearningEngine.composite(await this.evaluateWeights(trial, samples), reference);
          if (!best || composite < best.composite) best = { feature, weights: trial, composite };
        }
      }
      if (!best || currentComposite - best.composite < GUARDRAILS.minTrainingImprovement) break;
      changes.push({ feature: best.feature, from: weights[best.feature], to: best.weights[best.feature], relativeImprovement: r(currentComposite - best.composite, 5) });
      weights = best.weights;
      currentComposite = best.composite;
    }

    const improvement = r(1 - currentComposite, 5);
    if (changes.length === 0) {
      return { status: 'NO_IMPROVEMENT', reason: `No bounded weight change improved training loss by at least ${GUARDRAILS.minTrainingImprovement * 100}% over ${samples.length} matches.`, weights: current, changes, trainingImprovement: 0, signals, samples: samples.length };
    }
    return { status: 'PROPOSED', reason: `${changes.length} weight change(s) reduced composite training loss by ${r(improvement * 100, 2)}% over ${samples.length} matches.`, weights, changes, trainingImprovement: improvement, signals, samples: samples.length };
  }

  // Out-of-sample check on matches the candidate never trained on. Small or noisy gains are rejected.
  async validate(current: FeatureWeights, candidate: FeatureWeights, holdout: LearningSample[]): Promise<ValidationDecision> {
    if (holdout.length < GUARDRAILS.minValidationSamples) {
      return { decision: 'INSUFFICIENT_DATA', reason: `Holdout has ${holdout.length} matches; ${GUARDRAILS.minValidationSamples} are required.`, samples: holdout.length, compositeImprovement: 0, pairedZ: 0, perTarget: {} };
    }
    const cur = await this.evaluateWeights(current, holdout);
    const cand = await this.evaluateWeights(candidate, holdout);
    const improvement = 1 - LearningEngine.composite(cand, cur);
    const a = LearningEngine.perSampleComposite(cur, cur);
    const b = LearningEngine.perSampleComposite(cand, cur);
    const d = a.map((x, i) => x - b[i]!);
    const mean = d.reduce((s, x) => s + x, 0) / d.length;
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, d.length - 1));
    const z = sd === 0 ? (mean > 0 ? Infinity : 0) : mean / (sd / Math.sqrt(d.length));

    const perTarget: ValidationDecision['perTarget'] = {};
    let worst = 0;
    for (const t of Object.keys(cur.meanLoss) as Target[]) {
      const c = cur.meanLoss[t]!;
      const k = cand.meanLoss[t];
      if (!k) continue;
      const change = c.loss === 0 ? 0 : (k.loss - c.loss) / c.loss;
      worst = Math.max(worst, change);
      perTarget[t] = { current: r(c.loss), candidate: r(k.loss), change: r(change), n: c.n };
    }
    const base = { samples: holdout.length, compositeImprovement: r(improvement, 5), pairedZ: Number.isFinite(z) ? r(z, 3) : 99, perTarget };
    if (improvement < GUARDRAILS.minValidationImprovement) return { decision: 'REJECT', reason: `Holdout improvement ${r(improvement * 100, 2)}% is below the ${GUARDRAILS.minValidationImprovement * 100}% required.`, ...base };
    if (z < GUARDRAILS.minPairedZ) return { decision: 'REJECT', reason: `Improvement is not statistically meaningful (paired z = ${r(z, 2)} < ${GUARDRAILS.minPairedZ}).`, ...base };
    if (worst > GUARDRAILS.maxTargetDegradation) return { decision: 'REJECT', reason: `A target degraded by ${r(worst * 100, 2)}% (limit ${GUARDRAILS.maxTargetDegradation * 100}%).`, ...base };
    return { decision: 'PROMOTE', reason: `Holdout loss improved by ${r(improvement * 100, 2)}% (paired z = ${r(z, 2)}) over ${holdout.length} unseen matches with no target degrading more than ${GUARDRAILS.maxTargetDegradation * 100}%.`, ...base };
  }
}

export function describeChange(c: Proposal['changes'][number], samples: LearningSample[]): string {
  const first = samples[0]?.cutoff.toISOString().slice(0, 10);
  const last = samples.at(-1)?.cutoff.toISOString().slice(0, 10);
  return `${c.feature} ${r(c.from, 3)} → ${r(c.to, 3)}: lowered composite training loss by ${r(c.relativeImprovement * 100, 2)}% over ${samples.length} evaluated matches (${first} → ${last}).`;
}
