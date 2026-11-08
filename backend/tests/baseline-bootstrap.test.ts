import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { INITIAL_FEATURE_WEIGHTS, INITIAL_MODEL_VERSION } from '../src/data/synthetic/reference.js';
import { ensureBaselineModel } from '../src/learning/baseline.js';
import { ModelRegistry } from '../src/learning/model-registry.js';

// A database with no baseline cannot be reproduced against the real schema, because the triggers
// that make model lineage immutable refuse to delete one. So the absent case is exercised through
// the only two calls the registry makes.
function stubDb(existing: unknown): { db: Prisma.TransactionClient; upserts: unknown[] } {
  const upserts: unknown[] = [];
  const db = {
    modelVersion: {
      findFirst: async () => existing,
      upsert: async (args: { create: Record<string, unknown> }) => {
        upserts.push(args);
        return { id: args.create.id, version: args.create.version, dataEnvironment: null, parentVersionId: null };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { db, upserts };
}

describe('baseline model bootstrap', () => {
  it('creates the baseline when none exists, rather than failing the request', async () => {
    const { db, upserts } = stubDb(null);

    const baseline = await new ModelRegistry(db).baseline();

    expect(baseline.version).toBe(INITIAL_MODEL_VERSION.version);
    expect(upserts).toHaveLength(1);
  });

  it('does not touch the database when a baseline is already there', async () => {
    const existing = { id: 'mv_existing', version: 'v9.9', dataEnvironment: null, parentVersionId: null };
    const { db, upserts } = stubDb(existing);

    const baseline = await new ModelRegistry(db).baseline();

    expect(baseline).toBe(existing);
    expect(upserts).toHaveLength(0);
  });

  it('writes the brief’s weights, owned by no data environment, keyed on a fixed id', async () => {
    const { db, upserts } = stubDb(null);

    await ensureBaselineModel(db);

    const args = upserts[0] as { where: { id: string }; update: object; create: Record<string, unknown> };
    // Keyed on the id so that callers racing on a cold start converge on one row.
    expect(args.where.id).toBe(INITIAL_MODEL_VERSION.id);
    // An empty update is what makes a second call leave an existing baseline exactly as it was.
    expect(args.update).toEqual({});
    expect(args.create.dataEnvironment).toBeNull();
    expect(args.create.status).toBe('ACTIVE');

    const weights = (args.create.featureWeights as { create: Array<{ feature: string; weight: number }> }).create;
    expect(Object.fromEntries(weights.map((w) => [w.feature, w.weight]))).toEqual(INITIAL_FEATURE_WEIGHTS);
  });

  it('records when it created the baseline, not a date borrowed from the synthetic seed', async () => {
    const { db, upserts } = stubDb(null);
    const before = Date.now();

    await ensureBaselineModel(db);

    const activatedAt = (upserts[0] as { create: { activatedAt: Date } }).create.activatedAt;
    expect(activatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(activatedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
