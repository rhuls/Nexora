import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadApiFootballConfig, Secret } from '../src/config/api-football.js';
import { compareResult, matchFixtures, resolveProviderTeams, type AliasRow, type CandidateMatch } from '../src/data/enrich/fixture-matching.js';
import { EnrichmentService, backboneSeasonFor, mergeValues } from '../src/data/enrich/enrichment.service.js';
import { LiveSyncService } from '../src/data/sync/live-sync.service.js';
import type { ImportService } from '../src/data/import/import.service.js';
import type { ImportSummary } from '../src/data/import/football-data.importer.js';
import { requestKey } from '../src/providers/api-football/client.js';
import { classifyAvailability, mapStatus, parseEvents, parseFixtures, parseLeague, parseLineups, parsePlayerStats, parseStatValue, parseStatistics } from '../src/providers/api-football/normalize.js';
import { MemoryResponseCache, MemoryUsageStore } from '../src/providers/api-football/stores.js';
import type { ProviderMatch, SourceWarning } from '../src/providers/types.js';
import { MockApiFootball, TEST_KEY, envelope, loadFixture, testProvider } from './helpers/api-football-mock.js';
import type { PrismaClient } from '@prisma/client';

const FIXTURE = loadFixture<Record<string, unknown>>('fixture-1035038.json');
const LEAGUE = loadFixture<{ response: unknown[] }>('leagues-39.json');

const parsedFixture = (element: unknown = FIXTURE): ProviderMatch => {
  const warnings: SourceWarning[] = [];
  const [f] = parseFixtures([element], warnings);
  if (!f) throw new Error(`fixture did not parse: ${JSON.stringify(warnings)}`);
  return f.match;
};

describe('API-Football configuration and authentication', () => {
  it('treats a missing key as "not configured" rather than an error', () => {
    const config = loadApiFootballConfig({});
    expect(config.key).toBeNull();
    expect(config.dailyBudget).toBe(90);
    expect(loadApiFootballConfig({ API_FOOTBALL_KEY: '   ' }).key).toBeNull();
  });

  it('reads a configured key only from the environment passed in', () => {
    const config = loadApiFootballConfig({ API_FOOTBALL_KEY: TEST_KEY, API_FOOTBALL_DAILY_BUDGET: '40' });
    expect(config.key?.reveal()).toBe(TEST_KEY);
    expect(config.dailyBudget).toBe(40);
  });

  it('never reveals the key through string conversion, JSON, util.inspect or interpolation', () => {
    const config = loadApiFootballConfig({ API_FOOTBALL_KEY: TEST_KEY });
    for (const text of [String(config.key), `${config.key}`, JSON.stringify(config), inspect(config, { depth: 5 }), inspect(new Secret(TEST_KEY))]) {
      expect(text).not.toContain(TEST_KEY);
    }
  });

  it('reports invalid settings by variable name without echoing values', () => {
    expect(() => loadApiFootballConfig({ API_FOOTBALL_KEY: TEST_KEY, API_FOOTBALL_DAILY_BUDGET: 'lots' })).toThrow(/API_FOOTBALL_DAILY_BUDGET/);
    try {
      loadApiFootballConfig({ API_FOOTBALL_KEY: TEST_KEY, API_FOOTBALL_DAILY_BUDGET: 'lots' });
    } catch (error) {
      expect(String(error)).not.toContain(TEST_KEY);
    }
  });

  it('enrichment reports NOT_CONFIGURED without touching the network or the database', async () => {
    const api = new MockApiFootball();
    const { provider } = testProvider(api, { config: { key: null } });
    const summary = await new EnrichmentService({} as PrismaClient, provider).run({ competitionSourceId: '39', seasonSourceId: '2026' });
    expect(summary.status).toBe('NOT_CONFIGURED');
    expect(summary.importRunId).toBeNull();
    expect(api.calls).toHaveLength(0);
  });
});

