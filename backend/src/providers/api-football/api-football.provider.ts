import { API_FOOTBALL_EPL_LEAGUE_ID, API_FOOTBALL_SOURCE } from '../../config/api-football.js';
import type {
  DatasetRef,
  DetailsResult,
  IDataProvider,
  IEnrichmentProvider,
  ProviderAvailability,
  ProviderCompetition,
  ProviderMatch,
  ProviderMatchDetails,
  ProviderMatchTeamStats,
  ProviderPlayer,
  ProviderPlayerMatchStats,
  ProviderSeason,
  ProviderSeasonCoverage,
  ProviderStanding,
  ProviderTeam,
  ProviderTeamRef,
  RequestStats,
  SourceResult,
  SourceWarning,
} from '../types.js';
import { unavailable } from '../types.js';
import { type ApiFootballClient, type ClientResult, type Envelope, requestKey } from './client.js';
import { type FixtureElement, attachCardEvidence, parseElements, parseEvents, parseFixtures, parseInjuries, parseLeague, parseLineups, parsePlayerStats, parseSquads, parseStatistics } from './normalize.js';
import { z } from 'zod';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const API_FOOTBALL_TTL = {
  coverage: DAY,
  currentFixtures: 6 * HOUR,
  closedSeasonFixtures: Number.POSITIVE_INFINITY,
  injuries: 6 * HOUR,
  squads: 7 * DAY,
  teams: 7 * DAY,
} as const;
// API-Football accepts at most 20 fixture IDs per `fixtures?ids=` request.
export const FIXTURE_BATCH_SIZE = 20;

// "Free plans do not have access to the Ids parameter." A plan limit, not a transport failure.
function refusesIdsParameter(res: ClientResult): boolean {
  return !res.ok && res.code === 'PLAN' && /ids parameter/i.test(res.message);
}

// "Free plans do not have access to this season, try from 2022 to 2024." The league+season
// listing is closed, but `fixtures?date=` without a league is not, so the current season can
// still be discovered a day at a time.
function refusesSeason(reason: string): boolean {
  return /^PLAN:/.test(reason) && /access to this season/i.test(reason);
}

// "Free plans do not have access to this date, try from 2026-11-06 to 2026-11-08." The provider
// states its own window, so it is read rather than assumed.
const DATE_WINDOW = /try from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/;

// A finished day never changes; today and tomorrow still move.
function dateTtl(date: string, today: string): number {
  if (date < today) return 7 * DAY;
  return date === today ? 3 * HOUR : 6 * HOUR;
}

const TeamsSchema = z.object({ team: z.object({ id: z.number().int(), name: z.string(), code: z.string().nullable().optional(), country: z.string().nullable().optional() }) });

function fail<T>(result: Extract<ClientResult, { ok: false }>): SourceResult<T> {
  return { available: false, reason: `${result.code}: ${result.message}` };
}

// Speaks API-Football's REST API; the rest of Nexora sees only IDataProvider / IEnrichmentProvider.
export class ApiFootballProvider implements IDataProvider, IEnrichmentProvider {
  // Set when the plan refuses `fixtures?ids=`. Detected once, then every remaining fixture in
  // this run is fetched singly. Costs one wasted request per run unless
  // API_FOOTBALL_BATCH_FIXTURES=false says so up front.
  private idsParameterBlocked = false;

  readonly source = API_FOOTBALL_SOURCE;
  // Standings are not needed for enrichment and are deliberately not requested in this step.
  readonly capabilities = { matches: true, matchStats: true, players: true, playerStats: true, availability: true, standings: false };

  // The clock is injectable so day-window discovery can be tested at a fixed date.
  constructor(private readonly client: ApiFootballClient, private readonly now: () => Date = () => new Date()) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  requestStats(): RequestStats {
    return this.client.requestStats();
  }

  private params(dataset: DatasetRef): Record<string, string> {
    return { league: dataset.competitionSourceId, season: dataset.seasonSourceId };
  }

  // ---- Discovery ----

  async getSeasonCoverage(competitionSourceId: string): Promise<SourceResult<ProviderSeasonCoverage[]>> {
    const res = await this.client.get('leagues', { id: competitionSourceId }, { maxAgeMs: API_FOOTBALL_TTL.coverage, kind: 'discovery' });
    if (!res.ok) return fail(res);
    const warnings: SourceWarning[] = [];
    const league = parseLeague(res.envelope.response, warnings);
    if (!league) return { available: false, reason: `API-Football has no league ${competitionSourceId}` };
    return { available: true, data: league.seasons, warnings };
  }

