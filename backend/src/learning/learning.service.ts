import type { DataEnvironment, ModelVersion, Prisma, PrismaClient } from '@prisma/client';
import { createModelAdapters, type ModelAdapters } from '../models/adapters.js';
import type { FeatureWeights } from '../models/types.js';
import { LearningEngine, describeChange, type LearningSample, type Proposal, type ValidationDecision } from './learning.engine.js';
import { ModelRegistry } from './model-registry.js';
import { samplesFromForecasts, trainingWindow, unseenBy } from './samples.js';

type Db = PrismaClient | Prisma.TransactionClient;

export class LearningService {
  readonly engine: LearningEngine;
  readonly registry: ModelRegistry;

  constructor(
    private readonly db: Db,
    adapters: ModelAdapters = createModelAdapters(),
  ) {
    this.engine = new LearningEngine(adapters);
    this.registry = new ModelRegistry(db);
  }

  async recordSignals(env: DataEnvironment, version: ModelVersion, proposal: Proposal, simulationRunId: string | null): Promise<void> {
    if (proposal.signals.length === 0) return;
    const top = proposal.signals[0]!;
    const bottom = proposal.signals.at(-1)!;
    await this.db.learningEvent.create({
      data: {
        type: 'LEARNING_SIGNAL',
        dataEnvironment: env,
        fromVersionId: version.id,
        reason: `Over ${proposal.samples} evaluated matches, halving ${top.feature} would raise loss most (${(top.usefulness * 100).toFixed(2)}%), and halving ${bottom.feature} would change it least (${(bottom.usefulness * 100).toFixed(2)}%). Associations only.`,
        evidence: { signals: proposal.signals, samples: proposal.samples, simulationRunId } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async createCandidate(env: DataEnvironment, parent: ModelVersion, proposal: Proposal, training: LearningSample[], simulationRunId: string | null) {
    const used = training.slice(-proposal.samples);
    const window = trainingWindow(used);
    return this.registry.createCandidate({
      parent,
      dataEnvironment: env,
      weights: proposal.weights,
      changes: proposal.changes.map((c) => ({ feature: c.feature, from: c.from, to: c.to, reason: describeChange(c, used), confidence: Math.min(1, c.relativeImprovement * 20) })),
      trainingWindowStart: window.start,
      trainingWindowEnd: window.end,
      trainingSamples: used.length,
      simulationRunId,
      notes: proposal.reason,
    });
  }

  async recordValidationMetrics(env: DataEnvironment, current: ModelVersion, candidate: ModelVersion, decision: ValidationDecision, holdout: LearningSample[], simulationRunId: string | null) {
    const windowStart = holdout[0]!.cutoff;
    const windowEnd = holdout.at(-1)!.cutoff;
    const rows: Prisma.ModelMetricCreateManyInput[] = [];
    for (const [target, v] of Object.entries(decision.perTarget)) {
      const metric = target === 'MATCH_RESULT' ? 'HOLDOUT_BRIER' : 'HOLDOUT_MAE';
      for (const [version, value] of [[current, v.current], [candidate, v.candidate]] as const) {
        // The baseline has no environment; it may still be measured on any environment.
        rows.push({ modelVersionId: version.id, dataEnvironment: env, target: target as Prisma.ModelMetricCreateManyInput['target'], segment: `HOLDOUT:${candidate.version}`, metric, value, sampleSize: v.n, windowStart, windowEnd, simulationRunId });
      }
    }
    if (rows.length > 0) await this.db.modelMetric.createMany({ data: rows });
  }

  async decide(env: DataEnvironment, current: ModelVersion, currentWeights: FeatureWeights, candidate: ModelVersion, holdout: LearningSample[], simulationRunId: string | null) {
    const candidateWeights = await this.registry.weightsOf(candidate.id);
    const decision = await this.engine.validate(currentWeights, candidateWeights, holdout);
    if (decision.decision === 'INSUFFICIENT_DATA') return { decision, promoted: false };
    await this.recordValidationMetrics(env, current, candidate, decision, holdout, simulationRunId);
    const evidence = decision as unknown as Prisma.InputJsonValue;
    if (decision.decision === 'PROMOTE') {
      await this.registry.promote(candidate, decision.reason, evidence);
      return { decision, promoted: true };
    }
    await this.registry.reject(candidate, decision.reason, evidence);
    return { decision, promoted: false };
  }

  // On-demand learning from stored, evaluated forecasts: fit on the older part, validate on the newest unseen part.
  async learn(env: DataEnvironment) {
    const active = await this.registry.activeFor(env);
    const activeWeights = await this.registry.weightsOf(active.id);
    // LIVE learns only from forecasts made before kickoff; HISTORICAL may use backtests (they are pre-kickoff by construction).
    const samples = await samplesFromForecasts(this.db, { dataEnvironment: env, simulationRunId: null, ...(env === 'LIVE' ? { isSimulation: false } : {}) });
    const minV = 50;
    if (samples.length < 100) {
      return { status: 'INSUFFICIENT_DATA' as const, reason: `${samples.length} evaluated non-simulation matches for ${env}; at least 100 are needed (50 to learn from, 50 to validate on).`, activeVersion: active.version };
    }
    const training = samples.slice(0, samples.length - minV);
    const proposal = await this.engine.propose(activeWeights, training);
    await this.recordSignals(env, active, proposal, null);
    if (proposal.status !== 'PROPOSED') return { status: proposal.status, reason: proposal.reason, activeVersion: active.version, signals: proposal.signals };
    const candidate = await this.createCandidate(env, active, proposal, training, null);
    const holdout = unseenBy(candidate, samples.slice(samples.length - minV));
    const { decision, promoted } = await this.decide(env, active, activeWeights, candidate, holdout, null);
    return { status: promoted ? ('PROMOTED' as const) : decision.decision === 'INSUFFICIENT_DATA' ? ('PENDING_VALIDATION' as const) : ('REJECTED' as const), reason: decision.reason, activeVersion: promoted ? candidate.version : active.version, candidate: candidate.version, proposal, decision };
  }
}