describe('API-Football client', () => {
  it('sends the key only in the x-apisports-key header and caches successful responses', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ body: LEAGUE }));
    const cache = new MemoryResponseCache();
    const { provider } = testProvider(api, { cache });
    const first = await provider.getSeasonCoverage('39');
    const second = await provider.getSeasonCoverage('39');
    expect(first.available && second.available).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.key).toBe(TEST_KEY);
    expect(api.calls[0]!.url.href).not.toContain(TEST_KEY);
    expect(api.calls[0]!.url.href).toBe('https://v3.football.api-sports.io/leagues?id=39');
    for (const [key, value] of cache.entries) expect(key + value.body).not.toContain(TEST_KEY);
    expect(provider.requestStats()).toMatchObject({ requests: 1, cacheHits: 1, cacheMisses: 1 });
  });

  it('treats an HTTP 200 with an errors object as a failure and never caches it', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ body: envelope([], { errors: { token: 'Error/Missing application key.' } }) }));
    const cache = new MemoryResponseCache();
    const { provider } = testProvider(api, { cache });
    const result = await provider.getSeasonCoverage('39');
    expect(result).toMatchObject({ available: false });
    expect(!result.available && result.reason).toMatch(/^AUTH/);
    expect(cache.entries.size).toBe(0);
    // An authentication failure stops the run: nothing further is requested.
    await provider.getSeasonCoverage('39');
    expect(api.calls).toHaveLength(1);
  });

  it('treats HTTP 401/403 (key rejected) as an authentication failure that stops the run', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ status: 403, body: { message: 'Forbidden' } }));
    const { provider } = testProvider(api);
    const first = await provider.getSeasonCoverage('39');
    expect(!first.available && first.reason).toMatch(/^AUTH: leagues: HTTP 403/);
    await provider.getSeasonCoverage('39');
    expect(api.calls).toHaveLength(1);
  });

  it('records a plan restriction without stopping other requests', async () => {
    const api = new MockApiFootball()
      .on('fixtures', () => ({ body: envelope([], { errors: { plan: 'Free plans do not have access to this season.' } }) }))
      .on('leagues', () => ({ body: LEAGUE }));
    const { provider } = testProvider(api);
    const fixtures = await provider.getFixtures({ competitionSourceId: '39', seasonSourceId: '2026' });
    expect(!fixtures.available && fixtures.reason).toMatch(/^PLAN/);
    expect((await provider.getSeasonCoverage('39')).available).toBe(true);
  });

  it('stops on HTTP 429 and plans, rather than retries, the remaining requests', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ status: 429, body: { message: 'Too many requests' } }));
    const usage = new MemoryUsageStore();
    const { provider } = testProvider(api, { usage });
    const first = await provider.getSeasonCoverage('39');
    const second = await provider.getSeasonCoverage('40');
    expect(!first.available && first.reason).toMatch(/^RATE_LIMITED/);
    expect(!second.available && second.reason).toMatch(/^STOPPED/);
    expect(api.calls).toHaveLength(1);
    const stats = provider.requestStats();
    expect(stats.rateLimited).toBe(1);
    expect(stats.stoppedReason).toMatch(/429/);
    expect(stats.planned).toContain(requestKey('leagues', { id: '40' }));
  });

  it('treats a rateLimit entry in the errors object like HTTP 429', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ body: envelope([], { errors: { rateLimit: 'Too many requests. Your rate limit is 10 requests per minute.' } }) }));
    const { provider } = testProvider(api);
    const result = await provider.getSeasonCoverage('39');
    expect(!result.available && result.reason).toMatch(/^RATE_LIMITED/);
    expect(provider.requestStats().stoppedReason).not.toBeNull();
  });

  it('rejects malformed responses and does not cache them', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ rawBody: '<html>gateway error</html>' })).on('teams', () => ({ body: { response: 'not-an-array', errors: [] } }));
    const cache = new MemoryResponseCache();
    const { provider } = testProvider(api, { cache });
    expect(await provider.getSeasonCoverage('39')).toMatchObject({ available: false });
    expect(await provider.getTeams({ competitionSourceId: '39', seasonSourceId: '2026' })).toMatchObject({ available: false });
    expect(cache.entries.size).toBe(0);
    expect(provider.requestStats().errors).toBe(2);
  });

  it('follows pagination and returns every page', async () => {
    const injury = (id: number) => ({ player: { id, name: `P${id}`, type: 'Missing Fixture', reason: 'Knee Injury' }, team: { id: 42, name: 'Arsenal' }, fixture: { id: 1 } });
    const api = new MockApiFootball().on('injuries', (p) =>
      p.page === '2' ? { body: envelope([injury(3)], { paging: { current: 2, total: 2 } }) } : { body: envelope([injury(1), injury(2)], { paging: { current: 1, total: 2 } }) },
    );
    const { provider } = testProvider(api);
    const result = await provider.getInjuries({ competitionSourceId: '39', seasonSourceId: '2026' }, 60_000);
    expect(result.available && result.data.map((r) => r.player.sourceId)).toEqual(['1', '2', '3']);
    expect(api.calls.map((c) => c.params.page ?? '1')).toEqual(['1', '2']);
  });

  it('enforces the daily budget before making a request', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ body: LEAGUE }));
    const usage = new MemoryUsageStore();
    await usage.record('api-football', new Date().toISOString().slice(0, 10), { requests: 3 });
    const { provider } = testProvider(api, { usage, config: { dailyBudget: 3 } });
    const result = await provider.getSeasonCoverage('39');
    expect(!result.available && result.reason).toMatch(/^BUDGET/);
    expect(api.calls).toHaveLength(0);
  });

  it('stops when the provider reports it is down to the reserve', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ body: LEAGUE, headers: { 'x-ratelimit-requests-remaining': '4' } })).on('teams', () => ({ body: envelope([]) }));
    const { provider } = testProvider(api, { config: { reserve: 5 } });
    expect((await provider.getSeasonCoverage('39')).available).toBe(true);
    const next = await provider.getTeams({ competitionSourceId: '39', seasonSourceId: '2026' });
    expect(!next.available && next.reason).toMatch(/^BUDGET.*4 requests left/);
    expect(api.calls).toHaveLength(1);
  });

  it('scrubs the key from network error messages and stored usage errors', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ throws: new Error(`socket closed while sending ${TEST_KEY}`) }));
    const usage = new MemoryUsageStore();
    const { provider } = testProvider(api, { usage });
    const result = await provider.getSeasonCoverage('39');
    expect(!result.available && result.reason).toMatch(/NETWORK/);
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
    expect(JSON.stringify([...usage.rows.values()])).not.toContain(TEST_KEY);
  });

  it('in dry-run mode plans detail requests instead of making them; offline plans everything', async () => {
    const api = new MockApiFootball().on('leagues', () => ({ body: LEAGUE })).on('fixtures', () => ({ body: envelope([FIXTURE]) }));
    const discovery = testProvider(api, { network: 'discovery' });
    expect((await discovery.provider.getSeasonCoverage('39')).available).toBe(true);
    const details = await discovery.provider.getFixtureDetails(['1035038'], () => 60_000);
    expect(details.details).toHaveLength(0);
    expect(details.notFetched).toEqual(['1035038']);
    expect(discovery.provider.requestStats().planned).toEqual([requestKey('fixtures', { ids: '1035038' })]);
    expect(api.callsTo('fixtures')).toHaveLength(0);

    const offline = testProvider(new MockApiFootball(), { network: 'none' });
    expect(await offline.provider.getSeasonCoverage('39')).toMatchObject({ available: false });
    expect(offline.provider.requestStats().planned).toEqual([requestKey('leagues', { id: '39' })]);
  });
});