  // Nexora never lists API-Football's whole catalogue; it only asks about the allowlisted league.
  async getCompetitions(): Promise<SourceResult<ProviderCompetition[]>> {
    const res = await this.client.get('leagues', { id: API_FOOTBALL_EPL_LEAGUE_ID }, { maxAgeMs: API_FOOTBALL_TTL.coverage, kind: 'discovery' });
    if (!res.ok) return fail(res);
    const warnings: SourceWarning[] = [];
    const league = parseLeague(res.envelope.response, warnings);
    const data = league ? [{ sourceId: API_FOOTBALL_EPL_LEAGUE_ID, code: `api-football-${API_FOOTBALL_EPL_LEAGUE_ID}`, name: league.name, country: league.country }] : [];
    return { available: true, data, warnings };
  }

  async getSeason(dataset: DatasetRef): Promise<SourceResult<ProviderSeason>> {
    const coverage = await this.getSeasonCoverage(dataset.competitionSourceId);
    if (!coverage.available) return coverage;
    const season = coverage.data.find((s) => s.seasonSourceId === dataset.seasonSourceId);
    if (!season) return { available: false, reason: `API-Football does not list season ${dataset.seasonSourceId} for league ${dataset.competitionSourceId}` };
    return { available: true, data: { sourceId: season.seasonSourceId, competitionSourceId: dataset.competitionSourceId, name: season.name, startDate: season.startDate, endDate: season.endDate }, warnings: coverage.warnings };
  }

  async getTeams(dataset: DatasetRef): Promise<SourceResult<ProviderTeam[]>> {
    const res = await this.client.get('teams', this.params(dataset), { maxAgeMs: API_FOOTBALL_TTL.teams, kind: 'discovery' });
    if (!res.ok) return fail(res);
    const warnings: SourceWarning[] = [];
    const teams = parseElements(TeamsSchema, res.envelope.response, 'MALFORMED_TEAM', warnings).map((t) => ({
      sourceId: String(t.team.id),
      name: t.team.name,
      shortName: t.team.code ?? null,
      country: t.team.country ?? null,
    }));
    return { available: true, data: teams, warnings };
  }

  // ---- Fixtures ----

  private async fixtures(params: Record<string, string>, maxAgeMs: number): Promise<SourceResult<ProviderMatch[]>> {
    const res = await this.client.getAll('fixtures', params, { maxAgeMs, kind: 'discovery' });
    if (!res.ok) return fail(res);
    const warnings: SourceWarning[] = [];
    return { available: true, data: parseFixtures(res.envelope.response, warnings).map((f) => f.match), warnings };
  }

  async getFixtures(dataset: DatasetRef, options: { from?: string; to?: string; maxAgeMs?: number } = {}): Promise<SourceResult<ProviderMatch[]>> {
    const window: Record<string, string> = options.from && options.to ? { from: options.from, to: options.to } : {};
    const direct = await this.fixtures({ ...this.params(dataset), ...window }, options.maxAgeMs ?? API_FOOTBALL_TTL.currentFixtures);
    if (direct.available || !refusesSeason(direct.reason)) return direct;
    // The season listing is closed to this plan. Discover what is reachable instead of giving up:
    // only the days the provider still serves, which is enough to keep a live season current.
    return this.fixturesByServedDates(dataset, direct.reason);
  }

  // Walks the days around now, asking for every fixture on each and keeping this competition's.
  // `fixtures?date=` carries no league filter on a free plan, so the filtering happens here.
  private async fixturesByServedDates(dataset: DatasetRef, seasonRefusal: string): Promise<SourceResult<ProviderMatch[]>> {
    const now = this.now();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = iso(now);
    const candidates = [-1, 0, 1].map((offset) => iso(new Date(now.getTime() + offset * DAY)));

    const found = new Map<string, ProviderMatch>();
    const warnings: SourceWarning[] = [];
    const refusals: string[] = [];
    let answered = 0;
    let served: { from: string; to: string } | null = null;

    for (const date of candidates) {
      // Once the provider has named its window, days outside it are skipped rather than spent.
      if (served && (date < served.from || date > served.to)) continue;
      const res = await this.client.getAll('fixtures', { date }, { maxAgeMs: dateTtl(date, today), kind: 'discovery' });
      if (!res.ok) {
        const match = DATE_WINDOW.exec(res.message);
        if (match) served = { from: match[1]!, to: match[2]! };
        refusals.push(`${date}: ${res.code}`);
        continue;
      }
      answered += 1;
      for (const parsed of parseFixtures(res.envelope.response, warnings)) {
        if (parsed.match.competitionSourceId === dataset.competitionSourceId) found.set(parsed.match.sourceId, parsed.match);
      }
    }

    // A day that answered and held no fixture is real information; a day never served is not.
    // Reporting "no fixtures" when every day was out of reach would look like an empty season.
    if (answered === 0) {
      const detail = refusals.length > 0 ? refusals.join('; ') : `no day between ${candidates[0]} and ${candidates[candidates.length - 1]} is inside the served window${served ? ` (${served.from} to ${served.to})` : ''}`;
      return { available: false, reason: `${seasonRefusal} No day-by-day discovery was available either (${detail}).` };
    }
    warnings.push({
      code: 'SEASON_LISTING_CLOSED',
      message: `The plan does not list league ${dataset.competitionSourceId} season ${dataset.seasonSourceId}, so only fixtures on the days the provider still serves${served ? ` (${served.from} to ${served.to})` : ''} were discovered: ${found.size}.`,
    });
    return { available: true, data: [...found.values()], warnings };
  }

