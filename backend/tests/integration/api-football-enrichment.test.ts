import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { CURATED_EPL_TEAMS } from '../../src/data/identity/curated-teams.js';
import { EnrichmentService, type EnrichmentRequest } from '../../src/data/enrich/enrichment.service.js';
import { KnowledgeService, type PointInTime } from '../../src/data/knowledge/knowledge.service.js';
import { ensemble } from '../../src/analysis/engine.js';
import { FeatureEngineeringService } from '../../src/features/feature-engineering.service.js';
import { ModelRegistry } from '../../src/learning/model-registry.js';
import { createModelAdapters } from '../../src/models/adapters.js';
import { MemoryUsageStore } from '../../src/providers/api-football/stores.js';
import { PrismaResponseCache, PrismaUsageStore, ReadOnlyResponseCache } from '../../src/data/fetch/provider-stores.js';
import { MockApiFootball, TEST_KEY, envelope, loadFixture, testProvider } from '../helpers/api-football-mock.js';

const prisma = new PrismaClient();
afterAll(() => prisma.$disconnect());

const HOUR = 3_600_000;
const NOW = new Date('2026-09-28T10:00:00Z');
const TEMPLATE = loadFixture<Record<string, unknown>>('fixture-1035038.json');
const LEAGUE = loadFixture<{ response: unknown[] }>('leagues-39.json');

class Rollback extends Error {}