describe('API-Football fixture details batching and cache', () => {
  it('batches up to 20 fixtures per request and caches each fixture separately', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(2000 + i));
    const api = new MockApiFootball().on('fixtures', (p) => ({
      body: envelope(p.ids!.split('-').map((id) => ({ ...FIXTURE, fixture: { ...(FIXTURE.fixture as object), id: Number(id) } }))),
    }));
    const cache = new MemoryResponseCache();
    const { provider } = testProvider(api, { cache });
    const first = await provider.getFixtureDetails(ids, () => Number.POSITIVE_INFINITY);
    expect(first.details).toHaveLength(25);
    expect(api.callsTo('fixtures').map((c) => c.params.ids!.split('-').length)).toEqual([20, 5]);

    const again = await provider.getFixtureDetails([...ids].reverse(), () => Number.POSITIVE_INFINITY);
    expect(again.details).toHaveLength(25);
    expect(api.callsTo('fixtures')).toHaveLength(2);
    expect(provider.requestStats().cacheHits).toBe(25);
  });

  it('reports fixtures absent from a batch response as not fetched', async () => {
    const api = new MockApiFootball().on('fixtures', () => ({ body: envelope([FIXTURE]) }));
    const { provider } = testProvider(api);
    const result = await provider.getFixtureDetails(['1035038', '999'], () => 0);
    expect(result.details.map((d) => d.match.sourceId)).toEqual(['1035038']);
    expect(result.notFetched).toEqual(['999']);
  });
});

