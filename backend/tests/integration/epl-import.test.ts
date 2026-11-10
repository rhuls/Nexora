import { Prisma, PrismaClient, type Match } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../../src/config/providers.js';
import { UnresolvedTeamError } from '../../src/data/identity/team-identity.js';
import { FootballDataImporter, type PreparedImport } from '../../src/data/import/football-data.importer.js';
import { informationCutoff, resultKnownAt, visibleEnvironments } from '../../src/data/knowledge/cutoff.js';
import { KnowledgeService } from '../../src/data/knowledge/knowledge.service.js';

const prisma = new PrismaClient();
const SEASONS = ['2023-24', '2024-25', '2025-26'] as const;
const WINDOW = 5;

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

// Network is never used here: historical files are already in ExternalSourceCache with an infinite max age.
const provider = createProviderRegistry(prisma).get('openfootball');
const importer = new FootballDataImporter(prisma);
const prepare = (season: string): Promise<PreparedImport> =>
  importer.prepare(provider, { competitionSourceId: 'en.1', seasonSourceId: season, dataEnvironment: 'HISTORICAL' });

let epl: Match[] = [];

beforeAll(async () => {
  // Scoped to en.1: other competitions import from the same source into the same environment, and
  // this file is about what the Premier League import produced.
  epl = await prisma.match.findMany({
    where: { source: 'openfootball', dataEnvironment: 'HISTORICAL', sourceId: { startsWith: 'en.1/' } },
    orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
  });
  if (epl.length === 0) throw new Error('Integration tests need the EPL import (npm run import:data)');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('EPL import contents', () => {
  it('imports exactly the source fixtures as finished HISTORICAL matches with provenance', async () => {
    expect(epl).toHaveLength(3 * 380);
    expect(new Set(epl.map((m) => m.sourceId)).size).toBe(epl.length);
    expect(epl.every((m) => m.status === 'FINISHED' && m.dataEnvironment === 'HISTORICAL')).toBe(true);
    expect(epl.every((m) => m.homeScore !== null && m.awayScore !== null && m.round !== null && m.sourceMatchDate !== null && m.kickoffTimeKnown)).toBe(true);
    const seasons = await prisma.season.findMany({
      where: { source: 'openfootball', sourceId: { startsWith: 'en.1/' }, matches: { some: { dataEnvironment: 'HISTORICAL' } } },
      orderBy: { name: 'asc' },
    });
    expect(seasons.map((s) => s.name)).toEqual(['2023/24', '2024/25', '2025/26']);
    expect(await prisma.match.count({ where: { season: { source: 'openfootball', sourceId: 'en.1/2026-27' }, dataEnvironment: 'HISTORICAL' } })).toBe(0);
  });

  it('leaves half-time unavailable exactly where the source omitted it', async () => {
    for (const season of SEASONS) {
      const cached = await prisma.externalSourceCache.findFirstOrThrow({ where: { url: { contains: `/${season}/en.1.json` } } });
      const raw = (JSON.parse(cached.body) as { matches: Array<{ team1: string; team2: string; score?: unknown }> }).matches;
      const sourceWithoutHt = raw
        .filter((m) => Array.isArray(m.score) || !(m.score as { ht?: unknown } | undefined)?.ht)
        .map((m) => `en.1/${season}/${m.team1}~${m.team2}`)
        .sort();
      const storedWithoutHt = epl
        .filter((m) => m.sourceId.startsWith(`en.1/${season}/`) && (m.homeHalfTimeScore === null || m.awayHalfTimeScore === null))
        .map((m) => m.sourceId)
        .sort();
      expect(storedWithoutHt).toEqual(sourceWithoutHt);
    }
    const withHt = epl.filter((m) => m.homeHalfTimeScore !== null);
    expect(withHt.every((m) => m.homeHalfTimeScore! <= m.homeScore! && m.awayHalfTimeScore! <= m.awayScore!)).toBe(true);
  });

  it('stores the original local date text and a matching UTC kickoff', () => {
    const opener = epl.find((m) => m.sourceId === 'en.1/2023-24/Burnley FC~Manchester City FC')!;
    expect(opener.sourceMatchDate).toBe('2023-08-11 20:00');
    expect(opener.matchDate.toISOString()).toBe('2023-08-11T19:00:00.000Z');
    expect(opener.homeScore).toBe(0);
    expect(opener.awayScore).toBe(3);
  });

  it('fabricates no statistics, players or availability for a source that supplies none', async () => {
    const ids = epl.map((m) => m.id);
    // Scoped to openfootball: an enrichment provider legitimately adds rows for these same
    // matches, and that is not this source fabricating anything.
    const [teamStats, playerStats, availability, players] = await Promise.all([
      prisma.matchTeamStats.count({ where: { matchId: { in: ids }, source: 'openfootball' } }),
      prisma.playerMatchStats.count({ where: { matchId: { in: ids }, source: 'openfootball' } }),
      prisma.playerAvailability.count({ where: { matchId: { in: ids }, source: 'openfootball' } }),
      prisma.player.count({ where: { team: { source: 'nexora-curated' }, source: 'openfootball' } }),
    ]);
    expect({ teamStats, playerStats, availability, players }).toEqual({ teamStats: 0, playerStats: 0, availability: 0, players: 0 });
  });

  it('resolves every club through a curated alias', async () => {
    const teamIds = [...new Set(epl.flatMap((m) => [m.homeTeamId, m.awayTeamId]))];
    expect(teamIds).toHaveLength(25);
    const aliased = await prisma.teamAlias.findMany({ where: { source: 'openfootball', teamId: { in: teamIds } }, select: { teamId: true } });
    expect(new Set(aliased.map((a) => a.teamId)).size).toBe(25);
  });

  it('records a completed ImportRun for each season', async () => {
    for (const season of SEASONS) {
      const run = await prisma.importRun.findFirst({ where: { source: 'openfootball', dataset: `en.1/${season}`, status: 'COMPLETED' } });
      expect(run).not.toBeNull();
    }
  });
});

describe('importer safety', () => {
  it('is idempotent: re-applying every season creates nothing and changes nothing', async () => {
    for (const season of SEASONS) {
      const prepared = await prepare(season);
      await inRollback(async (tx) => {
        const counts = await importer.apply(tx, prepared);
        expect(counts).toMatchObject({ sourceMatches: 380, created: 0, updated: 0, conflicts: 0, metadataFilled: 0, unchanged: 380, teamsCreated: 0, aliasesCreated: 0 });
      });
    }
  });

  it('never overwrites a stored historical result when the source later disagrees', async () => {
    const prepared = await prepare('2023-24');
    const target = prepared.matches[0]!;
    const tampered: PreparedImport = { ...prepared, warnings: [], matches: prepared.matches.map((m) => (m === target ? { ...m, homeScore: 9 } : m)) };
    await inRollback(async (tx) => {
      const counts = await importer.apply(tx, tampered);
      expect(counts.conflicts).toBe(1);
      expect(tampered.warnings.map((w) => w.code)).toEqual(['HISTORICAL_CONFLICT']);
      const stored = await tx.match.findUniqueOrThrow({ where: { source_sourceId: { source: 'openfootball', sourceId: target.sourceId } } });
      expect(stored.homeScore).toBe(target.homeScore);
    });
  });

  it('refuses unknown team names instead of guessing', async () => {
    const prepared = await prepare('2023-24');
    const renamed: PreparedImport = { ...prepared, matches: prepared.matches.map((m, i) => (i === 0 ? { ...m, homeTeam: { sourceId: null, name: 'Man City' } } : m)) };
    await inRollback(async (tx) => {
      await expect(importer.apply(tx, renamed)).rejects.toBeInstanceOf(UnresolvedTeamError);
    });
  });

  it('refuses to import real data as SYNTHETIC', async () => {
    await expect(importer.prepare(provider, { competitionSourceId: 'en.1', seasonSourceId: '2023-24', dataEnvironment: 'SYNTHETIC' })).rejects.toThrow(/never imported/);
  });
});

// Independent brute-force reference: what a careful human could have known before kickoff.
function expectedKnown(all: Match[], target: Match, teamFilter: (m: Match) => boolean): string[] {
  const cutoff = informationCutoff(target).getTime();
  const envs = visibleEnvironments(target.dataEnvironment);
  return all
    .filter((m) => m.id !== target.id && m.status === 'FINISHED' && envs.includes(m.dataEnvironment) && teamFilter(m) && resultKnownAt(m).getTime() < cutoff)
    .sort((a, b) => b.matchDate.getTime() - a.matchDate.getTime() || a.id.localeCompare(b.id))
    .slice(0, WINDOW)
    .map((m) => m.id);
}

describe('point-in-time knowledge reconstruction', () => {
  it('reconstructs exactly the knowable history for every historical match, with no future input', { timeout: 180_000 }, async () => {
    const knowledge = new KnowledgeService(prisma);
    const all = await prisma.match.findMany({ where: { dataEnvironment: { in: ['HISTORICAL', 'LIVE'] } } });
    let checked = 0;
    for (const target of epl) {
      const k = await knowledge.reconstruct(target.id, { formWindow: WINDOW, h2hWindow: WINDOW });
      const cutoff = informationCutoff(target).getTime();
      const involves = (teamId: string) => (m: Match) => m.homeTeamId === teamId || m.awayTeamId === teamId;

      expect(k.integrity.allInputsBeforeCutoff).toBe(true);
      if (k.latestInputAt) expect(new Date(k.latestInputAt).getTime()).toBeLessThan(cutoff);
      expect(k.home.recent.map((r) => r.matchId)).toEqual(expectedKnown(all, target, involves(target.homeTeamId)));
      expect(k.away.recent.map((r) => r.matchId)).toEqual(expectedKnown(all, target, involves(target.awayTeamId)));
      expect(k.headToHead.meetings.map((r) => r.matchId)).toEqual(expectedKnown(all, target, (m) => m.headToHeadId === target.headToHeadId));

      for (const r of [...k.home.recent, ...k.away.recent, ...k.headToHead.meetings]) {
        expect(new Date(r.resultKnownAt).getTime()).toBeLessThan(cutoff);
        expect(r.dataEnvironment).toBe('HISTORICAL');
        expect(r.matchId).not.toBe(target.id);
      }
      expect(k.availability.status).toBe('DATA UNAVAILABLE');
      checked += 1;
    }
    expect(checked).toBe(1140);
  });

  it('knows nothing before the first imported match and says so', async () => {
    const k = await new KnowledgeService(prisma).reconstruct(epl[0]!.id);
    expect(k.home.recent).toHaveLength(0);
    expect(k.away.recent).toHaveLength(0);
    expect(k.latestInputAt).toBeNull();
    expect(k.dataLimitations.join(' ')).toMatch(/Only 0 completed matches/);
  });

  it('keeps synthetic matches sealed off from real data', { timeout: 60_000 }, async () => {
    const synthetic = await prisma.match.findMany({ where: { dataEnvironment: 'SYNTHETIC' }, select: { id: true } });
    const knowledge = new KnowledgeService(prisma);
    for (const { id } of synthetic) {
      const k = await knowledge.reconstruct(id);
      expect(k.visibleEnvironments).toEqual(['SYNTHETIC']);
      for (const r of [...k.home.recent, ...k.away.recent, ...k.headToHead.meetings]) expect(r.dataEnvironment).toBe('SYNTHETIC');
    }
  });

  it('ignores planted future, not-yet-final and synthetic matches', async () => {
    const target = epl.find((m) => m.sourceId.startsWith('en.1/2024-25/'))!;
    const cutoff = informationCutoff(target);
    const hour = 3_600_000;
    await inRollback(async (tx) => {
      const before = await new KnowledgeService(tx).reconstruct(target.id);
      const plant = (suffix: string, matchDate: Date, dataEnvironment: 'HISTORICAL' | 'SYNTHETIC') =>
        tx.match.create({
          data: {
            competitionId: target.competitionId, seasonId: target.seasonId, homeTeamId: target.homeTeamId, awayTeamId: target.awayTeamId,
            headToHeadId: target.headToHeadId, dataEnvironment, source: 'leak-test', sourceId: suffix, lastUpdated: new Date(),
            matchDate, status: 'FINISHED', homeScore: 7, awayScore: 7,
          },
        });
      await plant('future', new Date(cutoff.getTime() + 24 * hour), 'HISTORICAL');
      await plant('same-day', new Date(cutoff.getTime() - 2 * hour), 'HISTORICAL');
      await plant('synthetic', new Date(cutoff.getTime() - 30 * 24 * hour), 'SYNTHETIC');

      const after = await new KnowledgeService(tx).reconstruct(target.id);
      const ids = (k: typeof after) => [...k.home.recent, ...k.away.recent, ...k.headToHead.meetings].map((r) => r.matchId);
      expect(ids(after)).toEqual(ids(before));
      expect(after.home.excludedNotYetKnown).toBe(before.home.excludedNotYetKnown + 1);
      expect(after.headToHead.excludedNotYetKnown).toBe(before.headToHead.excludedNotYetKnown + 1);
    });
  });
});