// The development database may already hold real API-Football data: cached responses, fixture
// links, imported statistics. These tests assert on counts from a clean slate and drive a mocked
// provider, so a cached real response would be served instead of the mock. Each transaction
// therefore clears that provider's rows first; the rollback puts every one of them back.
async function clearProviderData(tx: Prisma.TransactionClient): Promise<void> {
  // Imported rows (events, line-ups, statistics, availability) are append-only by database
  // trigger and are deliberately left alone. What has to go is the request-level state that
  // would otherwise answer a mocked call with a real recorded response.
  await tx.externalSourceCache.deleteMany({ where: { url: { contains: 'api-sports.io' } } });
  await tx.providerCoverage.deleteMany({ where: { source: 'api-football' } });
  await tx.providerUsage.deleteMany({ where: { source: 'api-football' } });
  await tx.externalMatchLink.deleteMany({ where: { source: 'api-football' } });
  // A real import binds each alias to that provider's own team id, and Nexora then refuses any
  // id that disagrees — correctly. These tests use fabricated ids, so the bindings are released
  // here and restored by the rollback.
  await tx.teamAlias.updateMany({ where: { source: 'api-football' }, data: { sourceTeamId: null } });
}

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await clearProviderData(tx);
      await fn(tx);
      throw new Rollback();
    }, { timeout: 120_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

// Stable test IDs per club; Arsenal and Forest keep the IDs used in the recorded fixture.
const apiTeam = (curatedKey: string) => {
  const team = CURATED_EPL_TEAMS.find((t) => t.key === curatedKey)!;
  const id = curatedKey === 'eng-arsenal' ? 42 : curatedKey === 'eng-nottingham-forest' ? 65 : 1000 + CURATED_EPL_TEAMS.indexOf(team);
  return { id, name: team.aliases['api-football']![0]! };
};

type Db = Prisma.TransactionClient | PrismaClient;

async function findMatch(db: Db, where: Prisma.MatchWhereInput) {
  return db.match.findFirstOrThrow({ where: { source: 'openfootball', ...where }, include: { homeTeam: true, awayTeam: true } });
}

// Re-targets the recorded API-Football fixture at a real Nexora match (teams, kickoff, score, season).
function fixtureFor(
  match: Awaited<ReturnType<typeof findMatch>>,
  opts: { id: number; season: number; status?: string; goals?: { home: number | null; away: number | null }; shiftMinutes?: number; withDetails?: boolean },
): Record<string, unknown> {
  const home = apiTeam(match.homeTeam.sourceId);
  const away = apiTeam(match.awayTeam.sourceId);
  const text = JSON.stringify(TEMPLATE)
    .replaceAll('"id":42,"name":"Arsenal"', '"id":"__HOME_ID__","name":"__HOME_NAME__"')
    .replaceAll('"id":65,"name":"Nottingham Forest"', '"id":"__AWAY_ID__","name":"__AWAY_NAME__"')
    .replaceAll('"__HOME_ID__"', String(home.id))
    .replaceAll('"__HOME_NAME__"', JSON.stringify(home.name))
    .replaceAll('"__AWAY_ID__"', String(away.id))
    .replaceAll('"__AWAY_NAME__"', JSON.stringify(away.name));
  const f = JSON.parse(text) as Record<string, any>;
  const status = opts.status ?? 'FT';
  const goals = opts.goals ?? { home: match.homeScore, away: match.awayScore };
  f.fixture = { ...f.fixture, id: opts.id, date: new Date(match.matchDate.getTime() + (opts.shiftMinutes ?? -30) * 60_000).toISOString(), status: { long: status, short: status, elapsed: status === 'FT' ? 90 : null } };
  f.league = { ...f.league, season: opts.season };
  f.goals = goals;
  f.score = { ...f.score, halftime: { home: match.homeHalfTimeScore, away: match.awayHalfTimeScore }, fulltime: goals };
  if (status !== 'FT' || opts.withDetails === false) {
    f.events = [];
    f.lineups = [];
    f.statistics = [];
    f.players = [];
  }
  return f;
}

function mockApi(season: string, list: Array<Record<string, unknown>>, extra: (api: MockApiFootball) => void = () => {}) {
  const byId = new Map(list.map((f) => [String((f.fixture as { id: number }).id), f]));
  const api = new MockApiFootball()
    .on('leagues', () => ({ body: LEAGUE }))
    .on('fixtures', (p) => {
      if (p.ids) return { body: envelope(p.ids.split('-').map((id) => byId.get(id)).filter(Boolean) as unknown[]) };
      if (p.season !== season) return { body: envelope([]) };
      return { body: envelope(list) };
    })
    .on('injuries', () => ({ body: envelope([]) }));
  extra(api);
  return api;
}

function service(tx: Db, api: MockApiFootball, now: Date = NOW) {
  const { provider } = testProvider(api, { cache: new PrismaResponseCache(tx), usage: new PrismaUsageStore(tx), now: () => now });
  return new EnrichmentService(tx, provider, undefined, () => now);
}

const run = (tx: Db, api: MockApiFootball, request: Partial<EnrichmentRequest> & { seasonSourceId: string }, now: Date = NOW) =>
  service(tx, api, now).run({ competitionSourceId: '39', ...request });

const UNRESOLVABLE = (season: number) => ({
  ...TEMPLATE,
  fixture: { ...(TEMPLATE.fixture as object), id: 9_000_001 },
  league: { id: 39, season, round: 'Regular Season - 2' },
  teams: { home: { id: 9999, name: 'Atlantis FC' }, away: { id: 42, name: 'Arsenal' } },
});

describe('API-Football enrichment of existing Nexora matches', () => {
  it('enriches a finished HISTORICAL match with statistics, events, line-ups and player statistics, keeping provenance', async () => {
    await inRollback(async (tx) => {
      const match = await findMatch(tx, { sourceId: 'en.1/2023-24/Arsenal FC~Nottingham Forest FC' });
      const before = await tx.match.findUniqueOrThrow({ where: { id: match.id } });
      const api = mockApi('2023', [TEMPLATE, UNRESOLVABLE(2023)]);

      const summary = await run(tx, api, { seasonSourceId: '2023' });
      expect(summary.status).toBe('COMPLETED');
      expect(summary.dataEnvironment).toBe('HISTORICAL');
      expect(summary.counts).toMatchObject({ fixturesDiscovered: 2, fixturesMatched: 1, fixturesUnresolved: 1, linksCreated: 1, statsCreated: 2, eventsImported: 7, lineupsImported: 2, playersCreated: 5, playerStatsCreated: 5 });
      expect(summary.unresolvedFixtures).toEqual([expect.objectContaining({ sourceId: '9000001', reason: 'TEAM_UNRESOLVED' })]);
      expect(summary.unresolvedTeams).toEqual([expect.objectContaining({ name: 'Atlantis FC', reason: 'NO_ALIAS' })]);
      // Coverage + fixture list + one batched details request; injuries are not requested for a closed season.
      expect(summary.requests.made).toBe(3);
      expect(api.callsTo('injuries')).toHaveLength(0);
      expect(api.calls.every((c) => c.key === TEST_KEY && !c.url.href.includes(TEST_KEY))).toBe(true);

      const stats = await tx.matchTeamStats.findMany({ where: { matchId: match.id }, orderBy: { isHome: 'desc' } });
      expect(stats[0]).toMatchObject({ isHome: true, possession: 78, shots: 18, shotsOnTarget: 6, shotsOffTarget: 7, blockedShots: 5, corners: 8, yellowCards: 1, redCards: null, goalkeeperSaves: 0, passAccuracy: 90, source: 'api-football', sourceId: '1035038' });
      expect(stats[1]).toMatchObject({ isHome: false, possession: 22, corners: 0, yellowCards: 2, redCards: null });
      // xG, the provider's raw values and event-log card evidence are kept with the row; null red cards stay unknown.
      expect(stats[0]!.additional).toMatchObject({
        expectedGoals: 2.39,
        providerRaw: { 'Red Cards': null, 'Ball Possession': '78%', 'Goalkeeper Saves': 0 },
        derivedFromEvents: { yellowCardEvents: 1, secondYellowEvents: 0, redCardEvents: 0 },
        nullPolicy: expect.stringContaining('all UNKNOWN'),
      });
      expect(summary.warningCounts.RED_CARDS_NULL_NO_DISMISSAL_EVENTS).toBe(2);

      const events = await tx.matchEvent.findMany({ where: { matchId: match.id } });
      expect(events.map((e) => e.type).sort()).toEqual(['GOAL', 'GOAL', 'GOAL', 'SUBSTITUTION', 'SUBSTITUTION', 'YELLOW_CARD', 'YELLOW_CARD']);
      expect(events.every((e) => e.source === 'api-football' && e.sourceId.startsWith('1035038:'))).toBe(true);

      const saka = await tx.playerMatchStats.findFirstOrThrow({ where: { matchId: match.id, player: { name: 'B. Saka' } } });
      expect(saka).toMatchObject({ started: true, minutes: 90, rating: 8.4, goals: 1, assists: 1, yellowCards: 0, source: 'api-football', sourceId: '1035038' });
      const nketiah = await tx.playerMatchStats.findFirstOrThrow({ where: { matchId: match.id, player: { name: 'E. Nketiah' } } });
      expect(nketiah.assists).toBeNull();
      expect(await tx.playerMatchStats.count({ where: { matchId: match.id, player: { name: 'A. Ramsdale' } } })).toBe(0);

      const link = await tx.externalMatchLink.findUniqueOrThrow({ where: { source_sourceId: { source: 'api-football', sourceId: '1035038' } } });
      expect(link).toMatchObject({ matchId: match.id, matchedBy: 'TEAMS_AND_KICKOFF', kickoffDeltaMinutes: -30, sourceStatus: 'FINISHED', sourceHomeScore: 2, sourceAwayScore: 1, conflict: null });
      expect(link.detailsFetchedAt).not.toBeNull();
      expect(await tx.teamAlias.findFirst({ where: { source: 'api-football', sourceTeamId: '42' }, select: { teamId: true } })).toEqual({ teamId: match.homeTeamId });

      // The canonical fixture is never touched by enrichment.
      const after = await tx.match.findUniqueOrThrow({ where: { id: match.id } });
      expect(after).toEqual(before);

      const importRun = await tx.importRun.findUniqueOrThrow({ where: { id: summary.importRunId! } });
      expect(importRun).toMatchObject({ source: 'api-football', dataset: '39/2023', dataEnvironment: 'HISTORICAL', status: 'COMPLETED' });
      expect(importRun.counts).toMatchObject({ provider: 'api-football', competition: '39', season: '2023', requests: 3, fixturesMatched: 1, fixturesUnresolved: 1, statsCreated: 2, eventsImported: 7, playerStatsCreated: 5 });
      expect(JSON.stringify(importRun)).not.toContain(TEST_KEY);
    });
  });

  it('is idempotent: re-running makes no requests and creates no duplicates', async () => {
    await inRollback(async (tx) => {
      const match = await findMatch(tx, { sourceId: 'en.1/2023-24/Arsenal FC~Nottingham Forest FC' });
      const api = mockApi('2023', [TEMPLATE]);
      await run(tx, api, { seasonSourceId: '2023' });
      const count = async () => ({
        stats: await tx.matchTeamStats.count({ where: { matchId: match.id } }),
        events: await tx.matchEvent.count({ where: { matchId: match.id } }),
        lineups: await tx.matchLineup.count({ where: { matchId: match.id } }),
        playerStats: await tx.playerMatchStats.count({ where: { matchId: match.id } }),
        players: await tx.player.count({ where: { source: 'api-football' } }),
        links: await tx.externalMatchLink.count({ where: { source: 'api-football' } }),
        matches: await tx.match.count(),
      });
      const first = await count();
      const callsAfterFirst = api.calls.length;

      const second = await run(tx, api, { seasonSourceId: '2023' });
      expect(second.requests.made).toBe(0);
      expect(api.calls.length).toBe(callsAfterFirst);
      expect(second.counts).toMatchObject({ linksCreated: 0, statsCreated: 0, eventsImported: 0, playersCreated: 0, playerStatsCreated: 0 });

      // Even forcing the same details through ingestion again changes nothing.
      const svc = service(tx, api);
      const prepared = await svc.prepare(tx, { competitionSourceId: '39', seasonSourceId: '2023' });
      const { provider } = testProvider(api, { cache: new PrismaResponseCache(tx), usage: new PrismaUsageStore(tx), now: () => NOW });
      prepared.details = (await provider.getFixtureDetails(['1035038'], () => Number.POSITIVE_INFINITY)).details;
      const forced = await svc.apply(tx, prepared);
      expect(forced).toMatchObject({ statsCreated: 0, statsFilled: 0, statsUpdated: 0, eventsImported: 0, lineupsImported: 0, playersCreated: 0, playerStatsCreated: 0, playerStatsFilled: 0 });
      expect(await count()).toEqual(first);
    });
  });

  it('records a result conflict, withholds enrichment and leaves the canonical result untouched', async () => {
    await inRollback(async (tx) => {
      const match = await findMatch(tx, { sourceId: 'en.1/2023-24/Arsenal FC~Nottingham Forest FC' });
      const disputed = fixtureFor(match, { id: 1035038, season: 2023, goals: { home: 3, away: 1 } });
      const summary = await run(tx, mockApi('2023', [disputed]), { seasonSourceId: '2023' });
      expect(summary.status).toBe('COMPLETED');
      expect(summary.counts.conflicts).toBe(1);
      expect(summary.conflicts[0]).toMatchObject({ sourceId: '1035038', matchId: match.id, detail: { canonical: { home: 2, away: 1 }, source: { home: 3, away: 1 } } });
      expect(summary.warningCounts.RESULT_CONFLICT).toBe(1);
      expect(await tx.matchTeamStats.count({ where: { matchId: match.id } })).toBe(0);
      expect(await tx.matchEvent.count({ where: { matchId: match.id } })).toBe(0);
      const after = await tx.match.findUniqueOrThrow({ where: { id: match.id } });
      expect([after.homeScore, after.awayScore, after.status]).toEqual([2, 1, 'FINISHED']);
      const link = await tx.externalMatchLink.findUniqueOrThrow({ where: { source_sourceId: { source: 'api-football', sourceId: '1035038' } } });
      expect(link.conflict).toMatchObject({ source: { home: 3 } });
    });
  });

  it('respects coverage flags: unavailable datasets are neither requested nor written, and the state is recorded', async () => {
    await inRollback(async (tx) => {
      const match = await findMatch(tx, { sourceId: { startsWith: 'en.1/2024-25/' }, status: 'FINISHED' });
      const f = fixtureFor(match, { id: 1_208_000, season: 2024 });
      const api = mockApi('2024', [f]);
      const summary = await run(tx, api, { seasonSourceId: '2024', types: ['stats', 'events', 'lineups', 'players', 'injuries'] });
      expect(summary.status).toBe('COMPLETED');
      expect(summary.unavailable).toMatchObject({ fixtureStatistics: 'Provider coverage flag is false', playerStatistics: 'Provider coverage flag is false', injuries: 'Provider coverage flag is false' });
      expect(api.callsTo('injuries')).toHaveLength(0);
      expect(await tx.matchTeamStats.count({ where: { matchId: match.id } })).toBe(0);
      expect(await tx.playerMatchStats.count({ where: { matchId: match.id } })).toBe(0);
      expect(await tx.matchEvent.count({ where: { matchId: match.id } })).toBe(7);
      const coverage = await tx.providerCoverage.findMany({ where: { source: 'api-football', seasonSourceId: '2024' } });
      expect(Object.fromEntries(coverage.map((c) => [c.dataset, c.available]))).toMatchObject({ fixtures: true, events: true, fixtureStatistics: false, playerStatistics: false, injuries: false });
    });
  });

  it('records a plan refusal and does not repeat the refused request on the next run', async () => {
    await inRollback(async (tx) => {
      const api = new MockApiFootball()
        .on('leagues', () => ({ body: LEAGUE }))
        .on('fixtures', () => ({ body: envelope([], { errors: { plan: 'Free plans do not have access to this season, try from 2022 to 2024.' } }) }));
      const first = await run(tx, api, { seasonSourceId: '2026' });
      expect(first.status).toBe('FAILED');
      expect(first.errorMessage).toMatch(/PLAN/);
      const refused = await tx.providerCoverage.findUniqueOrThrow({ where: { source_competitionSourceId_seasonSourceId_dataset: { source: 'api-football', competitionSourceId: '39', seasonSourceId: '2026', dataset: 'fixtures' } } });
      expect(refused).toMatchObject({ available: false });
      expect(refused.reason).toMatch(/^PLAN/);

      // The season listing is refused, so the provider also tries the days the plan still serves
      // before giving up. Those probes are the point of the fallback, not a repeat of the
      // refused request: exactly one call carries league+season.
      const firstRunCalls = api.callsTo('fixtures');
      expect(firstRunCalls.filter((c) => c.params.season).length).toBe(1);
      expect(firstRunCalls.filter((c) => c.params.date).length).toBeGreaterThan(0);

      const second = await run(tx, api, { seasonSourceId: '2026' });
      expect(second.status).toBe('FAILED');
      // What must not happen twice: the refusal is remembered, so the second run asks for nothing.
      expect(api.callsTo('fixtures')).toHaveLength(firstRunCalls.length);
      expect(second.requests.made).toBe(0);
    });
  });

  it('imports injuries and suspensions for upcoming LIVE fixtures; unlisted players stay UNKNOWN; history is append-only', async () => {
    await inRollback(async (tx) => {
      const match = await findMatch(tx, { dataEnvironment: 'LIVE', status: 'SCHEDULED', homeTeam: { sourceId: 'eng-arsenal' }, awayTeam: { sourceId: 'eng-leeds' } });
      expect(match.matchDate.getTime()).toBeGreaterThan(NOW.getTime());
      const f = fixtureFor(match, { id: 1_400_100, season: 2026, status: 'NS', shiftMinutes: 0 });
      const arsenal = apiTeam('eng-arsenal');
      const leeds = apiTeam('eng-leeds');
      const injury = (playerId: number, name: string, team: { id: number; name: string }, type: string, reason: string) => ({ player: { id: playerId, name, type, reason }, team, fixture: { id: 1_400_100 }, league: { id: 39, season: 2026 } });
      let injuries = [
        injury(1460, 'B. Saka', arsenal, 'Missing Fixture', 'Hamstring Injury'),
        injury(7001, 'L. Defender', leeds, 'Missing Fixture', 'Red Card'),
        injury(7002, 'L. Midfielder', leeds, 'Questionable', 'Knock'),
      ];
      const squads: Record<string, unknown> = {
        [String(arsenal.id)]: { team: arsenal, players: [{ id: 1460, name: 'B. Saka', position: 'Attacker' }, { id: 1100, name: 'Another Gunner', position: 'Defender' }] },
        [String(leeds.id)]: { team: leeds, players: [{ id: 7001, name: 'L. Defender', position: 'Defender' }, { id: 7002, name: 'L. Midfielder', position: 'Midfielder' }] },
      };
      const api = mockApi('2026', [f], (a) => {
        a.on('injuries', () => ({ body: envelope(injuries) }));
        a.on('players/squads', (p) => ({ body: envelope([squads[p.team!]]) }));
      });

      const first = await run(tx, api, { seasonSourceId: '2026' });
      expect(first.status).toBe('COMPLETED');
      expect(first.counts).toMatchObject({ injuriesDiscovered: 1, suspensionsDiscovered: 1, doubtfulDiscovered: 1, availabilityImported: 3, playersCreated: 3 });
      const rows = await tx.playerAvailability.findMany({ where: { matchId: match.id, source: 'api-football' }, include: { player: true }, orderBy: { reportedAt: 'asc' } });
      expect(rows.map((r) => [r.player.name, r.status, r.sourceStatus]).sort()).toEqual([
        ['B. Saka', 'INJURED', 'Missing Fixture'],
        ['L. Defender', 'SUSPENDED', 'Missing Fixture'],
        ['L. Midfielder', 'DOUBTFUL', 'Questionable'],
      ]);
      expect(rows.every((r) => r.reportedAt.getTime() === NOW.getTime() && r.sourceId?.startsWith('1400100:'))).toBe(true);
      // No report is manufactured for anyone the provider did not list.
      expect(await tx.playerAvailability.count({ where: { matchId: match.id, status: 'AVAILABLE' } })).toBe(0);
      expect(await tx.player.count({ where: { source: 'api-football', sourceId: '1100' } })).toBe(0);
      const known = await new KnowledgeService(tx).availabilityAt(match.id, match.matchDate);
      expect(known.reports.map((r) => r.player.name).sort()).toEqual(['B. Saka', 'L. Defender', 'L. Midfielder']);

      const again = await run(tx, api, { seasonSourceId: '2026' });
      expect(again.counts.availabilityImported).toBe(0);
      expect(again.requests.made).toBe(0);

      // Hours later the provider changes one status: a new report is appended; the old one is kept unchanged.
      injuries = [injuries[0]!, injuries[1]!, injury(7002, 'L. Midfielder', leeds, 'Missing Fixture', 'Knee Injury')];
      const later = new Date(NOW.getTime() + 7 * HOUR);
      const third = await run(tx, api, { seasonSourceId: '2026' }, later);
      expect(third.counts.availabilityImported).toBe(1);
      expect(api.callsTo('players/squads')).toHaveLength(2);
      const history = await tx.playerAvailability.findMany({ where: { matchId: match.id, player: { sourceId: '7002' } }, orderBy: { reportedAt: 'asc' } });
      expect(history.map((h) => [h.status, h.reportedAt.toISOString()])).toEqual([
        ['DOUBTFUL', NOW.toISOString()],
        ['INJURED', later.toISOString()],
      ]);
      const cutoffBetween = new Date(NOW.getTime() + HOUR);
      expect((await new KnowledgeService(tx).availabilityAt(match.id, cutoffBetween)).reports.find((r) => r.player.name === 'L. Midfielder')?.status).toBe('DOUBTFUL');

      await expect(tx.playerAvailability.update({ where: { id: history[0]!.id }, data: { status: 'AVAILABLE' } })).rejects.toThrow(/immutable/);
    });
  });

  it('never lets statistics imported after a cutoff inform that cutoff (future-data protection)', async () => {
    await inRollback(async (tx) => {
      const match = await findMatch(tx, { dataEnvironment: 'LIVE', status: 'FINISHED', homeTeam: { sourceId: 'eng-man-city' }, awayTeam: { sourceId: 'eng-sunderland' } });
      const f = fixtureFor(match, { id: 1_400_200, season: 2026 });
      // Real clock here: the check compares the rows' database timestamps against cutoffs either side of the import.
      const summary = await run(tx, mockApi('2026', [f]), { seasonSourceId: '2026', types: ['stats', 'players'] }, new Date());
      expect(summary.counts.statsCreated).toBe(2);
      const stored = await tx.matchTeamStats.findFirstOrThrow({ where: { matchId: match.id, teamId: match.homeTeamId } });

      const knowledge = new KnowledgeService(tx);
      const pit = (cutoff: Date): PointInTime => ({ cutoff, environments: ['HISTORICAL', 'LIVE'] });
      const beforeImport = new Date(stored.createdAt.getTime() - 60_000);
      const afterImport = new Date(Math.max(stored.createdAt.getTime(), stored.updatedAt.getTime()) + 60_000);

      const early = (await knowledge.teamHistory(match.homeTeamId, pit(beforeImport), 10)).results.find((r) => r.matchId === match.id)!;
      expect(early.stats.status).toBe('PUBLISHED_AFTER_CUTOFF');
      expect(early.stats.for).toBeNull();
      const late = (await knowledge.teamHistory(match.homeTeamId, pit(afterImport), 10)).results.find((r) => r.matchId === match.id)!;
      expect(late.stats.status).toBe('KNOWN');
      expect(late.stats.for?.shots).toBe(18);

      const earlyPlayers = await knowledge.playerHistory(match.homeTeamId, pit(beforeImport), 10);
      expect(earlyPlayers.rows.filter((r) => r.matchId === match.id)).toHaveLength(0);
      const latePlayers = await knowledge.playerHistory(match.homeTeamId, pit(afterImport), 10);
      expect(latePlayers.rows.filter((r) => r.matchId === match.id).length).toBeGreaterThan(0);
    });
  });

  it('stops cleanly when rate limited mid-run, reports what it did not fetch, and retries next time', async () => {
    await inRollback(async (tx) => {
      const match = await findMatch(tx, { sourceId: 'en.1/2023-24/Arsenal FC~Nottingham Forest FC' });
      const api = mockApi('2023', [TEMPLATE], (a) => {
        const list = { body: envelope([TEMPLATE]) };
        a.on('fixtures', (p) => (p.ids ? { status: 429, body: { message: 'Too many requests' } } : list));
      });
      const summary = await run(tx, api, { seasonSourceId: '2023' });
      expect(summary.status).toBe('COMPLETED');
      expect(summary.requests.rateLimited).toBe(1);
      expect(summary.requests.stoppedReason).toMatch(/429/);
      expect(summary.requests.planned.length).toBeGreaterThan(0);
      expect(summary.counts).toMatchObject({ linksCreated: 1, statsCreated: 0, skipped: 1 });
      const link = await tx.externalMatchLink.findUniqueOrThrow({ where: { source_sourceId: { source: 'api-football', sourceId: '1035038' } } });
      expect(link.detailsFetchedAt).toBeNull();
      expect(link.matchId).toBe(match.id);
    });
  });

  it('enriched statistics reach the knowledge layer but leave result forecasts unchanged (Step 3A isolation)', async () => {
    await inRollback(async (tx) => {
      const enrichedMatch = await findMatch(tx, { sourceId: 'en.1/2023-24/Arsenal FC~Nottingham Forest FC' });
      const next = await tx.match.findFirstOrThrow({
        where: { dataEnvironment: 'HISTORICAL', matchDate: { gt: new Date(enrichedMatch.matchDate.getTime() + 3 * HOUR) }, OR: [{ homeTeamId: enrichedMatch.homeTeamId }, { awayTeamId: enrichedMatch.homeTeamId }] },
        orderBy: { matchDate: 'asc' },
      });
      const forecast = async () => {
        const build = await new FeatureEngineeringService(tx).build(next.id);
        const adapters = createModelAdapters();
        const ctx = { weights: await new ModelRegistry(tx).weightsOf((await new ModelRegistry(tx).baseline()).id), modelVersion: 't' };
        const outputs = (await Promise.all([adapters.mathematical.run(build.vector, ctx), adapters.dataAnalysis.run(build.vector, ctx)])).flatMap((r) => (r.ok ? [r.output] : []));
        return { build, combined: ensemble(outputs) };
      };
      const before = await forecast();
      await run(tx, mockApi('2023', [TEMPLATE]), { seasonSourceId: '2023' });
      const after = await forecast();

      const side = next.homeTeamId === enrichedMatch.homeTeamId ? 'Home' : 'Away';
      expect(before.build.vector.features[`shotsOnTarget${side}Average`].value).toBeNull();
      expect(after.build.vector.features[`shotsOnTarget${side}Average`].value).toBe(6);
      expect(after.combined.MATCH_RESULT).toEqual(before.combined.MATCH_RESULT);
      expect(after.combined.numeric.GOALS).toEqual(before.combined.numeric.GOALS);
    });
  });

  it('isolates provider failure: a crashing API leaves every OpenFootball record untouched', async () => {
    await inRollback(async (tx) => {
      const before = await tx.match.aggregate({ _count: true, _max: { updatedAt: true } });
      const api = new MockApiFootball().on('leagues', () => ({ throws: new Error('ECONNRESET') }));
      const summary = await run(tx, api, { seasonSourceId: '2026' });
      expect(summary.status).toBe('FAILED');
      expect(summary.errorMessage).toMatch(/Coverage check failed/);
      expect(await tx.importRun.findUniqueOrThrow({ where: { id: summary.importRunId! } })).toMatchObject({ status: 'FAILED' });
      expect(await tx.match.aggregate({ _count: true, _max: { updatedAt: true } })).toEqual(before);
    });
  });
});

describe('API-Football dry-run', () => {
  it('reports what it would do without writing anything to the database', async () => {
    // Run inside the rollback like every other test here, so a cached real response cannot answer
    // a mocked call. The "writes nothing" claim is still proven: the counts are taken inside the
    // transaction, where any write the dry-run made would be visible.
    await inRollback(async (tx) => {
      const tables = async () => ({
        match: await tx.match.count(),
        matchTeamStats: await tx.matchTeamStats.count(),
        playerMatchStats: await tx.playerMatchStats.count(),
        playerAvailability: await tx.playerAvailability.count(),
        player: await tx.player.count(),
        matchEvent: await tx.matchEvent.count(),
        matchLineup: await tx.matchLineup.count(),
        externalMatchLink: await tx.externalMatchLink.count(),
        externalSourceCache: await tx.externalSourceCache.count(),
        providerUsage: await tx.providerUsage.count(),
        providerCoverage: await tx.providerCoverage.count(),
        importRun: await tx.importRun.count(),
        boundAliases: await tx.teamAlias.count({ where: { sourceTeamId: { not: null } } }),
        aliases: await tx.teamAlias.count(),
        matchRevision: await tx.matchRevision.count(),
      });
      const before = await tables();
      const api = mockApi('2023', [TEMPLATE, UNRESOLVABLE(2023)]);
      const { provider } = testProvider(api, { cache: new ReadOnlyResponseCache(tx), usage: new MemoryUsageStore(new PrismaUsageStore(tx)), network: 'discovery', now: () => NOW });
      const summary = await new EnrichmentService(tx, provider, undefined, () => NOW).run({ competitionSourceId: '39', seasonSourceId: '2023' }, { dryRun: true });

      expect(summary.status).toBe('DRY_RUN');
      expect(summary.importRunId).toBeNull();
      expect(summary.counts).toMatchObject({ fixturesDiscovered: 2, fixturesMatched: 1, fixturesUnresolved: 1, linksCreated: 1, detailsRequested: 1, detailsReceived: 0 });
      expect(summary.requests.planned).toEqual(['https://v3.football.api-sports.io/fixtures?ids=1035038']);
      expect(api.calls.map((c) => c.endpoint)).toEqual(['leagues', 'fixtures']);
      expect(await tables()).toEqual(before);
    });
  });
});