describe('API-Football normalisation', () => {
  it('parses percentages and numbers; missing stays null and zero stays zero', () => {
    expect(parseStatValue('56%')).toBe(56);
    expect(parseStatValue('2.39')).toBeCloseTo(2.39);
    expect(parseStatValue(0)).toBe(0);
    expect(parseStatValue('0')).toBe(0);
    expect(parseStatValue(null)).toBeNull();
    expect(parseStatValue(undefined)).toBeNull();
    expect(parseStatValue('')).toBeNull();
    expect(parseStatValue('n/a')).toBeNull();
  });

  it('maps fixture status codes and skips malformed fixtures with a warning', () => {
    expect(mapStatus('FT')).toBe('FINISHED');
    expect(mapStatus('NS')).toBe('SCHEDULED');
    expect(mapStatus('PST')).toBe('POSTPONED');
    expect(mapStatus('2H')).toBe('LIVE');
    expect(mapStatus('???')).toBeNull();
    const warnings: SourceWarning[] = [];
    expect(parseFixtures([{ fixture: { id: 'x' } }, FIXTURE], warnings)).toHaveLength(1);
    expect(warnings.map((w) => w.code)).toEqual(['MALFORMED_FIXTURE']);
  });

  it('parses a finished fixture with kickoff, score and half-time', () => {
    const m = parsedFixture();
    expect(m).toMatchObject({ sourceId: '1035038', seasonSourceId: '2023', status: 'FINISHED', homeScore: 2, awayScore: 1, homeHalfTimeScore: 2, awayHalfTimeScore: 0, kickoffTimeKnown: true });
    expect(m.kickoff.toISOString()).toBe('2023-08-12T11:30:00.000Z');
    expect(m.homeTeam).toEqual({ sourceId: '42', name: 'Arsenal' });
  });

  it('maps team statistics: possession, shots, corners, cards; null stays null, zero stays zero', () => {
    const match = parsedFixture();
    const warnings: SourceWarning[] = [];
    const [home, away] = parseStatistics(FIXTURE.statistics as unknown[], match, warnings);
    expect(home).toMatchObject({ isHome: true, teamSourceId: '42', goals: 2, possession: 78, shots: 18, shotsOnTarget: 6, shotsOffTarget: 7, blockedShots: 5, corners: 8, fouls: 11, offsides: 1, yellowCards: 1, goalkeeperSaves: 0, passes: 685, passesAccurate: 617, passAccuracy: 90 });
    expect(home!.redCards).toBeNull();
    expect(away).toMatchObject({ isHome: false, possession: 22, corners: 0, yellowCards: 2, goalkeeperSaves: 4 });
    expect(away!.redCards).toBeNull();
    expect(home!.additional).toMatchObject({ expectedGoals: 2.39, shotsInsideBox: 12 });
    expect(warnings).toEqual([]);
  });

  it('does not coerce invalid possession or non-integer counts into numbers', () => {
    const match = parsedFixture();
    const [row] = parseStatistics([{ team: { id: 42, name: 'Arsenal' }, statistics: [{ type: 'Ball Possession', value: '140%' }, { type: 'Corner Kicks', value: '4.5' }, { type: 'Mystery Stat', value: 3 }] }], match, []);
    expect(row).toMatchObject({ possession: null, corners: null, shots: null });
  });

  it('maps goals, own goals, penalties, cards and substitutions', () => {
    const match = parsedFixture();
    const raw = [
      { time: { elapsed: 10, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 1, name: 'A' }, assist: { id: null, name: null }, type: 'Goal', detail: 'Normal Goal', comments: null },
      { time: { elapsed: 20, extra: null }, team: { id: 65, name: 'Nottingham Forest' }, player: { id: 2, name: 'B' }, assist: {}, type: 'Goal', detail: 'Own Goal', comments: null },
      { time: { elapsed: 30, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 1, name: 'A' }, assist: {}, type: 'Goal', detail: 'Penalty', comments: null },
      { time: { elapsed: 40, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 1, name: 'A' }, assist: {}, type: 'Goal', detail: 'Missed Penalty', comments: null },
      { time: { elapsed: 50, extra: null }, team: { id: 65, name: 'Nottingham Forest' }, player: { id: 3, name: 'C' }, assist: {}, type: 'Card', detail: 'Yellow Card', comments: null },
      { time: { elapsed: 60, extra: null }, team: { id: 65, name: 'Nottingham Forest' }, player: { id: 3, name: 'C' }, assist: {}, type: 'Card', detail: 'Second Yellow card', comments: null },
      { time: { elapsed: 61, extra: null }, team: { id: 65, name: 'Nottingham Forest' }, player: { id: 4, name: 'D' }, assist: {}, type: 'Card', detail: 'Red Card', comments: null },
      { time: { elapsed: 70, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 5, name: 'E' }, assist: { id: 6, name: 'F' }, type: 'subst', detail: 'Substitution 1', comments: null },
    ];
    const events = parseEvents(raw, match, []);
    expect(events.map((e) => e.type)).toEqual(['GOAL', 'OWN_GOAL', 'PENALTY_GOAL', 'MISSED_PENALTY', 'YELLOW_CARD', 'SECOND_YELLOW', 'RED_CARD', 'SUBSTITUTION']);
    expect(events[7]).toMatchObject({ playerSourceId: '5', relatedPlayerSourceId: '6', relatedPlayerName: 'F' });
  });

  it('gives events deterministic keys that stay distinct for identical same-minute events', () => {
    const match = parsedFixture();
    const card = { time: { elapsed: 55, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: null, name: null }, assist: {}, type: 'Card', detail: 'Yellow Card', comments: null };
    const first = parseEvents([card, card, ...(FIXTURE.events as unknown[])], match, []);
    const second = parseEvents([card, card, ...(FIXTURE.events as unknown[])], match, []);
    expect(new Set(first.map((e) => e.sourceId)).size).toBe(first.length);
    expect(first.map((e) => e.sourceId)).toEqual(second.map((e) => e.sourceId));
    expect(first[0]!.sourceId.startsWith('1035038:')).toBe(true);
  });

  it('keeps player statistics nullable, omits unused substitutes, and reads starts and ratings', () => {
    const match = parsedFixture();
    const lineups = parseLineups(FIXTURE.lineups as unknown[], []);
    const groups = parsePlayerStats(FIXTURE.players as unknown[], match, lineups, []);
    const arsenal = groups.find((g) => g.team.sourceId === '42')!.players;
    expect(arsenal.map((p) => p.name)).toEqual(['B. Saka', 'E. Nketiah', 'K. Havertz']);
    expect(arsenal[0]).toMatchObject({ started: true, minutes: 90, rating: 8.4, goals: 1, assists: 1, shots: 4, shotsOnTarget: 2, passes: 41, tackles: 2, interceptions: 1, fouls: 1, yellowCards: 0, redCards: 0, position: 'FORWARD' });
    expect(arsenal[1]!.assists).toBeNull();
    expect(arsenal[1]!.tackles).toBeNull();
    expect(arsenal[2]).toMatchObject({ started: false, minutes: 20, goals: null });
  });

  it('classifies availability without inferring AVAILABLE', () => {
    expect(classifyAvailability('Missing Fixture', 'Knee Injury')).toBe('INJURED');
    expect(classifyAvailability('Missing Fixture', 'Illness')).toBe('INJURED');
    expect(classifyAvailability('Missing Fixture', 'Suspended')).toBe('SUSPENDED');
    expect(classifyAvailability('Missing Fixture', 'Red Card')).toBe('SUSPENDED');
    expect(classifyAvailability('Missing Fixture', 'Yellow Cards')).toBe('SUSPENDED');
    expect(classifyAvailability('Questionable', 'Knock')).toBe('DOUBTFUL');
    expect(classifyAvailability('Missing Fixture', "Coach's decision")).toBe('UNKNOWN');
    expect(classifyAvailability(null, null)).toBe('UNKNOWN');
  });

  it('reads per-season coverage flags', () => {
    const league = parseLeague(LEAGUE.response, [])!;
    const s2024 = league.seasons.find((s) => s.seasonSourceId === '2024')!;
    expect(s2024.coverage).toMatchObject({ fixtures: true, events: true, fixtureStatistics: false, playerStatistics: false, injuries: false });
    expect(league.seasons.find((s) => s.seasonSourceId === '2026')).toMatchObject({ current: true, name: '2026/27' });
  });
});

