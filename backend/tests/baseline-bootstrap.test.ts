import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { INITIAL_FEATURE_WEIGHTS, INITIAL_MODEL_VERSION } from '../src/data/synthetic/reference.js';
import { ensureBaselineModel } from '../src/learning/baseline.js';
import { ModelRegistry } from '../src/learning/model-registry.js';

// A database with no baseline cannot be reproduced against the real schema, because the triggers
// that make model lineage immutable refuse to delete one. So the absent case is exercised through
// the only two calls the registry makes.
function stubDb(
  existing: unknown,
  opts: { upsertFails?: unknown; findUniqueReturns?: unknown } = {},
): { db: Prisma.TransactionClient; upserts: unknown[] } {
  const upserts: unknown[] = [];
  const db = {
    modelVersion: {
      findFirst: async () => existing,
      findUnique: async () => opts.findUniqueReturns ?? null,
      upsert: async (args: { create: Record<string, unknown> }) => {
        upserts.push(args);
        if (opts.upsertFails) throw opts.upsertFails;
        return { id: args.create.id, version: args.create.version, dataEnvironment: null, parentVersionId: null };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { db, upserts };
}

// What Prisma throws when another process inserted the same id a moment earlier.
const uniqueViolation = Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), {
  code: 'P2002',
  meta: { modelName: 'ModelVersion', target: ['id'] },
});

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

  // Seen in production: three cold starts bootstrapped at once, two inserted and the third lost.
  it('returns the winner\u2019s row when another process created the baseline first', async () => {
    const winner = { id: INITIAL_MODEL_VERSION.id, version: INITIAL_MODEL_VERSION.version, dataEnvironment: null, parentVersionId: null };
    const { db } = stubDb(null, { upsertFails: uniqueViolation, findUniqueReturns: winner });

    const baseline = await new ModelRegistry(db).baseline();

    expect(baseline).toBe(winner);
  });

  it('still reports a unique violation it cannot explain, rather than inventing a baseline', async () => {
    // A transaction that Postgres aborted cannot read the row back; failing loudly is correct.
    const { db } = stubDb(null, { upsertFails: uniqueViolation, findUniqueReturns: null });

    await expect(new ModelRegistry(db).baseline()).rejects.toThrow('Unique constraint failed');
  });

  it('does not swallow errors that are not unique violations', async () => {
    const { db } = stubDb(null, { upsertFails: new Error('connection refused') });

    await expect(ensureBaselineModel(db)).rejects.toThrow('connection refused');
  });
});
