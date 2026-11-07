import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { informationCutoff } from '../../src/data/knowledge/cutoff.js';
import { DebateService } from '../../src/services/debate.service.js';
import { DebateSettlementService } from '../../src/services/debate-settlement.service.js';

const prisma = new PrismaClient();

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>, timeout = 120_000): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout, maxWait: 20_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

beforeAll(async () => {
  if ((await prisma.match.count({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' } })) < 100) throw new Error('Needs the seeded synthetic league');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the debate layer', () => {
  it('debates a finished match at its pre-kickoff cutoff and stores claims and picks', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED', season: { name: '2025/26' } }, orderBy: { matchDate: 'asc' } });
    await inRollback(async (tx) => {
      const { debateRunId, transcript } = await new DebateService(tx).run(match.id);

      expect(transcript.asOf).toBe(informationCutoff(match).toISOString());
      expect(transcript.verdicts).toHaveLength(3);

      const run = await tx.debateRun.findUniqueOrThrow({ where: { id: debateRunId } });
      expect(run.status).toBe('COMPLETED');
      expect(run.asOf.getTime()).toBeLessThanOrEqual(match.matchDate.getTime());

      const picks = await tx.debatePick.findMany({ where: { debateRunId } });
      expect(picks.map((p) => p.market).sort()).toEqual(['BTTS', 'MATCH_RESULT', 'OVER_UNDER_25']);

      const claims = await tx.debateAgentClaim.findMany({ where: { debateRunId } });
      expect(new Set(claims.map((c) => c.agent))).toEqual(new Set(['SCOUT', 'COPYCAT', 'SKEPTIC', 'BOOKKEEPER']));
    });
  });

  it('writes nothing to the forecast pipeline: no snapshot, analysis run, prediction or learning event', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' }, orderBy: { matchDate: 'desc' } });
    await inRollback(async (tx) => {
      const before = {
        snapshots: await tx.featureSnapshot.count(),
        analysisRuns: await tx.analysisRun.count(),
        predictions: await tx.prediction.count(),
        versions: await tx.modelVersion.count(),
        weights: await tx.featureWeight.count(),
        learning: await tx.learningEvent.count(),
      };
      await new DebateService(tx).run(match.id);
      expect({
        snapshots: await tx.featureSnapshot.count(),
        analysisRuns: await tx.analysisRun.count(),
        predictions: await tx.prediction.count(),
        versions: await tx.modelVersion.count(),
        weights: await tx.featureWeight.count(),
        learning: await tx.learningEvent.count(),
      }).toEqual(before);
    });
  });

  it('vetoes every synthetic verdict as NO_PICK, with no stake', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' }, orderBy: { matchDate: 'asc' } });
    await inRollback(async (tx) => {
      const { transcript } = await new DebateService(tx).run(match.id);
      expect(transcript.verdicts.every((v) => v.recommendation === 'NO_PICK')).toBe(true);
      expect(transcript.verdicts.every((v) => v.stakePct === null)).toBe(true);
      expect(transcript.rounds.three.lastObjections.some((o) => o.code === 'SYNTHETIC_ENV')).toBe(true);
    });
  });

  it('reports no market baseline while no odds provider is configured', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' }, orderBy: { matchDate: 'asc' } });
    await inRollback(async (tx) => {
      const { transcript } = await new DebateService(tx, undefined, false).run(match.id);
      expect(transcript.rounds.one.baseline.status).toBe('NOT_CONFIGURED');
      expect(transcript.verdicts.every((v) => v.edge === null)).toBe(true);
      expect(transcript.rounds.two.objections.some((o) => o.code === 'NO_MARKET_BASELINE')).toBe(true);
    });
  });

  it('uses only odds captured before the cutoff', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' }, orderBy: { matchDate: 'asc' } });
    const cutoff = informationCutoff(match);
    await inRollback(async (tx) => {
      // One price published an hour after the cutoff: it must be invisible to the debate.
      await tx.oddsSnapshot.create({
        data: {
          matchId: match.id,
          source: 'test',
          bookmaker: 'LateBook',
          market: 'MATCH_RESULT',
          capturedAt: new Date(cutoff.getTime() + 3_600_000),
          prices: { home: 2.1, draw: 3.4, away: 3.6 },
          overround: 1.05,
          implied: { home: 0.45, draw: 0.28, away: 0.27 },
          method: 'shin',
        },
      });
      const { transcript } = await new DebateService(tx, undefined, true).run(match.id);
      expect(transcript.rounds.one.baseline.status).toBe('NO_ODDS_BEFORE_CUTOFF');
      expect(transcript.rounds.one.baseline.bookmaker).toBeNull();
    });
  });

  it('builds a baseline and an edge from a price captured before the cutoff', async () => {
    // A late fixture, so the ratings have history to work from and the model actually states a probability.
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' }, orderBy: { matchDate: 'desc' } });
    const cutoff = informationCutoff(match);
    await inRollback(async (tx) => {
      await tx.oddsSnapshot.create({
        data: {
          matchId: match.id,
          source: 'test',
          bookmaker: 'EarlyBook',
          market: 'MATCH_RESULT',
          capturedAt: new Date(cutoff.getTime() - 2 * 3_600_000),
          prices: { home: 2.1, draw: 3.4, away: 3.6 },
          overround: 1.05,
          implied: {},
          method: 'shin',
        },
      });
      const { transcript } = await new DebateService(tx, undefined, true).run(match.id);
      const baseline = transcript.rounds.one.baseline;
      expect(baseline.status).toBe('AVAILABLE');
      expect(baseline.bookmaker).toBe('EarlyBook');
      const p = baseline.probabilities.MATCH_RESULT!;
      expect(p.home + p.draw + p.away).toBeCloseTo(1, 8);
      // A synthetic match is still vetoed, but the edge is now measurable.
      expect(transcript.verdicts.find((v) => v.market === 'MATCH_RESULT')!.edge).not.toBeNull();
    });
  });

  it('settles picks against the real result and scores both agents and the pick', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED', homeScore: { not: null }, awayScore: { not: null } }, orderBy: { matchDate: 'desc' } });
    await inRollback(async (tx) => {
      const { debateRunId } = await new DebateService(tx).run(match.id);
      const summary = await new DebateSettlementService(tx).settlePending({ dataEnvironment: 'SYNTHETIC' });
      expect(summary.settled).toBeGreaterThanOrEqual(3);

      const results = await tx.debatePickResult.findMany({ where: { pick: { debateRunId } } });
      expect(results.length).toBe(3);
      for (const r of results) {
        expect(r.brier).toBeGreaterThanOrEqual(0);
        expect(r.probabilityOfActual).toBeGreaterThanOrEqual(0);
        // No price was recorded, so no return may be claimed.
        expect(r.profitUnits).toBeNull();
      }

      const scored = await tx.debateAgentClaim.findMany({ where: { debateRunId, wasCorrect: { not: null } } });
      expect(scored.length).toBeGreaterThan(0);

      const report = await new DebateSettlementService(tx).report({ dataEnvironment: 'SYNTHETIC' });
      expect(report.settledPicks).toBeGreaterThanOrEqual(3);
      expect(report.roi.roi).toBeNull();
      expect(report.agentAccuracy.length).toBeGreaterThan(0);
    });
  });

  it('states no probability at all for the first fixture of a dataset, rather than inventing base rates', async () => {
    // The earliest match has no prior results, so no feature can be populated. The honest output is
    // "no probability", not an even split dressed up as a forecast.
    const first = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' }, orderBy: { matchDate: 'asc' } });
    await inRollback(async (tx) => {
      const { debateRunId, transcript } = await new DebateService(tx).run(first.id);
      expect(transcript.verdicts.every((v) => v.probabilities === null)).toBe(true);
      expect(transcript.verdicts.every((v) => v.recommendation === 'NO_PICK')).toBe(true);
      expect(transcript.rounds.two.objections.some((o) => o.code === 'MISSING_FEATURES' && o.severity === 'VETO')).toBe(true);

      // Nothing can be scored either: there is no forecast to be right or wrong about.
      const summary = await new DebateSettlementService(tx).settlePending({ dataEnvironment: 'SYNTHETIC' });
      const picks = await tx.debatePick.count({ where: { debateRunId } });
      expect(picks).toBe(3);
      expect(summary.skippedNoProbabilities).toBeGreaterThanOrEqual(3);
      expect(await tx.debatePickResult.count({ where: { pick: { debateRunId } } })).toBe(0);
    });
  });

  it('refuses to store a pick that claims to know more than its cutoff allows', async () => {
    const match = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'SYNTHETIC', status: 'FINISHED' } });
    await inRollback(async (tx) => {
      const run = await tx.debateRun.create({
        data: { matchId: match.id, dataEnvironment: 'SYNTHETIC', status: 'COMPLETED', engineVersion: 'test', asOf: match.matchDate },
      });
      await expect(
        tx.debatePick.create({
          data: {
            debateRunId: run.id,
            matchId: match.id,
            market: 'MATCH_RESULT',
            probabilities: { home: 1, draw: 0, away: 0 },
            confidence: 'HIGH',
            recommendation: 'PICK',
            stakeReason: 'test',
            reasoning: 'test',
            unresolvedObjections: [],
            // One second after kickoff: the database must reject this.
            kickoff: match.matchDate,
            asOf: new Date(match.matchDate.getTime() + 1000),
          },
        }),
      ).rejects.toThrow();
    });
  });
});