describe('team identity and fixture matching', () => {
  const aliases: AliasRow[] = [
    { teamId: 'ars', normalizedAlias: 'arsenal', sourceTeamId: null },
    { teamId: 'nfo', normalizedAlias: 'nottingham forest', sourceTeamId: '65' },
    { teamId: 'lei', normalizedAlias: 'leicester', sourceTeamId: null },
  ];

  it('resolves via explicit aliases and binds the provider ID on first use', () => {
    const { resolved, unresolved } = resolveProviderTeams(aliases, [{ sourceId: '42', name: 'Arsenal' }, { sourceId: '65', name: 'Nottingham Forest' }, { sourceId: '46', name: 'Leicester' }]);
    expect(resolved.get('42')).toEqual({ teamId: 'ars', bindAlias: 'arsenal' });
    expect(resolved.get('65')).toEqual({ teamId: 'nfo', bindAlias: null });
    expect(resolved.get('46')?.teamId).toBe('lei');
    expect(unresolved).toEqual([]);
  });

  it('leaves unknown names and ID/name disagreements unresolved instead of guessing', () => {
    const { resolved, unresolved } = resolveProviderTeams(aliases, [
      { sourceId: '46', name: 'Leicester City' },
      { sourceId: '65', name: 'Arsenal' },
      { sourceId: '99', name: 'Nottingham Forest' },
      { sourceId: null, name: 'Arsenal' },
    ]);
    expect(resolved.size).toBe(0);
    expect(unresolved.map((u) => u.reason)).toEqual(['NO_ALIAS', 'ID_NAME_CONFLICT', 'ALIAS_BOUND_TO_OTHER_ID', 'NO_SOURCE_ID']);
  });

  const teams = new Map([
    ['42', { teamId: 'ars', bindAlias: null }],
    ['65', { teamId: 'nfo', bindAlias: null }],
  ]);
  const candidate = (over: Partial<CandidateMatch> = {}): CandidateMatch => ({
    id: 'm1', homeTeamId: 'ars', awayTeamId: 'nfo', matchDate: new Date('2023-08-12T12:00:00Z'), status: 'FINISHED', homeScore: 2, awayScore: 1, dataEnvironment: 'HISTORICAL', ...over,
  });
  const empty = new Map<string, string>();

  it('matches on canonical teams plus kickoff within tolerance, recording the delta', () => {
    const { matched, unresolved } = matchFixtures({ fixtures: [parsedFixture()], teams, candidates: [candidate()], linksBySourceId: empty, linksByMatchId: empty });
    expect(unresolved).toEqual([]);
    expect(matched[0]).toMatchObject({ matchedBy: 'TEAMS_AND_KICKOFF', kickoffDeltaMinutes: -30 });
    expect(matched[0]!.match.id).toBe('m1');
  });

  it('prefers an existing link and never re-matches a linked Nexora match to another fixture', () => {
    const f = parsedFixture();
    expect(matchFixtures({ fixtures: [f], teams, candidates: [candidate()], linksBySourceId: new Map([['1035038', 'm1']]), linksByMatchId: new Map([['m1', '1035038']]) }).matched[0]!.matchedBy).toBe('EXISTING_LINK');
    const other = matchFixtures({ fixtures: [f], teams, candidates: [candidate()], linksBySourceId: empty, linksByMatchId: new Map([['m1', '555']]) });
    expect(other.unresolved[0]!.reason).toBe('MATCH_LINKED_TO_OTHER_FIXTURE');
  });

  it('reports unresolved teams, missing candidates, reschedules and ambiguity', () => {
    const f = parsedFixture();
    const reason = (input: Partial<Parameters<typeof matchFixtures>[0]>) =>
      matchFixtures({ fixtures: [f], teams, candidates: [candidate()], linksBySourceId: empty, linksByMatchId: empty, ...input }).unresolved.map((u) => u.reason);
    expect(reason({ teams: new Map([['42', { teamId: 'ars', bindAlias: null }]]) })).toEqual(['TEAM_UNRESOLVED']);
    expect(reason({ candidates: [] })).toEqual(['NO_CANDIDATE']);
    expect(reason({ candidates: [candidate({ matchDate: new Date('2023-09-30T12:00:00Z') })] })).toEqual(['KICKOFF_MISMATCH']);
    expect(reason({ candidates: [candidate(), candidate({ id: 'm2', matchDate: new Date('2023-08-12T20:00:00Z') })] })).toEqual(['AMBIGUOUS_CANDIDATES']);
    expect(reason({ fixtures: [f, { ...f, sourceId: '777' }] })).toEqual(['DUPLICATE_FIXTURE_FOR_MATCH', 'DUPLICATE_FIXTURE_FOR_MATCH']);
    expect(reason({ candidates: [candidate({ dataEnvironment: 'SYNTHETIC' })] })).toEqual(['NO_CANDIDATE']);
  });

  it('withholds enrichment when the provider disagrees with the canonical result', () => {
    const f = parsedFixture();
    expect(compareResult(candidate(), f)).toMatchObject({ enrichable: true, reason: 'OK' });
    expect(compareResult(candidate({ homeScore: 3 }), f)).toMatchObject({ enrichable: false, reason: 'RESULT_CONFLICT', conflict: { canonical: { home: 3, away: 1 }, source: { home: 2, away: 1 } } });
    expect(compareResult(candidate({ status: 'SCHEDULED', homeScore: null, awayScore: null }), f)).toMatchObject({ enrichable: false, reason: 'AWAITING_CANONICAL_RESULT' });
  });
});

