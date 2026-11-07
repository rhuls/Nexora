import type { DataEnvironment, ModelVersion, Prisma, PrismaClient } from '@prisma/client';
import { FEATURE_GROUPS, normalizeWeights, type FeatureGroup, type FeatureWeights } from '../models/types.js';
import { NotFoundError } from '../utils/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface WeightChange {
  feature: FeatureGroup;
  from: number;
  to: number;
  reason: string;
  confidence: number;
}

export class ModelRegistry {
  constructor(private readonly db: Db) {}

  async baseline(): Promise<ModelVersion> {
    const baseline = await this.db.modelVersion.findFirst({ where: { dataEnvironment: null, parentVersionId: null }, orderBy: { createdAt: 'asc' } });
    if (!baseline) throw new Error('No baseline model version exists (run the seed)');
    return baseline;
  }

  async byVersion(version: string): Promise<ModelVersion> {
    const row = await this.db.modelVersion.findUnique({ where: { version } });
    if (!row) throw new NotFoundError('Model version', version);
    return row;
  }

  async weightsOf(modelVersionId: string): Promise<FeatureWeights> {
    const rows = await this.db.featureWeight.findMany({ where: { modelVersionId } });
    return normalizeWeights(Object.fromEntries(rows.map((r) => [r.feature, r.weight])));
  }

  // The version used for new analyses in an environment: its own ACTIVE version, else the baseline.
  // LIVE only uses HISTORICAL learning after an explicit, audited adoptForLive().
  async activeFor(env: DataEnvironment): Promise<ModelVersion> {
    return (await this.db.modelVersion.findFirst({ where: { dataEnvironment: env, status: 'ACTIVE' } })) ?? this.baseline();
  }

  // Walks back through parents until the version's training data ends before the forecast cutoff.
  // Never crosses into another environment (e.g. from a LIVE adoption back to its HISTORICAL source): falls back to the baseline.
  async usableFrom(version: ModelVersion, asOf: Date): Promise<ModelVersion> {
    let current: ModelVersion | null = version;
    while (current && current.trainingWindowEnd && current.trainingWindowEnd.getTime() >= asOf.getTime()) {
      const parent: ModelVersion | null = current.parentVersionId ? await this.db.modelVersion.findUnique({ where: { id: current.parentVersionId } }) : null;
      current = parent && (parent.dataEnvironment === null || parent.dataEnvironment === version.dataEnvironment) ? parent : null;
    }
    return current ?? this.baseline();
  }

  async usableFor(env: DataEnvironment, asOf: Date): Promise<ModelVersion> {
    return this.usableFrom(await this.activeFor(env), asOf);
  }

  async nextVersionName(): Promise<string> {
    const rows = await this.db.modelVersion.findMany({ select: { version: true } });
    const minors = rows.map((r) => /^v1\.(\d+)$/.exec(r.version)?.[1]).filter((m): m is string => m !== undefined).map(Number);
    return `v1.${Math.max(0, ...minors) + 1}`;
  }

  async createCandidate(input: {
    parent: ModelVersion;
    dataEnvironment: DataEnvironment;
    weights: FeatureWeights;
    changes: WeightChange[];
    trainingWindowStart: Date;
    trainingWindowEnd: Date;
    trainingSamples: number;
    simulationRunId?: string | null;
    notes: string;
  }): Promise<ModelVersion> {
    const parentWeights = await this.weightsOf(input.parent.id);
    const weights = normalizeWeights(input.weights);
    const changed = new Map(input.changes.map((c) => [c.feature, c]));
    const version = await this.db.modelVersion.create({
      data: {
        version: await this.nextVersionName(),
        status: 'EXPERIMENTAL',
        dataEnvironment: input.dataEnvironment,
        parentVersionId: input.parent.id,
        trainingWindowStart: input.trainingWindowStart,
        trainingWindowEnd: input.trainingWindowEnd,
        matchesEvaluated: input.trainingSamples,
        simulationRunId: input.simulationRunId ?? null,
        notes: input.notes,
        featureWeights: {
          create: FEATURE_GROUPS.map((feature) => ({
            feature,
            weight: weights[feature],
            previousWeight: parentWeights[feature],
            reason: changed.get(feature)?.reason ?? `Renormalised after other changes (unchanged ratio from ${input.parent.version}).`,
            confidence: changed.get(feature)?.confidence ?? null,
          })),
        },
      },
    });
    for (const c of input.changes) {
      await this.db.learningEvent.create({
        data: {
          type: 'WEIGHT_ADJUSTMENT_PROPOSED',
          dataEnvironment: input.dataEnvironment,
          fromVersionId: input.parent.id,
          toVersionId: version.id,
          feature: c.feature,
          previousWeight: c.from,
          proposedWeight: c.to,
          reason: c.reason,
          confidence: c.confidence,
        },
      });
    }
    return version;
  }

