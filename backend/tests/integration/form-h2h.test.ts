import { Prisma, PrismaClient, type Match, type MatchTeamStats } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { informationCutoff, resultKnownAt, visibleEnvironments } from '../../src/data/knowledge/cutoff.js';
import { KnowledgeService } from '../../src/data/knowledge/knowledge.service.js';
import { FormService } from '../../src/services/form.service.js';

const prisma = new PrismaClient();
const WINDOW = 5;
const HOUR = 3_600_000;

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 120_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

type WithStats = Match & { stats: MatchTeamStats[] };
let all: WithStats[] = [];

beforeAll(async () => {
  all = await prisma.match.findMany({ where: { status: 'FINISHED' }, include: { stats: true } });
  if (all.length < 1000) throw new Error('Form integration tests need the seed and the EPL import');
});
afterAll(async () => {
  await prisma.$disconnect();
});

// Independent reference implementation over raw rows, used to check the analyzers end to end.
function referenceHistory(target: Match, teamId: string, venue?: 'HOME' | 'AWAY'): WithStats[] {
  const cutoff = informationCutoff(target).getTime();
  const envs = visibleEnvironments(target.dataEnvironment);
  return all
    .filter((m) => m.id !== target.id && envs.includes(m.dataEnvironment) && resultKnownAt(m).getTime() < cutoff)
    .filter((m) => (venue === 'HOME' ? m.homeTeamId === teamId : venue === 'AWAY' ? m.awayTeamId === teamId : m.homeTeamId === teamId || m.awayTeamId === teamId))
    .sort((a, b) => b.matchDate.getTime() - a.matchDate.getTime() || a.id.localeCompare(b.id))
    .slice(0, WINDOW);
}

function referenceAverage(rows: WithStats[], teamId: string, key: 'shots' | 'corners' | 'possession' | 'yellowCards'): number | 'DATA UNAVAILABLE' {
  const values = rows.map((m) => m.stats.find((s) => s.teamId === teamId)?.[key] ?? null).filter((v): v is number => v !== null);
  return values.length === 0 ? 'DATA UNAVAILABLE' : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
}

describe('form reproduces an independent calculation for every finished match', () => {
  it('HISTORICAL, LIVE and SYNTHETIC: record, goals, venue splits and stat averages', { timeout: 300_000 }, async () => {
    const forms = new FormService(new KnowledgeService(prisma));
    const targets = [...all].sort((a, b) => a.matchDate.getTime() - b.matchDate.getTime());
    let checked = 0;
    for (const target of targets) {
      const f = await forms.matchForm(target.id, WINDOW);
      for (const [side, teamId] of [['home', target.homeTeamId], ['away', target.awayTeamId]] as const) {
        const bundle = f[side];
        const ref = referenceHistory(target, teamId);
        expect(bundle.overall.matches.map((m) => m.matchId)).toEqual(ref.map((m) => m.id));
        const gf = ref.reduce((s, m) => s + (m.homeTeamId === teamId ? m.homeScore! : m.awayScore!), 0);
        expect(bundle.overall.goalsScored).toBe(gf);
        const wins = ref.filter((m) => (m.homeTeamId === teamId ? m.homeScore! > m.awayScore! : m.awayScore! > m.homeScore!)).length;
        expect(bundle.overall.record.wins).toBe(wins);
        for (const key of ['shots', 'corners', 'possession', 'yellowCards'] as const) {
          const metric = { shots: 'averageShots', corners: 'averageCorners', possession: 'averagePossession', yellowCards: 'averageYellowCards' }[key] as 'averageShots';
          expect(bundle.overall[metric].value).toBe(ref.length === 0 ? 'DATA UNAVAILABLE' : referenceAverage(ref, teamId, key));
        }
        expect(bundle.homeAway.home.matches.map((m) => m.matchId)).toEqual(referenceHistory(target, teamId, 'HOME').map((m) => m.id));
        expect(bundle.homeAway.away.matches.map((m) => m.matchId)).toEqual(referenceHistory(target, teamId, 'AWAY').map((m) => m.id));
        for (const m of bundle.overall.matches) {
          expect(new Date(m.matchDate).getTime()).toBeLessThan(new Date(f.cutoff).getTime());
          if (target.dataEnvironment === 'SYNTHETIC') expect(m.dataEnvironment).toBe('SYNTHETIC');
          else expect(m.dataEnvironment).not.toBe('SYNTHETIC');
        }
      }
      checked += 1;
    }
    expect(checked).toBe(all.length);
  });
});

describe('real EPL data has no statistics, so stat metrics stay unavailable', () => {
  it('reports DATA UNAVAILABLE with sample size 0 and says why', async () => {
    const target = all.find((m) => m.source === 'openfootball' && m.sourceId.startsWith('en.1/2024-25/'))!;
    const f = await new FormService(new KnowledgeService(prisma)).matchForm(target.id, WINDOW);
    const o = f.home.overall;
    expect(o.status).toBe('AVAILABLE');
    expect(typeof o.averageGoalsScored.value).toBe('number');
    for (const metric of [o.averageShots, o.averageCorners, o.averagePossession, o.averageYellowCards, o.averageRedCards]) {
      expect(metric).toEqual({ value: 'DATA UNAVAILABLE', sampleSize: 0, window: WINDOW });
    }
    expect(o.limitations.join(' ')).toMatch(/Shots unavailable for all 5/);
  });
});