describe('merge rules and season mapping', () => {
  it('never overwrites a known value with null; conflicts unless the source may still correct itself', () => {
    const existing = { shots: 10, corners: null, redCards: 0 };
    expect(mergeValues(existing, { shots: null, corners: 4, redCards: 0 }, ['shots', 'corners', 'redCards'], false)).toEqual({ changes: { corners: 4 }, filled: ['corners'], updated: [], conflicts: [] });
    expect(mergeValues(existing, { shots: 12 }, ['shots'], false).conflicts).toEqual(['shots']);
    expect(mergeValues(existing, { shots: 12 }, ['shots'], true)).toMatchObject({ changes: { shots: 12 }, updated: ['shots'] });
  });

  it('maps API-Football seasons onto the OpenFootball backbone and rejects anything else', () => {
    expect(backboneSeasonFor('39', '2023')).toMatchObject({ seasonKey: 'en.1/2023-24', dataset: { dataEnvironment: 'HISTORICAL' } });
    expect(backboneSeasonFor('39', '2026')).toMatchObject({ seasonKey: 'en.1/2026-27', dataset: { dataEnvironment: 'LIVE' } });
    expect(backboneSeasonFor('39', '2019')).toBeNull();
    // A season the backbone does not hold is rejected whatever the league.
    expect(backboneSeasonFor('140', '2019')).toBeNull();
    // A league with no backbone competition behind it is rejected too.
    expect(backboneSeasonFor('2', '2026')).toBeNull();
  });

  it('maps all five leagues it now carries onto their backbone competitions', () => {
    const expected: Array<[string, string, string]> = [
      ['39', 'en.1', 'Premier League'],
      ['140', 'es.1', 'La Liga'],
      ['78', 'de.1', 'Bundesliga'],
      ['135', 'it.1', 'Serie A'],
      ['61', 'fr.1', 'Ligue 1'],
    ];
    for (const [leagueId, competition] of expected) {
      expect(backboneSeasonFor(leagueId, '2026')).toMatchObject({ seasonKey: `${competition}/2026-27`, dataset: { dataEnvironment: 'LIVE' } });
    }
  });
});