  async promote(candidate: ModelVersion, reason: string, evidence: Prisma.InputJsonValue): Promise<void> {
    if (!candidate.dataEnvironment) throw new Error('The baseline cannot be promoted');
    const now = new Date();
    const current = await this.db.modelVersion.findFirst({ where: { dataEnvironment: candidate.dataEnvironment, status: 'ACTIVE' } });
    if (current) await this.db.modelVersion.update({ where: { id: current.id }, data: { status: 'RETIRED', retiredAt: now } });
    await this.db.modelVersion.update({ where: { id: candidate.id }, data: { status: 'ACTIVE', activatedAt: now } });
    await this.db.learningEvent.create({
      data: { type: 'VERSION_PROMOTED', dataEnvironment: candidate.dataEnvironment, fromVersionId: candidate.parentVersionId, toVersionId: candidate.id, reason, evidence },
    });
  }

  async reject(candidate: ModelVersion, reason: string, evidence: Prisma.InputJsonValue): Promise<void> {
    await this.db.modelVersion.update({ where: { id: candidate.id }, data: { status: 'RETIRED', retiredAt: new Date() } });
    await this.db.learningEvent.create({
      data: { type: 'VERSION_REJECTED', dataEnvironment: candidate.dataEnvironment!, fromVersionId: candidate.parentVersionId, toVersionId: candidate.id, reason, evidence },
    });
  }

  // Reverts an environment to the previous version in its lineage (or to the baseline). Nothing is deleted.
  async rollback(env: DataEnvironment, reason: string): Promise<{ from: ModelVersion; to: ModelVersion }> {
    const current = await this.db.modelVersion.findFirst({ where: { dataEnvironment: env, status: 'ACTIVE' } });
    if (!current) throw new RollbackError(`No learned version is active for ${env}; it already uses the baseline`);
    const now = new Date();
    await this.db.modelVersion.update({ where: { id: current.id }, data: { status: 'RETIRED', retiredAt: now } });
    const parent = current.parentVersionId ? await this.db.modelVersion.findUnique({ where: { id: current.parentVersionId } }) : null;
    let to: ModelVersion;
    if (parent && parent.dataEnvironment === env) to = await this.db.modelVersion.update({ where: { id: parent.id }, data: { status: 'ACTIVE', activatedAt: now, retiredAt: null } });
    else to = await this.baseline();
    await this.db.learningEvent.create({ data: { type: 'ROLLBACK', dataEnvironment: env, fromVersionId: current.id, toVersionId: to.id, reason } });
    return { from: current, to };
  }

  async supersedeActive(env: DataEnvironment, reason: string): Promise<void> {
    const current = await this.db.modelVersion.findFirst({ where: { dataEnvironment: env, status: 'ACTIVE' } });
    if (!current) return;
    await this.db.modelVersion.update({ where: { id: current.id }, data: { status: 'RETIRED', retiredAt: new Date() } });
    await this.db.learningEvent.create({ data: { type: 'ROLLBACK', dataEnvironment: env, fromVersionId: current.id, toVersionId: (await this.baseline()).id, reason } });
  }

  // Makes a version validated on HISTORICAL backtests the active model for LIVE forecasts, as a new version with its own lineage entry.
  async adoptForLive(source: ModelVersion): Promise<ModelVersion> {
    if (source.dataEnvironment !== 'HISTORICAL') throw new RollbackError('Only versions learned from HISTORICAL real data can be adopted for LIVE forecasts');
    const weights = await this.weightsOf(source.id);
    const now = new Date();
    const current = await this.db.modelVersion.findFirst({ where: { dataEnvironment: 'LIVE', status: 'ACTIVE' } });
    if (current) await this.db.modelVersion.update({ where: { id: current.id }, data: { status: 'RETIRED', retiredAt: now } });
    const adopted = await this.db.modelVersion.create({
      data: {
        version: await this.nextVersionName(),
        status: 'ACTIVE',
        dataEnvironment: 'LIVE',
        parentVersionId: source.id,
        trainingWindowStart: source.trainingWindowStart,
        trainingWindowEnd: source.trainingWindowEnd,
        matchesEvaluated: source.matchesEvaluated,
        activatedAt: now,
        notes: `Adopted for LIVE forecasts from HISTORICAL version ${source.version}.`,
        featureWeights: { create: FEATURE_GROUPS.map((feature) => ({ feature, weight: weights[feature], previousWeight: weights[feature], reason: `Copied unchanged from ${source.version}.` })) },
      },
    });
    await this.db.learningEvent.create({
      data: { type: 'VERSION_PROMOTED', dataEnvironment: 'LIVE', fromVersionId: current?.id ?? source.id, toVersionId: adopted.id, reason: `Adopted ${source.version} (validated walk-forward on HISTORICAL data) for LIVE forecasts as ${adopted.version}.` },
    });
    return adopted;
  }
}

export class RollbackError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'RollbackError';
  }
}