describe('head-to-head from the database', () => {
  it('uses only earlier meetings, from the upcoming home side perspective, with decaying weights', async () => {
    const target = all
      .filter((m) => m.source === 'openfootball' && m.dataEnvironment === 'LIVE')
      .sort((a, b) => b.matchDate.getTime() - a.matchDate.getTime())[0]!;
    const h = await new FormService(new KnowledgeService(prisma)).matchHeadToHead(target.id, 5, 365);
    const cutoff = informationCutoff(target).getTime();
    const refIds = all
      .filter((m) => m.headToHeadId === target.headToHeadId && m.id !== target.id && resultKnownAt(m).getTime() < cutoff)
      .sort((a, b) => b.matchDate.getTime() - a.matchDate.getTime())
      .slice(0, 5)
      .map((m) => m.id);
    expect(h.meetings.map((m) => m.matchId)).toEqual(refIds);
    for (let i = 1; i < h.meetings.length; i += 1) expect(h.meetings[i]!.weight).toBeLessThanOrEqual(h.meetings[i - 1]!.weight);
    for (const m of h.meetings) {
      const row = all.find((x) => x.id === m.matchId)!;
      const subjectHomeGoals = row.homeTeamId === target.homeTeamId ? row.homeScore : row.awayScore;
      expect(m.subjectHomeGoals).toBe(subjectHomeGoals);
    }
    expect(h.reliability).toBeLessThanOrEqual(1);
  });
});

describe('LIVE statistics recorded after the cutoff never enter form', () => {
  it('ignores late or corrected LIVE statistics but uses ones stored in time', async () => {
    const liveFinished = all.filter((m) => m.dataEnvironment === 'LIVE').sort((a, b) => b.matchDate.getTime() - a.matchDate.getTime());
    const upcoming = await prisma.match.findFirstOrThrow({ where: { dataEnvironment: 'LIVE', status: 'SCHEDULED', matchDate: { gt: new Date() } }, orderBy: { matchDate: 'asc' } });
    const prior = liveFinished.find((m) => m.homeTeamId === upcoming.homeTeamId || m.awayTeamId === upcoming.homeTeamId)!;
    const cutoff = informationCutoff(upcoming);

    await inRollback(async (tx) => {
      const statsRow = (teamId: string, createdAt: Date) => ({ matchId: prior.id, teamId, isHome: teamId === prior.homeTeamId, shots: 11, corners: 7, source: 'test-late', lastUpdated: createdAt, createdAt, updatedAt: createdAt });
      const inTime = new Date(resultKnownAt(prior).getTime() + HOUR);
      await tx.matchTeamStats.createMany({ data: [statsRow(prior.homeTeamId, inTime), statsRow(prior.awayTeamId, inTime)] });
      const forms = new FormService(new KnowledgeService(tx));
      const used = (await forms.matchForm(upcoming.id, WINDOW)).home.overall;
      expect(used.matches.find((m) => m.matchId === prior.id)?.statsStatus).toBe('KNOWN');
      expect(used.averageShots).toMatchObject({ value: 11, sampleSize: 1 });

      const late = new Date(cutoff.getTime() + HOUR);
      await tx.matchTeamStats.updateMany({ where: { matchId: prior.id }, data: { corners: 9 } });
      await tx.$executeRaw`UPDATE "MatchTeamStats" SET "updatedAt" = ${late} WHERE "matchId" = ${prior.id}`;
      const after = (await forms.matchForm(upcoming.id, WINDOW)).home.overall;
      expect(after.matches.find((m) => m.matchId === prior.id)?.statsStatus).toBe('PUBLISHED_AFTER_CUTOFF');
      expect(after.averageShots).toMatchObject({ value: 'DATA UNAVAILABLE', sampleSize: 0 });
      expect(after.limitations.join(' ')).toMatch(/recorded after the cutoff/);
    });
  });
});

describe('team form as of an instant', () => {
  it('matches the pre-kickoff form for the same cutoff and rejects future instants', async () => {
    const target = all.find((m) => m.source === 'openfootball' && m.sourceId.startsWith('en.1/2025-26/'))!;
    const forms = new FormService(new KnowledgeService(prisma));
    const byMatch = await forms.matchForm(target.id, WINDOW);
    const byTeam = await forms.teamForm(target.homeTeamId, WINDOW, informationCutoff(target));
    expect(byTeam.overall.matches.map((m) => m.matchId)).toEqual(byMatch.home.overall.matches.map((m) => m.matchId));
    await expect(forms.teamForm(target.homeTeamId, WINDOW, new Date(Date.now() + 86_400_000))).rejects.toThrow(/future/);
  });
});
