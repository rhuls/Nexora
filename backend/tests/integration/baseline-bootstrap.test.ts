import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { INITIAL_MODEL_VERSION } from '../../src/data/synthetic/reference.js';
import { ensureBaselineModel } from '../../src/learning/baseline.js';
import { ModelRegistry } from '../../src/learning/model-registry.js';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('baseline model against the real schema', () => {
  it('is idempotent: calling it on a seeded database creates nothing and changes nothing', async () => {
    const before = await prisma.modelVersion.findMany({ orderBy: { createdAt: 'asc' } });
    const baselineBefore = await new ModelRegistry(prisma).baseline();
    const weightsBefore = await prisma.featureWeight.findMany({ where: { modelVersionId: baselineBefore.id }, orderBy: { feature: 'asc' } });

    // Runs against the live client on purpose: an upsert that is not genuinely a no-op would trip
    // the triggers that make model lineage immutable, and this is where that would show.
    const again = await ensureBaselineModel(prisma);

    expect(again.id).toBe(baselineBefore.id);
    expect(again.version).toBe(INITIAL_MODEL_VERSION.version);
    expect(await prisma.modelVersion.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before);
    expect(await prisma.featureWeight.findMany({ where: { modelVersionId: baselineBefore.id }, orderBy: { feature: 'asc' } })).toEqual(weightsBefore);
  });
});