describe('sync failure isolation', () => {
  it('an enrichment crash never loses or blocks the OpenFootball results', async () => {
    const summary = { importRunId: 'r1', status: 'COMPLETED', source: 'openfootball', dataset: 'en.1/2026-27', dataEnvironment: 'LIVE', counts: null, warningCounts: {}, unavailableFromSource: [], errorMessage: null } as ImportSummary;
    const imports = { importSeasons: async () => [summary] } as unknown as ImportService;
    const sync = new LiveSyncService(imports, [{ source: 'openfootball', competitionSourceId: 'en.1', seasonSourceId: '2026-27', dataEnvironment: 'LIVE' }], async () => {
      throw new Error('api-football unreachable');
    });
    const result = await sync.syncOnce();
    expect(result.imports).toEqual([summary]);
    expect(result.enrichmentError).toBe('api-football unreachable');
  });
});

describe('plans without the Ids parameter', () => {
  const IDS_REFUSAL = { body: envelope([], { errors: { plan: 'Free plans do not have access to the Ids parameter.' } }) };
  const one = (id: string) => ({ ...FIXTURE, fixture: { ...(FIXTURE.fixture as object), id: Number(id) } });
  // Refuses any batched request; serves single fixtures normally. This is the free plan's behaviour.
  const refusingApi = () =>
    new MockApiFootball().on('fixtures', (p) => (p.ids ? IDS_REFUSAL : { body: envelope([one(p.id!)]) }));

  it('falls back to one request per fixture, losing no fixture to the refusal', async () => {
    const api = refusingApi();
    const { provider } = testProvider(api);
    const res = await provider.getFixtureDetails(['1', '2'], () => Number.POSITIVE_INFINITY);

    expect(res.notFetched).toEqual([]);
    expect(res.details.map((d) => d.match.sourceId).sort()).toEqual(['1', '2']);
    // One refused batch, then one request per fixture.
    expect(api.callsTo('fixtures').map((c) => (c.params.ids ? 'batch' : 'single'))).toEqual(['batch', 'single', 'single']);
  });

  it('probes once, then goes straight to single requests for the rest of the run', async () => {
    const api = refusingApi();
    const { provider } = testProvider(api);
    await provider.getFixtureDetails(['1', '2'], () => Number.POSITIVE_INFINITY);
    await provider.getFixtureDetails(['3'], () => Number.POSITIVE_INFINITY);

    // Exactly one batched attempt across both calls: the refusal is remembered.
    expect(api.callsTo('fixtures').filter((c) => c.params.ids)).toHaveLength(1);
    expect(api.callsTo('fixtures').filter((c) => c.params.id)).toHaveLength(3);
  });

  it('skips the probe entirely when the plan is known not to batch', async () => {
    const api = refusingApi();
    const { provider } = testProvider(api, { config: { batchFixtures: false } });
    const res = await provider.getFixtureDetails(['1'], () => Number.POSITIVE_INFINITY);

    expect(res.details).toHaveLength(1);
    expect(api.callsTo('fixtures').every((c) => c.params.id && !c.params.ids)).toBe(true);
    expect(api.callsTo('fixtures')).toHaveLength(1);
  });

  it('caches each fixture, so a second run makes no request at all', async () => {
    const api = refusingApi();
    const cache = new MemoryResponseCache();
    const { provider } = testProvider(api, { cache });
    await provider.getFixtureDetails(['1', '2'], () => Number.POSITIVE_INFINITY);
    const before = api.callsTo('fixtures').length;

    const second = await provider.getFixtureDetails(['1', '2'], () => Number.POSITIVE_INFINITY);
    expect(second.details).toHaveLength(2);
    expect(api.callsTo('fixtures')).toHaveLength(before);
  });

  it('treats a genuine transport failure as not fetched, without retrying it one by one', async () => {
    const api = new MockApiFootball().on('fixtures', () => ({ status: 500 }));
    const { provider } = testProvider(api);
    const res = await provider.getFixtureDetails(['1', '2'], () => Number.POSITIVE_INFINITY);

    expect(res.notFetched.sort()).toEqual(['1', '2']);
    expect(res.details).toEqual([]);
    // One batched attempt, then it gives up on those ids rather than spending two more requests.
    expect(api.callsTo('fixtures')).toHaveLength(1);
  });

  it('stops once the daily budget is gone instead of attempting every remaining fixture', async () => {
    const api = refusingApi();
    const { provider } = testProvider(api, { config: { dailyBudget: 3 } });
    const ids = ['1', '2', '3', '4', '5', '6'];
    const res = await provider.getFixtureDetails(ids, () => Number.POSITIVE_INFINITY);

    expect(api.callsTo('fixtures').length).toBeLessThanOrEqual(3);
    expect(res.details.length + res.notFetched.length).toBe(ids.length);
    expect(res.notFetched.length).toBeGreaterThan(0);
    expect(provider.requestStats().stoppedReason).toMatch(/budget/i);
  });
});

