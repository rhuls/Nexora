import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

const FINISHED_MATCH = 'm_2025_26_r01_dun_car';
const SCHEDULED_MATCH = 'm_2026_27_r05_dun_car';
const BASELINE = 'mv_1_0';

class Rollback extends Error {}

// Runs fn in a transaction that is always rolled back, so tests never change the database.
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

async function matchDate(id: string): Promise<Date> {
  const m = await prisma.match.findUniqueOrThrow({ where: { id }, select: { matchDate: true } });
  return m.matchDate;
}

const snapshot = (overrides: Partial<Prisma.FeatureSnapshotUncheckedCreateInput> & { asOf: Date }): Prisma.FeatureSnapshotUncheckedCreateInput => ({
  matchId: FINISHED_MATCH,
  dataEnvironment: 'SYNTHETIC',
  featureSetVersion: 'test',
  features: {},
  dataQuality: {},
  ...overrides,
});

beforeAll(async () => {
  const found = await prisma.match.count({ where: { id: { in: [FINISHED_MATCH, SCHEDULED_MATCH] } } });
  if (found !== 2) throw new Error('Integration tests need the seeded database (npm run db:seed)');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('migration backfill', () => {
  it('labels every pre-existing row as synthetic seed data', async () => {
    const seedLeague = { competition: { code: 'NDL' } };
    const [nonSeedMatches, nonSyntheticMatches, nonSeedTeams, nonSeedStats] = await Promise.all([
      prisma.match.count({ where: { ...seedLeague, source: { not: 'nexora-seed' } } }),
      prisma.match.count({ where: { ...seedLeague, dataEnvironment: { not: 'SYNTHETIC' } } }),
      prisma.team.count({ where: { competition: { code: 'NDL' }, source: { not: 'nexora-seed' } } }),
      prisma.matchTeamStats.count({ where: { match: { competition: { code: 'NDL' } }, source: { not: 'nexora-seed' } } }),
    ]);
    expect(nonSeedMatches).toBe(0);
    expect(nonSyntheticMatches).toBe(0);
    expect(nonSeedTeams).toBe(0);
    expect(nonSeedStats).toBe(0);
  });

  it('keeps team statistics and player minutes through the renames', async () => {
    expect(await prisma.matchTeamStats.count()).toBeGreaterThan(0);
    expect(await prisma.playerMatchStats.count({ where: { minutes: { gt: 0 } } })).toBeGreaterThan(0);
  });

  it('keeps the baseline model unattached to any dataset', async () => {
    const baseline = await prisma.modelVersion.findUniqueOrThrow({ where: { id: BASELINE } });
    expect(baseline.dataEnvironment).toBeNull();
    expect(baseline.status).toBe('ACTIVE');
  });
});

describe('historical results are immutable', () => {
  it('rejects changing a finished score', async () => {
    await inRollback(async (tx) => {
      await expect(tx.match.update({ where: { id: FINISHED_MATCH }, data: { homeScore: 9 } })).rejects.toThrow(/immutable/);
    });
  });

  it('rejects relabelling a finished match to another data environment', async () => {
    await inRollback(async (tx) => {
      await expect(tx.match.update({ where: { id: FINISHED_MATCH }, data: { dataEnvironment: 'HISTORICAL' } })).rejects.toThrow(/immutable/);
    });
  });

  it('allows refreshing non-result metadata such as lastUpdated', async () => {
    await inRollback(async (tx) => {
      await tx.match.update({ where: { id: FINISHED_MATCH }, data: { lastUpdated: new Date() } });
    });
  });

  it('rejects editing feature weights of an existing model version', async () => {
    await inRollback(async (tx) => {
      await expect(tx.featureWeight.updateMany({ where: { modelVersionId: BASELINE, feature: 'h2h' }, data: { weight: 0.9 } })).rejects.toThrow(/immutable/);
    });
  });
});

describe('feature snapshots cannot contain future information', () => {
  it('rejects a cutoff after kick-off', async () => {
    const kickoff = await matchDate(FINISHED_MATCH);
    await inRollback(async (tx) => {
      await expect(tx.featureSnapshot.create({ data: snapshot({ asOf: new Date(kickoff.getTime() + 60_000) }) })).rejects.toThrow(/after kick-off/);
    });
  });

  it('rejects inputs dated at or after the cutoff', async () => {
    const kickoff = await matchDate(FINISHED_MATCH);
    await inRollback(async (tx) => {
      await expect(tx.featureSnapshot.create({ data: snapshot({ asOf: kickoff, latestInputAt: kickoff }) })).rejects.toThrow(/leakage/);
    });
  });

  it('rejects a snapshot labelled with a different data environment than its match', async () => {
    const kickoff = await matchDate(FINISHED_MATCH);
    await inRollback(async (tx) => {
      await expect(tx.featureSnapshot.create({ data: snapshot({ asOf: kickoff, dataEnvironment: 'HISTORICAL' }) })).rejects.toThrow(/does not match/);
    });
  });

  it('accepts a valid snapshot and then forbids changing it', async () => {
    const kickoff = await matchDate(FINISHED_MATCH);
    await inRollback(async (tx) => {
      const created = await tx.featureSnapshot.create({ data: snapshot({ asOf: kickoff, latestInputAt: new Date(kickoff.getTime() - 86_400_000) }) });
      await expect(tx.featureSnapshot.update({ where: { id: created.id }, data: { features: { tampered: true } } })).rejects.toThrow(/immutable/);
    });
  });
});

describe('forecasts and evaluations respect chronology', () => {
  it('rejects a forecast whose cutoff is after kick-off', async () => {
    const kickoff = await matchDate(FINISHED_MATCH);
    const late = new Date(kickoff.getTime() + 60_000);
    await inRollback(async (tx) => {
      await expect(
        tx.analysisRun.create({ data: { matchId: FINISHED_MATCH, modelVersionId: BASELINE, dataEnvironment: 'SYNTHETIC', status: 'RUNNING', asOf: late } }),
      ).rejects.toThrow(/after kick-off/);
    });
  });

  it('rejects evaluating a forecast before the match has finished', async () => {
    const kickoff = await matchDate(SCHEDULED_MATCH);
    await inRollback(async (tx) => {
      const run = await tx.analysisRun.create({
        data: { matchId: SCHEDULED_MATCH, modelVersionId: BASELINE, dataEnvironment: 'SYNTHETIC', status: 'COMPLETED', asOf: kickoff },
      });
      const prediction = await tx.prediction.create({
        data: {
          matchId: SCHEDULED_MATCH, modelVersionId: BASELINE, analysisRunId: run.id, dataEnvironment: 'SYNTHETIC',
          target: 'GOALS', predictedValue: 2.5, confidence: 'LOW', confidenceScore: 0.2, featuresUsed: {}, asOf: kickoff,
        },
      });
      await expect(
        tx.predictionResult.create({ data: { predictionId: prediction.id, actualValue: 2, error: 0.5, absoluteError: 0.5, squaredError: 0.25 } }),
      ).rejects.toThrow(/cannot be evaluated/);
    });
  });
});

describe('data environments never mix in model learning', () => {
  it('requires every learned version to declare its data environment', async () => {
    await inRollback(async (tx) => {
      await expect(tx.modelVersion.create({ data: { version: 'test-null-env', status: 'EXPERIMENTAL', parentVersionId: BASELINE } })).rejects.toThrow(/only the baseline/);
    });
  });

  it('rejects a real-data version derived from a synthetic-data version', async () => {
    await inRollback(async (tx) => {
      const synthetic = await tx.modelVersion.create({ data: { version: 'test-syn', status: 'EXPERIMENTAL', dataEnvironment: 'SYNTHETIC', parentVersionId: BASELINE } });
      await expect(
        tx.modelVersion.create({ data: { version: 'test-hist', status: 'EXPERIMENTAL', dataEnvironment: 'HISTORICAL', parentVersionId: synthetic.id } }),
      ).rejects.toThrow(/cannot produce/);
    });
  });

  it('rejects measuring a synthetic-learned version on historical data', async () => {
    await inRollback(async (tx) => {
      const synthetic = await tx.modelVersion.create({ data: { version: 'test-syn-metric', status: 'EXPERIMENTAL', dataEnvironment: 'SYNTHETIC', parentVersionId: BASELINE } });
      await expect(
        tx.modelMetric.create({
          data: { modelVersionId: synthetic.id, dataEnvironment: 'HISTORICAL', metric: 'MAE', value: 1, sampleSize: 60, windowStart: new Date(0), windowEnd: new Date() },
        }),
      ).rejects.toThrow(/cannot be used or measured/);
    });
  });

  it('allows the baseline to be evaluated in any environment', async () => {
    await inRollback(async (tx) => {
      for (const env of ['SYNTHETIC', 'HISTORICAL', 'LIVE'] as const) {
        await tx.modelMetric.create({
          data: { modelVersionId: BASELINE, dataEnvironment: env, metric: 'MAE', value: 1, sampleSize: 60, windowStart: new Date(0), windowEnd: new Date() },
        });
      }
    });
  });

  it('allows only one ACTIVE version per environment', async () => {
    await inRollback(async (tx) => {
      await tx.modelVersion.create({ data: { version: 'test-active-1', status: 'ACTIVE', dataEnvironment: 'SYNTHETIC', parentVersionId: BASELINE } });
      await expect(
        tx.modelVersion.create({ data: { version: 'test-active-2', status: 'ACTIVE', dataEnvironment: 'SYNTHETIC', parentVersionId: BASELINE } }),
      ).rejects.toThrow(/ModelVersion_one_active_per_environment|Unique constraint/);
    });
  });
});
