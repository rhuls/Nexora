import type { ModelVersion, Prisma, PrismaClient } from '@prisma/client';
import { INITIAL_FEATURE_WEIGHTS, INITIAL_MODEL_VERSION } from '../data/synthetic/reference.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Creates the baseline model version if it is absent, and returns it either way.
 *
 * Every analysis needs a model version, and when an environment has none of its own it falls back
 * to this one. Its weights are constants from the brief rather than anything learned or measured,
 * so there is no judgement in creating it and nothing about a given database that could make a
 * different baseline correct.
 *
 * It used to exist only as a side effect of seeding the synthetic dataset, and the seed returns
 * early on a database that already holds matches. A deployment that imported real fixtures before
 * seeding therefore had no baseline and no way to get one: every analysis failed, and so did the
 * model and performance endpoints.
 *
 * The write is keyed on the fixed id so that callers racing on a cold start converge on one row
 * rather than inserting several.
 */
export async function ensureBaselineModel(db: Db, activatedAt: Date = new Date()): Promise<ModelVersion> {
  return db.modelVersion.upsert({
    where: { id: INITIAL_MODEL_VERSION.id },
    update: {},
    create: {
      id: INITIAL_MODEL_VERSION.id,
      version: INITIAL_MODEL_VERSION.version,
      status: 'ACTIVE',
      // No dataEnvironment: the weights come from the brief, so they belong to no dataset.
      dataEnvironment: null,
      notes: INITIAL_MODEL_VERSION.notes,
      activatedAt,
      featureWeights: {
        create: Object.entries(INITIAL_FEATURE_WEIGHTS).map(([feature, weight]) => ({
          feature,
          weight,
          reason: 'Initial weight from the Nexora MVP brief.',
        })),
      },
    },
  });
}