describe('seasons the plan will not list', () => {
  const SEASON_REFUSAL = { body: envelope([], { errors: { plan: 'Free plans do not have access to this season, try from 2022 to 2024.' } }) };
  const DATE_REFUSAL = { body: envelope([], { errors: { plan: 'Free plans do not have access to this date, try from 2026-11-06 to 2026-11-08.' } }) };
  const NOW = () => new Date('2026-11-07T12:00:00Z');
  const on = (date: string, id: number, league = 39) => ({
    ...FIXTURE,
    fixture: { ...(FIXTURE.fixture as object), id, date: `${date}T15:00:00+00:00` },
    league: { ...(FIXTURE.league as object), id: league, season: 2026 },
  });

  // Refuses the league+season listing, serves only 06-08 by date, as the free plan does.
  const planLimitedApi = () =>
    new MockApiFootball().on('fixtures', (p) => {
      if (p.season) return SEASON_REFUSAL;
      if (!p.date) return { body: envelope([]) };
      if (p.date < '2026-11-06' || p.date > '2026-11-08') return DATE_REFUSAL;
      // One Premier League fixture and one from another competition, to prove the filter works.
      return { body: envelope([on(p.date, Number(p.date.replace(/-/g, ''))), on(p.date, 999, 61)]) };
    });

  it('discovers the current season day by day when the season listing is refused', async () => {
    const api = planLimitedApi();
    const { provider } = testProvider(api, { now: NOW });
    const res = await provider.getFixtures({ competitionSourceId: '39', seasonSourceId: '2026' });

    expect(res.available).toBe(true);
    if (!res.available) return;
    // Yesterday, today and tomorrow are all inside the served window.
    expect(res.data).toHaveLength(3);
    // Fixtures from other competitions on the same days are discarded.
    expect(res.data.every((f) => f.competitionSourceId === '39')).toBe(true);
    expect(res.warnings.map((w) => w.code)).toContain('SEASON_LISTING_CLOSED');
  });

  it('stops asking for days the provider has said it will not serve', async () => {
    const api = new MockApiFootball().on('fixtures', (p) => {
      if (p.season) return SEASON_REFUSAL;
      // Only today is served; the window it names excludes the neighbours.
      if (p.date !== '2026-11-07') return { body: envelope([], { errors: { plan: 'Free plans do not have access to this date, try from 2026-11-07 to 2026-11-07.' } }) };
      return { body: envelope([on(p.date, 1)]) };
    });
    const { provider } = testProvider(api, { now: NOW });
    const res = await provider.getFixtures({ competitionSourceId: '39', seasonSourceId: '2026' });

    expect(res.available).toBe(true);
    const dates = api.callsTo('fixtures').filter((c) => c.params.date).map((c) => c.params.date);
    // Yesterday is tried and refused; the named window then rules tomorrow out without spending a request.
    expect(dates).toEqual(['2026-11-06', '2026-11-07']);
  });

  it('leaves a season the plan does list alone', async () => {
    const api = new MockApiFootball().on('fixtures', (p) => ({ body: envelope([on('2024-08-16', 7)]) }));
    const { provider } = testProvider(api, { now: NOW });
    const res = await provider.getFixtures({ competitionSourceId: '39', seasonSourceId: '2024' });

    expect(res.available).toBe(true);
    // One league+season request, no day-by-day walking.
    expect(api.callsTo('fixtures')).toHaveLength(1);
    expect(api.callsTo('fixtures')[0]!.params.season).toBe('2024');
  });

  it('reports a real failure rather than pretending the season is empty', async () => {
    const api = new MockApiFootball().on('fixtures', (p) => (p.season ? SEASON_REFUSAL : DATE_REFUSAL));
    const { provider } = testProvider(api, { now: () => new Date('2026-12-25T12:00:00Z') });
    const res = await provider.getFixtures({ competitionSourceId: '39', seasonSourceId: '2026' });

    expect(res.available).toBe(false);
    if (res.available) return;
    expect(res.reason).toMatch(/No day-by-day discovery was available/);
  });
});