  getMatches(dataset: DatasetRef): Promise<SourceResult<ProviderMatch[]>> {
    return this.getFixtures(dataset);
  }

  getFixturesByDate(dataset: DatasetRef, date: string): Promise<SourceResult<ProviderMatch[]>> {
    return this.fixtures({ ...this.params(dataset), date }, API_FOOTBALL_TTL.currentFixtures);
  }

  getUpcomingFixtures(dataset: DatasetRef, count: number): Promise<SourceResult<ProviderMatch[]>> {
    return this.fixtures({ ...this.params(dataset), next: String(Math.min(Math.max(count, 1), 50)) }, API_FOOTBALL_TTL.currentFixtures);
  }

  getFinishedFixtures(dataset: DatasetRef): Promise<SourceResult<ProviderMatch[]>> {
    return this.fixtures({ ...this.params(dataset), status: 'FT-AET-PEN' }, API_FOOTBALL_TTL.currentFixtures);
  }

  async getMatch(_dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderMatch | null>> {
    const res = await this.client.get('fixtures', { id: matchSourceId }, { maxAgeMs: API_FOOTBALL_TTL.currentFixtures, kind: 'detail' });
    if (!res.ok) return fail(res);
    const warnings: SourceWarning[] = [];
    return { available: true, data: parseFixtures(res.envelope.response, warnings)[0]?.match ?? null, warnings };
  }

  // ---- Fixture details: one `fixtures?ids=` request returns events, lineups, statistics and players for up to 20 fixtures.

  static detailsFromElement(element: FixtureElement, match: ProviderMatch, fetchedAt: Date): ProviderMatchDetails {
    const warnings: SourceWarning[] = [];
    const section = (value: unknown): unknown[] | null => (Array.isArray(value) && value.length > 0 ? value : null);
    const statistics = section(element.statistics);
    const events = section(element.events);
    const lineupsRaw = section(element.lineups);
    const players = section(element.players);
    const lineups = lineupsRaw ? parseLineups(lineupsRaw, warnings) : null;
    const parsedEvents = events ? parseEvents(events, match, warnings) : null;
    const stats = statistics ? parseStatistics(statistics, match, warnings) : null;
    if (stats) attachCardEvidence(stats, parsedEvents, match, warnings);
    return {
      match,
      fetchedAt,
      stats,
      events: parsedEvents,
      lineups,
      players: players ? parsePlayerStats(players, match, lineups, warnings) : null,
      warnings,
    };
  }

  async getFixtureDetails(matchSourceIds: readonly string[], maxAgeMs: (matchSourceId: string) => number): Promise<DetailsResult> {
    const details: ProviderMatchDetails[] = [];
    const missing: string[] = [];
    const ids = [...new Set(matchSourceIds)].sort((a, b) => Number(a) - Number(b));
    let hits = 0;
    for (const id of ids) {
      const cached = await this.client.peek(requestKey('fixtures', { id }), maxAgeMs(id));
      const parsed = cached ? this.detailsFrom(cached.envelope, cached.fetchedAt).find((d) => d.match.sourceId === id) : undefined;
      if (parsed) {
        details.push(parsed);
        hits += 1;
      } else missing.push(id);
    }
    await this.client.recordCacheUse(hits, missing.length);

    const notFetched: string[] = [];
    // Caches one fixture under its own key, so a later run can mix cached and fresh fixtures
    // regardless of how this one happened to fetch them.
    const keep = async (id: string, element: unknown, fetchedAt: Date): Promise<boolean> => {
      const envelope: Envelope = { errors: [], results: 1, paging: { current: 1, total: 1 }, response: [element] };
      await this.client.store(requestKey('fixtures', { id }), envelope, fetchedAt);
      const parsed = this.detailsFrom(envelope, fetchedAt)[0];
      if (!parsed) return false;
      details.push(parsed);
      return true;
    };

    let index = 0;
    while (index < missing.length) {
      // Once the run has stopped (budget, rate limit, rejected key) the rest are reported as
      // not fetched rather than attempted one by one.
      if (this.client.requestStats().stoppedReason) {
        notFetched.push(...missing.slice(index));
        break;
      }

      if (this.idsParameterBlocked || !this.client.batchingAllowed()) {
        const id = missing[index]!;
        const res = await this.client.fetchUncached('fixtures', { id }, 'detail');
        const element = res.ok ? res.envelope.response[0] : undefined;
        if (!element || !(await keep(id, element, res.ok ? res.fetchedAt : new Date()))) notFetched.push(id);
        index += 1;
        continue;
      }

      const batch = missing.slice(index, index + FIXTURE_BATCH_SIZE);
      // The batch itself is never cached: its content is stored per fixture below, so later runs can mix and match.
      const res = await this.client.fetchUncached('fixtures', { ids: batch.join('-') }, 'detail');
      if (!res.ok) {
        // Plans without the `ids` parameter are not a failure, only a different shape of request:
        // retry the very same fixtures singly instead of losing them. A single fixture carries
        // statistics, events, line-ups and player statistics in one response, so the fallback
        // costs one request per fixture rather than four.
        if (refusesIdsParameter(res)) {
          this.idsParameterBlocked = true;
          continue;
        }
        notFetched.push(...batch);
        index += batch.length;
        continue;
      }
      const byId = new Map<string, unknown>();
      for (const element of res.envelope.response) {
        const id = (element as { fixture?: { id?: unknown } })?.fixture?.id;
        if (typeof id === 'number') byId.set(String(id), element);
      }
      for (const id of batch) {
        const element = byId.get(id);
        if (!element || !(await keep(id, element, res.fetchedAt))) notFetched.push(id);
      }
      index += batch.length;
    }
    return { details, notFetched };
  }

  private detailsFrom(envelope: Envelope, fetchedAt: Date): ProviderMatchDetails[] {
    const warnings: SourceWarning[] = [];
    return parseFixtures(envelope.response, warnings).map(({ match, raw }) => {
      const d = ApiFootballProvider.detailsFromElement(raw, match, fetchedAt);
      return { ...d, warnings: [...warnings, ...d.warnings] };
    });
  }

  async getMatchStats(_dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderMatchTeamStats[]>> {
    const { details } = await this.getFixtureDetails([matchSourceId], () => API_FOOTBALL_TTL.currentFixtures);
    const d = details[0];
    if (!d) return { available: false, reason: `API-Football returned no details for fixture ${matchSourceId}` };
    return d.stats ? { available: true, data: d.stats, warnings: d.warnings } : { available: false, reason: `API-Football has no statistics for fixture ${matchSourceId}` };
  }

  async getPlayerStats(_dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderPlayerMatchStats[]>> {
    const { details } = await this.getFixtureDetails([matchSourceId], () => API_FOOTBALL_TTL.currentFixtures);
    const d = details[0];
    if (!d?.players) return { available: false, reason: `API-Football has no player statistics for fixture ${matchSourceId}` };
    return { available: true, data: d.players.flatMap((g) => g.players), warnings: d.warnings };
  }

  // ---- Availability ----

  async getInjuries(dataset: DatasetRef, maxAgeMs: number): Promise<SourceResult<ReturnType<typeof parseInjuries>>> {
    const res = await this.client.getAll('injuries', this.params(dataset), { maxAgeMs, kind: 'discovery' });
    if (!res.ok) return fail(res);
    const warnings: SourceWarning[] = [];
    return { available: true, data: parseInjuries(res.envelope.response, res.fetchedAt, warnings), warnings };
  }

  async getPlayerAvailability(_dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderAvailability[]>> {
    const res = await this.client.get('injuries', { fixture: matchSourceId }, { maxAgeMs: API_FOOTBALL_TTL.injuries, kind: 'detail' });
    if (!res.ok) return fail(res);
    const warnings: SourceWarning[] = [];
    return {
      available: true,
      data: parseInjuries(res.envelope.response, res.fetchedAt, warnings).map((r) => ({ playerSourceId: r.player.sourceId, status: r.status, reason: r.reason, expectedReturn: r.expectedReturn, reportedAt: r.reportedAt })),
      warnings,
    };
  }

  // ---- Players ----

  async getSquad(teamSourceId: string): Promise<SourceResult<ProviderPlayer[]>> {
    const res = await this.client.get('players/squads', { team: teamSourceId }, { maxAgeMs: API_FOOTBALL_TTL.squads, kind: 'detail' });
    if (!res.ok) return fail(res);
    const warnings: SourceWarning[] = [];
    return { available: true, data: parseSquads(res.envelope.response, warnings), warnings };
  }

  async getPlayers(_dataset: DatasetRef, team: ProviderTeamRef): Promise<SourceResult<ProviderPlayer[]>> {
    if (!team.sourceId) return { available: false, reason: 'API-Football squads are requested by team ID' };
    return this.getSquad(team.sourceId);
  }

  async getStandings(): Promise<SourceResult<ProviderStanding[]>> {
    return unavailable(this.source, 'standings in this version of Nexora');
  }
}
