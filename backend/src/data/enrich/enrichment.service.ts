import { Prisma, type DataEnvironment, type PrismaClient } from '@prisma/client';
import { API_FOOTBALL_EPL_LEAGUE_ID } from '../../config/api-football.js';
import type {
  CoverageDataset,
  IEnrichmentProvider,
  ProviderFixturePlayerStats,
  ProviderInjuryReport,
  ProviderMatch,
  ProviderMatchDetails,
  ProviderMatchTeamStats,
  ProviderPlayer,
  ProviderPosition,
  ProviderSeasonCoverage,
  ProviderTeamRef,
  RequestStats,
  SourceWarning,
} from '../../providers/types.js';
import { COVERAGE_DATASETS } from '../../providers/types.js';
import { STAT_NULL_POLICY_VERSION } from '../../providers/api-football/normalize.js';
import { CURATED_TEAMS, CURATED_SOURCE, type CuratedTeam } from '../identity/curated-teams.js';
import { normalizeTeamName, syncCuratedTeams } from '../identity/team-identity.js';
import { IMPORTABLE_DATASETS, type ImportableDataset } from '../import/catalog.js';
import {
  type AliasRow,
  type CandidateMatch,
  type FixtureMatch,
  type ResolvedTeam,
  type ResultComparison,
  type UnresolvedFixture,
  type UnresolvedProviderTeam,
  compareResult,
  matchFixtures,
  resolveProviderTeams,
} from './fixture-matching.js';

type Db = PrismaClient | Prisma.TransactionClient;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Providers correct statistics and events shortly after full time; after this they are treated as settled.
export const REFRESH_WINDOW_MS = 72 * HOUR;
const REFRESH_MIN_AGE_MS = 6 * HOUR;
// A dataset the provider refused (e.g. not in the plan) is not asked for again until this has passed.
const BLOCKED_RECHECK_MS = 7 * DAY;
const SQUAD_LOOKAHEAD_MS = 14 * DAY;
const MAX_STORED_WARNINGS = 500;

export const ENRICHMENT_TYPES = ['stats', 'events', 'lineups', 'players', 'injuries'] as const;
export type EnrichmentType = (typeof ENRICHMENT_TYPES)[number];

// The enrichment source's competitions that Nexora may enrich, and the backbone competition each belongs to.
const BACKBONE: Readonly<Record<string, { source: string; competitionSourceId: string }>> = {
  [API_FOOTBALL_EPL_LEAGUE_ID]: { source: 'openfootball', competitionSourceId: 'en.1' },
  // Confirmed against live fixture data, not assumed.
  '140': { source: 'openfootball', competitionSourceId: 'es.1' },
  '78': { source: 'openfootball', competitionSourceId: 'de.1' },
  '135': { source: 'openfootball', competitionSourceId: 'it.1' },
  '61': { source: 'openfootball', competitionSourceId: 'fr.1' },
};

export interface EnrichmentRequest {
  competitionSourceId: string;
  seasonSourceId: string;
  dataEnvironment?: DataEnvironment;
  from?: string;
  to?: string;
  types?: readonly EnrichmentType[];
  // Cap on fixtures whose post-match details are requested (small verification runs); the most recent come first.
  maxDetails?: number;
  // How many squad listings this run may request. Squads are the only affordable source of player
  // positions for a season already played: per-match lineups cost one request per fixture, which a
  // metered key cannot cover for a whole season. Absent, only clubs with a match about to kick off
  // are asked for, which is right for keeping the current season fresh and useless for a backfill.
  maxSquads?: number;
}

export interface BackboneSeason {
  dataset: ImportableDataset;
  seasonKey: string;
}

// API-Football names a season by its starting year (2026 → 2026/27 → openfootball "2026-27").
export function backboneSeasonFor(competitionSourceId: string, seasonSourceId: string): BackboneSeason | null {
  const backbone = BACKBONE[competitionSourceId];
  const year = Number(seasonSourceId);
  if (!backbone || !Number.isInteger(year)) return null;
  const seasonId = `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
  const dataset = IMPORTABLE_DATASETS.find((d) => d.source === backbone.source && d.competitionSourceId === backbone.competitionSourceId && d.seasonSourceId === seasonId);
  return dataset ? { dataset, seasonKey: `${dataset.competitionSourceId}/${dataset.seasonSourceId}` } : null;
}

export function enrichableSeasons(): Array<{ competitionSourceId: string; seasonSourceId: string; dataEnvironment: DataEnvironment }> {
  return Object.keys(BACKBONE).flatMap((league) =>
    IMPORTABLE_DATASETS.filter((d) => d.source === BACKBONE[league]!.source && d.competitionSourceId === BACKBONE[league]!.competitionSourceId).map((d) => ({
      competitionSourceId: league,
      seasonSourceId: d.seasonSourceId.slice(0, 4),
      dataEnvironment: d.dataEnvironment,
    })),
  );
}

export interface EnrichmentCounts {
  fixturesDiscovered: number;
  fixturesMatched: number;
  fixturesUnresolved: number;
  linksCreated: number;
  linksUpdated: number;
  aliasesBound: number;
  detailsRequested: number;
  detailsReceived: number;
  statsAvailable: number;
  statsUnavailable: number;
  statsCreated: number;
  statsFilled: number;
  statsUpdated: number;
  eventsImported: number;
  lineupsImported: number;
  playersCreated: number;
  playersUpdated: number;
  playerStatsCreated: number;
  playerStatsFilled: number;
  injuriesDiscovered: number;
  suspensionsDiscovered: number;
  doubtfulDiscovered: number;
  unknownStatusDiscovered: number;
  availabilityImported: number;
  skipped: number;
  conflicts: number;
  errors: number;
}

const emptyCounts = (): EnrichmentCounts => ({
  fixturesDiscovered: 0,
  fixturesMatched: 0,
  fixturesUnresolved: 0,
  linksCreated: 0,
  linksUpdated: 0,
  aliasesBound: 0,
  detailsRequested: 0,
  detailsReceived: 0,
  statsAvailable: 0,
  statsUnavailable: 0,
  statsCreated: 0,
  statsFilled: 0,
  statsUpdated: 0,
  eventsImported: 0,
  lineupsImported: 0,
  playersCreated: 0,
  playersUpdated: 0,
  playerStatsCreated: 0,
  playerStatsFilled: 0,
  injuriesDiscovered: 0,
  suspensionsDiscovered: 0,
  doubtfulDiscovered: 0,
  unknownStatusDiscovered: 0,
  availabilityImported: 0,
  skipped: 0,
  conflicts: 0,
  errors: 0,
});

export interface PreparedEnrichment {
  source: string;
  request: EnrichmentRequest;
  types: ReadonlySet<EnrichmentType>;
  backbone: BackboneSeason;
  dataEnvironment: DataEnvironment;
  competitionId: string;
  seasonId: string;
  preparedAt: Date;
  season: ProviderSeasonCoverage | null;
  // Datasets that will not be requested, with the reason (provider coverage flag, plan refusal, earlier refusal).
  unavailable: Map<CoverageDataset, string>;
  // Refusals learned during this run, persisted so later runs do not repeat the request.
  refused: Map<CoverageDataset, string>;
  // Refusals recorded by earlier runs; their rows are left untouched so the recheck window runs from the refusal.
  blockedEarlier: Set<CoverageDataset>;
  fixtures: ProviderMatch[];
  teams: Map<string, ResolvedTeam>;
  unresolvedTeams: UnresolvedProviderTeam[];
  matched: Array<FixtureMatch & { comparison: ResultComparison }>;
  unresolved: UnresolvedFixture[];
  linkIdsBySourceId: Map<string, { id: string; detailsFetchedAt: Date | null }>;
  details: ProviderMatchDetails[];
  detailsRequested: string[];
  detailsNotFetched: string[];
  injuries: ProviderInjuryReport[] | null;
  squadPlayers: ProviderPlayer[];
  fatal: string | null;
  warnings: SourceWarning[];
  requestStats: RequestStats;
}

export interface EnrichmentSummary {
  status: 'COMPLETED' | 'FAILED' | 'NOT_CONFIGURED' | 'DRY_RUN';
  importRunId: string | null;
  source: string;
  dataset: string;
  dataEnvironment: DataEnvironment | null;
  counts: EnrichmentCounts;
  requests: { made: number; cacheHits: number; cacheMisses: number; errors: number; rateLimited: number; planned: string[]; stoppedReason: string | null };
  unavailable: Record<string, string>;
  unresolvedTeams: UnresolvedProviderTeam[];
  unresolvedFixtures: Array<{ sourceId: string; home: string; away: string; kickoff: string; reason: string; detail: string }>;
  conflicts: Array<{ sourceId: string; matchId: string; detail: unknown }>;
  // A few fixtures with provider values beside Nexora's normalised values, for verifying field mappings.
  samples: Array<{ sourceId: string; matchId: string | null; fixture: string; stats: unknown[]; events: Record<string, number>; players: number; lineups: number }>;
  warningCounts: Record<string, number>;
  errorMessage: string | null;
}

function countWarnings(warnings: readonly SourceWarning[]): Record<string, number> {
  return warnings.reduce<Record<string, number>>((acc, w) => ({ ...acc, [w.code]: (acc[w.code] ?? 0) + 1 }), {});
}

// PostgreSQL jsonb does not keep key order, so stored and incoming documents are compared with sorted keys.
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const STAT_FIELDS = ['goals', 'possession', 'shots', 'shotsOnTarget', 'corners', 'yellowCards', 'redCards', 'fouls', 'offsides', 'shotsOffTarget', 'blockedShots', 'goalkeeperSaves', 'passes', 'passesAccurate', 'passAccuracy'] as const;
type StatField = (typeof STAT_FIELDS)[number];
const PLAYER_FIELDS = ['goals', 'assists', 'shots', 'shotsOnTarget', 'passes', 'tackles', 'interceptions', 'yellowCards', 'redCards', 'rating', 'fouls'] as const;
type PlayerField = (typeof PLAYER_FIELDS)[number];

// Incoming nulls never erase a stored value. Differing known values are updated only while the source may still be
// correcting itself (same source, inside the refresh window); otherwise the stored value stays and a conflict is reported.
export function mergeValues<K extends string>(
  existing: Record<K, number | null>,
  incoming: Partial<Record<K, number | null | undefined>>,
  fields: readonly K[],
  allowUpdate: boolean,
): { changes: Partial<Record<K, number>>; filled: K[]; updated: K[]; conflicts: K[] } {
  const changes: Partial<Record<K, number>> = {};
  const filled: K[] = [];
  const updated: K[] = [];
  const conflicts: K[] = [];
  for (const field of fields) {
    const next = incoming[field];
    if (next === null || next === undefined) continue;
    const current = existing[field];
    if (current === null) {
      changes[field] = next;
      filled.push(field);
    } else if (current !== next) {
      if (allowUpdate) {
        changes[field] = next;
        updated.push(field);
      } else conflicts.push(field);
    }
  }
  return { changes, filled, updated, conflicts };
}

export class EnrichmentService {
  constructor(
    private readonly db: Db,
    private readonly provider: IEnrichmentProvider,
    private readonly curatedTeams: readonly CuratedTeam[] = CURATED_TEAMS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Runs inside the caller's transaction when given one (tests), otherwise opens its own.
  private inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const client = this.db as { $transaction?: unknown };
    return typeof client.$transaction === 'function' ? (this.db as PrismaClient).$transaction(fn, { timeout: 300_000, maxWait: 10_000 }) : fn(this.db as Prisma.TransactionClient);
  }

  private defaultTypes(env: DataEnvironment): EnrichmentType[] {
    // Injury lists fetched after the fact can never inform a past forecast, so closed seasons skip them unless asked.
    return env === 'LIVE' ? [...ENRICHMENT_TYPES] : ['stats', 'events', 'lineups', 'players'];
  }

  async run(request: EnrichmentRequest, options: { dryRun?: boolean } = {}): Promise<EnrichmentSummary> {
    const backbone = backboneSeasonFor(request.competitionSourceId, request.seasonSourceId);
    const dataset = `${request.competitionSourceId}/${request.seasonSourceId}`;
    if (!backbone) throw new Error(`${this.provider.source} ${dataset} is not an enrichable season (allowed: ${enrichableSeasons().map((s) => `${s.competitionSourceId}/${s.seasonSourceId}`).join(', ')})`);
    if (!this.provider.isConfigured()) {
      return this.summary('NOT_CONFIGURED', null, dataset, backbone.dataset.dataEnvironment, emptyCounts(), null, 'API_FOOTBALL_KEY is not configured; enrichment skipped. OpenFootball data is unaffected.');
    }

    if (options.dryRun) {
      const prepared = await this.prepare(this.db, request);
      return this.summary('DRY_RUN', null, dataset, prepared.dataEnvironment, this.previewCounts(prepared), prepared, prepared.fatal);
    }

    const run = await this.db.importRun.create({ data: { source: this.provider.source, dataset, dataEnvironment: backbone.dataset.dataEnvironment, status: 'RUNNING' } });
    let prepared: PreparedEnrichment | null = null;
    try {
      prepared = await this.prepare(this.db, request);
      const p = prepared;
      const counts = await this.inTransaction((tx) => this.apply(tx, p));
      const status = p.fatal ? 'FAILED' : 'COMPLETED';
      const summary = this.summary(status, run.id, dataset, p.dataEnvironment, counts, p, p.fatal);
      await this.finishRun(run.id, summary, p.warnings);
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const counts = emptyCounts();
      counts.errors = 1;
      const summary = this.summary('FAILED', run.id, dataset, backbone.dataset.dataEnvironment, counts, prepared, message);
      await this.finishRun(run.id, summary, prepared?.warnings ?? []);
      return summary;
    }
  }

  private async finishRun(id: string, summary: EnrichmentSummary, warnings: readonly SourceWarning[]): Promise<void> {
    await this.db.importRun.update({
      where: { id },
      data: {
        status: summary.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
        completedAt: this.now(),
        errorMessage: summary.errorMessage,
        counts: {
          provider: summary.source,
          competition: summary.dataset.split('/')[0],
          season: summary.dataset.split('/')[1],
          ...summary.counts,
          requests: summary.requests.made,
          cacheHits: summary.requests.cacheHits,
          cacheMisses: summary.requests.cacheMisses,
          rateLimited: summary.requests.rateLimited,
          requestErrors: summary.requests.errors,
          plannedRequests: summary.requests.planned.length,
          stoppedReason: summary.requests.stoppedReason,
          unavailable: summary.unavailable,
          unresolvedTeams: summary.unresolvedTeams,
          unresolvedFixtures: summary.unresolvedFixtures.slice(0, 100),
          conflictDetails: summary.conflicts.slice(0, 100),
          warningCounts: summary.warningCounts,
        } as unknown as Prisma.InputJsonValue,
        warnings: warnings.slice(0, MAX_STORED_WARNINGS) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private summary(
    status: EnrichmentSummary['status'],
    importRunId: string | null,
    dataset: string,
    dataEnvironment: DataEnvironment | null,
    counts: EnrichmentCounts,
    prepared: PreparedEnrichment | null,
    errorMessage: string | null,
  ): EnrichmentSummary {
    const stats = this.provider.requestStats();
    return {
      status,
      importRunId,
      source: this.provider.source,
      dataset,
      dataEnvironment,
      counts,
      requests: { made: stats.requests, cacheHits: stats.cacheHits, cacheMisses: stats.cacheMisses, errors: stats.errors, rateLimited: stats.rateLimited, planned: stats.planned, stoppedReason: stats.stoppedReason },
      unavailable: Object.fromEntries(prepared?.unavailable ?? []),
      unresolvedTeams: prepared?.unresolvedTeams ?? [],
      unresolvedFixtures: (prepared?.unresolved ?? []).map((u) => ({
        sourceId: u.fixture.sourceId,
        home: u.fixture.homeTeam.name,
        away: u.fixture.awayTeam.name,
        kickoff: u.fixture.kickoff.toISOString(),
        reason: u.reason,
        detail: u.detail,
      })),
      conflicts: (prepared?.matched ?? []).filter((m) => m.comparison.conflict).map((m) => ({ sourceId: m.fixture.sourceId, matchId: m.match.id, detail: m.comparison.conflict })),
      samples: (prepared?.details ?? []).slice(0, 3).map((d) => ({
        sourceId: d.match.sourceId,
        matchId: prepared!.matched.find((m) => m.fixture.sourceId === d.match.sourceId)?.match.id ?? null,
        fixture: `${d.match.homeTeam.name} v ${d.match.awayTeam.name} ${d.match.kickoff.toISOString()} ${d.match.status} ${d.match.homeScore ?? '-'}-${d.match.awayScore ?? '-'}`,
        stats: (d.stats ?? []).map((s) => ({ team: s.teamName, raw: s.raw ?? {}, normalized: Object.fromEntries(STAT_FIELDS.map((f) => [f, s[f] ?? null])), additional: s.additional ?? {}, derivedFromEvents: s.derived ?? null })),
        events: (d.events ?? []).reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {}),
        players: (d.players ?? []).reduce((n, g) => n + g.players.length, 0),
        lineups: d.lineups?.length ?? 0,
      })),
      warningCounts: countWarnings(prepared?.warnings ?? []),
      errorMessage,
    };
  }

  // What a dry-run can say without writing: discovered, matched, what is cached and what would be requested.
  private previewCounts(p: PreparedEnrichment): EnrichmentCounts {
    const counts = emptyCounts();
    counts.fixturesDiscovered = p.fixtures.length;
    counts.fixturesMatched = p.matched.length;
    counts.fixturesUnresolved = p.unresolved.length;
    counts.linksCreated = p.matched.filter((m) => !p.linkIdsBySourceId.has(m.fixture.sourceId)).length;
    counts.conflicts = p.matched.filter((m) => m.comparison.conflict).length;
    counts.detailsRequested = p.detailsRequested.length;
    counts.detailsReceived = p.details.length;
    counts.statsAvailable = p.details.filter((d) => d.stats && d.stats.length > 0).length;
    counts.statsUnavailable = p.details.filter((d) => !d.stats || d.stats.length === 0).length;
    counts.eventsImported = p.details.reduce((s, d) => s + (d.events?.length ?? 0), 0);
    counts.lineupsImported = p.details.reduce((s, d) => s + (d.lineups?.length ?? 0), 0);
    counts.playerStatsCreated = p.details.reduce((s, d) => s + (d.players?.reduce((t, g) => t + g.players.length, 0) ?? 0), 0);
    this.countInjuries(counts, p.injuries ?? []);
    return counts;
  }

  private countInjuries(counts: EnrichmentCounts, reports: readonly ProviderInjuryReport[]): void {
    for (const r of reports) {
      if (r.status === 'INJURED') counts.injuriesDiscovered += 1;
      else if (r.status === 'SUSPENDED') counts.suspensionsDiscovered += 1;
      else if (r.status === 'DOUBTFUL') counts.doubtfulDiscovered += 1;
      else counts.unknownStatusDiscovered += 1;
    }
  }

  // Network and reads only; no database writes (the dry-run relies on this).
  async prepare(db: Db, request: EnrichmentRequest): Promise<PreparedEnrichment> {
    const backbone = backboneSeasonFor(request.competitionSourceId, request.seasonSourceId);
    if (!backbone) throw new Error(`${request.competitionSourceId}/${request.seasonSourceId} is not an enrichable season`);
    const env = backbone.dataset.dataEnvironment;
    if (env === 'SYNTHETIC') throw new Error('SYNTHETIC data is never enriched with real provider data');
    if (request.dataEnvironment && request.dataEnvironment !== env) {
      throw new Error(`Season ${request.seasonSourceId} is stored as ${env}; refusing to treat it as ${request.dataEnvironment}`);
    }
    const season = await db.season.findUnique({ where: { source_sourceId: { source: backbone.dataset.source, sourceId: backbone.seasonKey } } });
    if (!season) throw new Error(`Backbone season ${backbone.seasonKey} has not been imported yet; run the OpenFootball import first`);

    const source = this.provider.source;
    const preparedAt = this.now();
    const warnings: SourceWarning[] = [];
    const types = new Set(request.types && request.types.length > 0 ? request.types : this.defaultTypes(env));
    const ref = { competitionSourceId: request.competitionSourceId, seasonSourceId: request.seasonSourceId };
    const unavailable = new Map<CoverageDataset, string>();
    const refused = new Map<CoverageDataset, string>();
    const prepared: PreparedEnrichment = {
      source,
      request,
      types,
      backbone,
      dataEnvironment: env,
      competitionId: season.competitionId,
      seasonId: season.id,
      preparedAt,
      season: null,
      unavailable,
      refused,
      blockedEarlier: new Set(),
      fixtures: [],
      teams: new Map(),
      unresolvedTeams: [],
      matched: [],
      unresolved: [],
      linkIdsBySourceId: new Map(),
      details: [],
      detailsRequested: [],
      detailsNotFetched: [],
      injuries: null,
      squadPlayers: [],
      fatal: null,
      warnings,
      requestStats: this.provider.requestStats(),
    };
    const finish = (fatal: string | null = null): PreparedEnrichment => {
      prepared.fatal = fatal;
      prepared.requestStats = this.provider.requestStats();
      return prepared;
    };
    const refuse = (dataset: CoverageDataset, reason: string) => {
      if (reason.startsWith('PLAN')) refused.set(dataset, reason);
      unavailable.set(dataset, reason);
    };

    // 1. Coverage first: never request a dataset the provider says it does not have, or refused recently.
    const blocked = await db.providerCoverage.findMany({
      where: { source, competitionSourceId: ref.competitionSourceId, seasonSourceId: ref.seasonSourceId, available: false, checkedAt: { gte: new Date(preparedAt.getTime() - BLOCKED_RECHECK_MS) }, reason: { startsWith: 'PLAN' } },
    });
    for (const b of blocked) {
      unavailable.set(b.dataset as CoverageDataset, `${b.reason} (recorded ${b.checkedAt.toISOString()})`);
      prepared.blockedEarlier.add(b.dataset as CoverageDataset);
    }

    const coverage = await this.provider.getSeasonCoverage(ref.competitionSourceId);
    if (!coverage.available) return finish(`Coverage check failed: ${coverage.reason}`);
    warnings.push(...coverage.warnings);
    const seasonCoverage = coverage.data.find((s) => s.seasonSourceId === ref.seasonSourceId) ?? null;
    prepared.season = seasonCoverage;
    if (!seasonCoverage) {
      for (const d of COVERAGE_DATASETS) unavailable.set(d, 'Season not offered by the provider');
      return finish(`${source} does not offer season ${ref.seasonSourceId} for league ${ref.competitionSourceId}`);
    }
    for (const d of COVERAGE_DATASETS) if (!seasonCoverage.coverage[d] && !unavailable.has(d)) unavailable.set(d, 'Provider coverage flag is false');
    if (unavailable.has('fixtures')) return finish(`Fixtures unavailable: ${unavailable.get('fixtures')}`);

    // 2. Fixture list. Closed seasons never change, so their list is cached indefinitely.
    const closed = !seasonCoverage.current && seasonCoverage.endDate.getTime() < preparedAt.getTime() - 14 * DAY;
    const window = request.from && request.to ? { from: request.from, to: request.to } : {};
    const fixtures = await this.provider.getFixtures(ref, { ...window, maxAgeMs: closed ? Number.POSITIVE_INFINITY : 6 * HOUR });
    if (!fixtures.available) {
      refuse('fixtures', fixtures.reason);
      return finish(`Fixture list unavailable: ${fixtures.reason}`);
    }
    warnings.push(...fixtures.warnings);
    prepared.fixtures = fixtures.data.filter((f) => f.competitionSourceId === ref.competitionSourceId && f.seasonSourceId === ref.seasonSourceId);

    // 3. Injuries (league-season list; one request, occasionally paged).
    if (types.has('injuries') && !unavailable.has('injuries')) {
      const injuries = await this.provider.getInjuries(ref, 6 * HOUR);
      if (injuries.available) {
        warnings.push(...injuries.warnings);
        prepared.injuries = injuries.data;
      } else refuse('injuries', injuries.reason);
    }

    // 4. Team identity.
    const refs: ProviderTeamRef[] = [...prepared.fixtures.flatMap((f) => [f.homeTeam, f.awayTeam]), ...(prepared.injuries ?? []).map((i) => i.team)];
    const { resolved, unresolved: unresolvedTeams } = resolveProviderTeams(await this.aliasRows(db, source), refs);
    prepared.teams = resolved;
    prepared.unresolvedTeams = unresolvedTeams;
    for (const u of unresolvedTeams) warnings.push({ code: 'TEAM_UNRESOLVED', sourceId: u.sourceTeamId ?? undefined, message: `${u.name}: ${u.reason}` });

    // 5. Fixture matching against the backbone's matches in this season only.
    const candidates: CandidateMatch[] = await db.match.findMany({
      where: { seasonId: season.id, source: backbone.dataset.source, dataEnvironment: { in: ['HISTORICAL', 'LIVE'] } },
      select: { id: true, homeTeamId: true, awayTeamId: true, matchDate: true, status: true, homeScore: true, awayScore: true, dataEnvironment: true },
    });
    const links = await db.externalMatchLink.findMany({
      where: { source, OR: [{ sourceId: { in: prepared.fixtures.map((f) => f.sourceId) } }, { matchId: { in: candidates.map((c) => c.id) } }] },
      select: { id: true, matchId: true, sourceId: true, detailsFetchedAt: true },
    });
    prepared.linkIdsBySourceId = new Map(links.map((l) => [l.sourceId, { id: l.id, detailsFetchedAt: l.detailsFetchedAt }]));
    const { matched, unresolved } = matchFixtures({
      fixtures: prepared.fixtures,
      teams: resolved,
      candidates,
      linksBySourceId: new Map(links.map((l) => [l.sourceId, l.matchId])),
      linksByMatchId: new Map(links.map((l) => [l.matchId, l.sourceId])),
    });
    prepared.matched = matched.map((m) => ({ ...m, comparison: compareResult(m.match, m.fixture) }));
    prepared.unresolved = unresolved;
    for (const u of unresolved) warnings.push({ code: `FIXTURE_${u.reason}`, sourceId: u.fixture.sourceId, message: u.detail });
    for (const m of prepared.matched) {
      if (m.comparison.reason === 'RESULT_CONFLICT') warnings.push({ code: 'RESULT_CONFLICT', sourceId: m.fixture.sourceId, message: `Provider reports ${m.fixture.homeScore}-${m.fixture.awayScore}; canonical result ${m.match.homeScore}-${m.match.awayScore} kept. Enrichment withheld.` });
    }

    // 6. Post-match details, only for agreed finished matches that still need them.
    const wantsDetails = (['stats', 'events', 'lineups', 'players'] as const).some((t) => types.has(t));
    const detailDatasets: CoverageDataset[] = ['fixtureStatistics', 'events', 'lineups', 'playerStatistics'];
    const anyDetailCovered = detailDatasets.some((d) => !unavailable.has(d));
    if (wantsDetails && anyDetailCovered) {
      const nowMs = preparedAt.getTime();
      const inWindow = (m: ProviderMatch) => (request.from ? m.kickoff.toISOString().slice(0, 10) >= request.from : true) && (request.to ? m.kickoff.toISOString().slice(0, 10) <= request.to : true);
      const needs = prepared.matched.filter((m) => {
        if (!m.comparison.enrichable || !inWindow(m.fixture)) return false;
        const fetched = prepared.linkIdsBySourceId.get(m.fixture.sourceId)?.detailsFetchedAt ?? null;
        if (!fetched) return true;
        const recent = nowMs - m.match.matchDate.getTime() < REFRESH_WINDOW_MS;
        return recent && nowMs - fetched.getTime() >= REFRESH_MIN_AGE_MS;
      });
      prepared.detailsRequested = needs.map((m) => m.fixture.sourceId);
      if (request.maxDetails !== undefined && needs.length > request.maxDetails) {
        const newest = [...needs].sort((a, b) => b.match.matchDate.getTime() - a.match.matchDate.getTime()).slice(0, request.maxDetails);
        prepared.detailsRequested = newest.map((m) => m.fixture.sourceId);
        warnings.push({ code: 'DETAILS_CAPPED', message: `${needs.length - newest.length} fixture(s) still need details; capped at ${request.maxDetails} for this run.` });
      }
      const kickoffs = new Map(needs.map((m) => [m.fixture.sourceId, m.match.matchDate.getTime()]));
      const result = await this.provider.getFixtureDetails(prepared.detailsRequested, (id) =>
        nowMs - (kickoffs.get(id) ?? 0) < REFRESH_WINDOW_MS ? REFRESH_MIN_AGE_MS : Number.POSITIVE_INFINITY,
      );
      prepared.details = result.details;
      prepared.detailsNotFetched = result.notFetched;
      for (const d of result.details) warnings.push(...d.warnings);
    }

    // 7. Positions for injured players Nexora has never seen play (Player.position is required, never guessed).
    if (prepared.injuries && prepared.injuries.length > 0) {
      const known = new Set(
        (await db.player.findMany({ where: { source, sourceId: { in: prepared.injuries.map((i) => i.player.sourceId) } }, select: { sourceId: true } })).map((p) => p.sourceId),
      );
      for (const d of prepared.details) for (const g of d.players ?? []) for (const p of g.players) if (p.position) known.add(p.playerSourceId);
      // A position belongs to the player, not to the season, so a club's present squad listing
      // answers it for a season already played. Nothing time-varying is taken from it: the report's
      // own reportedAt is what every availability row is filed under.
      const inScope = new Map(
        prepared.matched
          .filter((m) => request.maxSquads !== undefined || (m.fixture.kickoff.getTime() >= preparedAt.getTime() && m.fixture.kickoff.getTime() <= preparedAt.getTime() + SQUAD_LOOKAHEAD_MS))
          .map((m) => [m.fixture.sourceId, m]),
      );
      const wanted = [...new Set(prepared.injuries.filter((i) => !known.has(i.player.sourceId) && inScope.has(i.matchSourceId) && i.team.sourceId).map((i) => i.team.sourceId!))];
      const teamsNeedingSquads = request.maxSquads === undefined ? wanted : wanted.slice(0, request.maxSquads);
      if (teamsNeedingSquads.length < wanted.length) {
        warnings.push({ code: 'SQUADS_CAPPED', message: `${wanted.length - teamsNeedingSquads.length} club(s) still need a squad listing; capped at ${request.maxSquads} for this run.` });
      }
      for (const teamSourceId of teamsNeedingSquads) {
        const squad = await this.provider.getSquad(teamSourceId);
        if (squad.available) prepared.squadPlayers.push(...squad.data);
        else warnings.push({ code: 'SQUAD_UNAVAILABLE', sourceId: teamSourceId, message: squad.reason });
      }
    }

    return finish(null);
  }

  // DB aliases for the source plus curated spellings not yet synced (so a dry-run resolves exactly like a real run).
  private async aliasRows(db: Db, source: string): Promise<AliasRow[]> {
    const rows = await db.teamAlias.findMany({ where: { source }, select: { teamId: true, normalizedAlias: true, sourceTeamId: true } });
    const present = new Set(rows.map((r) => r.normalizedAlias));
    const curated = this.curatedTeams.filter((t) => (t.aliases[source] ?? []).length > 0);
    const teams = await db.team.findMany({ where: { source: CURATED_SOURCE, sourceId: { in: curated.map((t) => t.key) } }, select: { id: true, sourceId: true } });
    const idByKey = new Map(teams.map((t) => [t.sourceId, t.id]));
    const extra: AliasRow[] = [];
    for (const t of curated) {
      const teamId = idByKey.get(t.key);
      if (!teamId) continue;
      for (const alias of t.aliases[source]!) {
        const normalizedAlias = normalizeTeamName(alias);
        if (!present.has(normalizedAlias)) extra.push({ teamId, normalizedAlias, sourceTeamId: null });
      }
    }
    return [...rows, ...extra];
  }

  // All writes, inside the caller's transaction.
  async apply(tx: Prisma.TransactionClient, p: PreparedEnrichment): Promise<EnrichmentCounts> {
    const { source, warnings } = p;
    const now = this.now();
    const counts = emptyCounts();
    counts.fixturesDiscovered = p.fixtures.length;
    counts.fixturesMatched = p.matched.length;
    counts.fixturesUnresolved = p.unresolved.length;
    counts.detailsRequested = p.detailsRequested.length;
    counts.detailsReceived = p.details.length;
    counts.skipped = p.detailsNotFetched.length;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`nexora-enrich:${source}:${p.request.competitionSourceId}/${p.request.seasonSourceId}`}))`;

    // Coverage as last seen, including refusals learned in this run.
    if (p.season) {
      for (const dataset of COVERAGE_DATASETS) {
        if (p.blockedEarlier.has(dataset)) continue;
        const refusal = p.refused.get(dataset);
        const available = !refusal && p.season.coverage[dataset];
        const reason = refusal ?? (available ? null : 'Provider coverage flag is false');
        await tx.providerCoverage.upsert({
          where: { source_competitionSourceId_seasonSourceId_dataset: { source, competitionSourceId: p.request.competitionSourceId, seasonSourceId: p.request.seasonSourceId, dataset } },
          create: { source, competitionSourceId: p.request.competitionSourceId, seasonSourceId: p.request.seasonSourceId, dataset, available, reason, checkedAt: p.preparedAt },
          update: { available, reason, checkedAt: p.preparedAt },
        });
      }
    }
    if (p.fatal) return counts;

    // Team identity: make sure curated aliases exist, then bind provider IDs on first resolution.
    await syncCuratedTeams(tx, p.competitionId, this.curatedTeams.filter((t) => t.competitionSourceId === p.backbone.dataset.competitionSourceId), now);
    for (const [sourceTeamId, team] of p.teams) {
      if (!team.bindAlias) continue;
      const bound = await tx.teamAlias.updateMany({ where: { source, normalizedAlias: team.bindAlias, sourceTeamId: null, teamId: team.teamId }, data: { sourceTeamId } });
      counts.aliasesBound += bound.count;
    }

    // Fixture links (provenance of every mapping) and result conflicts.
    const linkBySourceId = new Map<string, string>();
    for (const m of p.matched) {
      const conflict = m.comparison.conflict;
      const data = {
        matchedBy: m.matchedBy,
        kickoffDeltaMinutes: m.kickoffDeltaMinutes,
        sourceKickoff: m.fixture.kickoff,
        sourceStatus: m.fixture.status,
        sourceHomeScore: m.fixture.homeScore,
        sourceAwayScore: m.fixture.awayScore,
      };
      const existing = await tx.externalMatchLink.findUnique({ where: { source_sourceId: { source, sourceId: m.fixture.sourceId } } });
      if (conflict) counts.conflicts += 1;
      if (!existing) {
        const created = await tx.externalMatchLink.create({ data: { ...data, matchId: m.match.id, source, sourceId: m.fixture.sourceId, conflict: conflict ?? undefined, lastUpdated: now } });
        linkBySourceId.set(m.fixture.sourceId, created.id);
        counts.linksCreated += 1;
        continue;
      }
      linkBySourceId.set(m.fixture.sourceId, existing.id);
      const changed =
        existing.sourceStatus !== data.sourceStatus ||
        existing.sourceHomeScore !== data.sourceHomeScore ||
        existing.sourceAwayScore !== data.sourceAwayScore ||
        existing.sourceKickoff.getTime() !== data.sourceKickoff.getTime() ||
        stableJson(existing.conflict ?? null) !== stableJson(conflict ?? null);
      if (changed) {
        await tx.externalMatchLink.update({ where: { id: existing.id }, data: { ...data, conflict: conflict ?? Prisma.DbNull, lastUpdated: now } });
        counts.linksUpdated += 1;
      }
    }

    const matchBySourceId = new Map(p.matched.map((m) => [m.fixture.sourceId, m]));
    const teamId = (ref: ProviderTeamRef) => (ref.sourceId ? p.teams.get(ref.sourceId)?.teamId : undefined);
    const playerPositions = new Map<string, ProviderPosition>();
    for (const sp of p.squadPlayers) playerPositions.set(sp.sourceId, sp.position);
    for (const d of p.details) {
      for (const l of d.lineups ?? []) for (const pl of [...l.startXI, ...l.substitutes]) if (pl.sourceId && pl.position) playerPositions.set(pl.sourceId, pl.position);
      for (const g of d.players ?? []) for (const pl of g.players) if (pl.position) playerPositions.set(pl.playerSourceId, pl.position);
    }
    const playerCache = new Map<string, { id: string; teamId: string } | null>();
    const ensurePlayer = async (sourceId: string, name: string, teamIdForPlayer: string): Promise<string | null> => {
      if (!playerCache.has(sourceId)) {
        const row = await tx.player.findUnique({ where: { source_sourceId: { source, sourceId } }, select: { id: true, teamId: true, name: true } });
        if (row) {
          // Only the current season may move a player to a new club; backfilling old seasons never rewrites the present.
          if (p.dataEnvironment === 'LIVE' && (row.teamId !== teamIdForPlayer || row.name !== name)) {
            await tx.player.update({ where: { id: row.id }, data: { teamId: teamIdForPlayer, name, lastUpdated: now } });
            counts.playersUpdated += 1;
          }
          playerCache.set(sourceId, { id: row.id, teamId: teamIdForPlayer });
        } else {
          const position = playerPositions.get(sourceId);
          if (!position) {
            warnings.push({ code: 'PLAYER_POSITION_UNKNOWN', sourceId, message: `${name}: position not reported by the provider; player not created.` });
            playerCache.set(sourceId, null);
          } else {
            const created = await tx.player.create({ data: { teamId: teamIdForPlayer, name, position, source, sourceId, lastUpdated: now } });
            counts.playersCreated += 1;
            playerCache.set(sourceId, { id: created.id, teamId: teamIdForPlayer });
          }
        }
      }
      return playerCache.get(sourceId)?.id ?? null;
    };

    for (const d of p.details) {
      const m = matchBySourceId.get(d.match.sourceId);
      if (!m || !m.comparison.enrichable) continue;
      const matchId = m.match.id;
      const allowUpdate = now.getTime() - m.match.matchDate.getTime() < REFRESH_WINDOW_MS;

      if (p.types.has('stats') && !p.unavailable.has('fixtureStatistics')) {
        if (!d.stats || d.stats.length === 0) counts.statsUnavailable += 1;
        else {
          counts.statsAvailable += 1;
          await this.ingestTeamStats(tx, p, matchId, m.match.homeTeamId, d.stats, allowUpdate, now, counts);
        }
      }

      if (p.types.has('events') && !p.unavailable.has('events') && d.events) {
        const rows: Prisma.MatchEventCreateManyInput[] = [];
        for (const e of d.events) {
          const tid = teamId(e.team);
          if (!tid) {
            warnings.push({ code: 'EVENT_TEAM_UNRESOLVED', sourceId: e.sourceId, message: `Event for unmapped team ${e.team.name} skipped.` });
            counts.skipped += 1;
            continue;
          }
          rows.push({ matchId, teamId: tid, type: e.type, detail: e.detail, minute: e.minute, extraMinute: e.extraMinute, playerSourceId: e.playerSourceId, playerName: e.playerName, relatedPlayerSourceId: e.relatedPlayerSourceId, relatedPlayerName: e.relatedPlayerName, comments: e.comments, source, sourceId: e.sourceId, lastUpdated: now });
        }
        if (rows.length > 0) counts.eventsImported += (await tx.matchEvent.createMany({ data: rows, skipDuplicates: true })).count;
        const incoming = new Set(rows.map((r) => r.sourceId));
        const stale = await tx.matchEvent.count({ where: { matchId, source, sourceId: { notIn: [...incoming] } } });
        if (stale > 0) warnings.push({ code: 'EVENTS_NO_LONGER_REPORTED', sourceId: d.match.sourceId, message: `${stale} stored event(s) are absent from the latest response; kept as recorded.` });
      }

      if (p.types.has('lineups') && !p.unavailable.has('lineups') && d.lineups) {
        for (const l of d.lineups) {
          const tid = teamId(l.team);
          if (!tid) continue;
          const content = { formation: l.formation, coachName: l.coachName, startXI: l.startXI as unknown as Prisma.InputJsonValue, substitutes: l.substitutes as unknown as Prisma.InputJsonValue };
          const existing = await tx.matchLineup.findUnique({ where: { matchId_teamId_source: { matchId, teamId: tid, source } } });
          if (!existing) {
            await tx.matchLineup.create({ data: { matchId, teamId: tid, ...content, source, sourceId: d.match.sourceId, lastUpdated: now } });
            counts.lineupsImported += 1;
          } else if (stableJson([existing.formation, existing.coachName, existing.startXI, existing.substitutes]) !== stableJson([l.formation, l.coachName, l.startXI, l.substitutes])) {
            if (allowUpdate) await tx.matchLineup.update({ where: { id: existing.id }, data: { ...content, lastUpdated: now } });
            else warnings.push({ code: 'LINEUP_CONFLICT', sourceId: d.match.sourceId, message: 'Provider lineup now differs; stored lineup kept.' });
          }
        }
      }

      if (p.types.has('players') && !p.unavailable.has('playerStatistics') && d.players) {
        for (const group of d.players) {
          const tid = teamId(group.team);
          if (!tid) continue;
          for (const s of group.players) await this.ingestPlayerStats(tx, p, matchId, tid, s, d.match.sourceId, allowUpdate, now, counts, ensurePlayer);
        }
      }

      const linkId = linkBySourceId.get(d.match.sourceId);
      if (linkId) await tx.externalMatchLink.update({ where: { id: linkId }, data: { detailsFetchedAt: d.fetchedAt } });
    }

    if (p.injuries) {
      this.countInjuries(counts, p.injuries);
      await this.ingestAvailability(tx, p, linkBySourceId, teamId, ensurePlayer, counts);
    }

    return counts;
  }

  private async ingestTeamStats(
    tx: Prisma.TransactionClient,
    p: PreparedEnrichment,
    matchId: string,
    homeTeamId: string,
    stats: readonly ProviderMatchTeamStats[],
    allowUpdate: boolean,
    now: Date,
    counts: EnrichmentCounts,
  ): Promise<void> {
    for (const s of stats) {
      const tid = s.teamSourceId ? p.teams.get(s.teamSourceId)?.teamId : undefined;
      if (!tid) {
        p.warnings.push({ code: 'STATS_TEAM_UNRESOLVED', message: `Statistics for unmapped team ${s.teamName} skipped.` });
        counts.skipped += 1;
        continue;
      }
      if ((tid === homeTeamId) !== s.isHome) {
        p.warnings.push({ code: 'STATS_SIDE_MISMATCH', message: `Statistics for ${s.teamName} disagree on home/away; skipped.` });
        counts.skipped += 1;
        continue;
      }
      const values = Object.fromEntries(STAT_FIELDS.map((f) => [f, s[f] ?? null])) as Record<StatField, number | null>;
      // xG and other extras, the provider's raw values and event-log evidence travel together for later audit.
      const additional = { ...(s.additional ?? {}), providerRaw: s.raw ?? null, derivedFromEvents: s.derived ?? null, nullPolicy: STAT_NULL_POLICY_VERSION } as Prisma.InputJsonValue;
      const existing = await tx.matchTeamStats.findUnique({ where: { matchId_teamId: { matchId, teamId: tid } } });
      if (!existing) {
        await tx.matchTeamStats.create({ data: { matchId, teamId: tid, isHome: s.isHome, ...values, additional, source: p.source, sourceId: p.matched.find((m) => m.match.id === matchId)?.fixture.sourceId ?? null, lastUpdated: now } });
        counts.statsCreated += 1;
        continue;
      }
      const merge = mergeValues(existing, values, STAT_FIELDS, allowUpdate && existing.source === p.source);
      if (merge.conflicts.length > 0) {
        counts.conflicts += 1;
        p.warnings.push({ code: 'STATS_CONFLICT', message: `Match ${matchId} ${s.teamName}: provider now differs on ${merge.conflicts.join(', ')}; stored values kept.` });
      }
      if (Object.keys(merge.changes).length > 0) {
        await tx.matchTeamStats.update({ where: { id: existing.id }, data: { ...merge.changes, lastUpdated: now } });
        if (merge.updated.length > 0) counts.statsUpdated += 1;
        else counts.statsFilled += 1;
      }
    }
  }

  private async ingestPlayerStats(
    tx: Prisma.TransactionClient,
    p: PreparedEnrichment,
    matchId: string,
    teamIdForMatch: string,
    s: ProviderFixturePlayerStats,
    fixtureSourceId: string,
    allowUpdate: boolean,
    now: Date,
    counts: EnrichmentCounts,
    ensurePlayer: (sourceId: string, name: string, teamId: string) => Promise<string | null>,
  ): Promise<void> {
    const playerId = await ensurePlayer(s.playerSourceId, s.name, teamIdForMatch);
    if (!playerId) {
      counts.skipped += 1;
      return;
    }
    const values = Object.fromEntries(PLAYER_FIELDS.map((f) => [f, s[f] ?? null])) as Record<PlayerField, number | null>;
    const existing = await tx.playerMatchStats.findUnique({ where: { playerId_matchId: { playerId, matchId } } });
    if (!existing) {
      await tx.playerMatchStats.create({ data: { playerId, matchId, teamId: teamIdForMatch, started: s.started, minutes: s.minutes, ...values, source: p.source, sourceId: fixtureSourceId, lastUpdated: now } });
      counts.playerStatsCreated += 1;
      return;
    }
    const merge = mergeValues(existing, values, PLAYER_FIELDS, allowUpdate && existing.source === p.source);
    if (merge.conflicts.length > 0) p.warnings.push({ code: 'PLAYER_STATS_CONFLICT', sourceId: s.playerSourceId, message: `Match ${matchId}: provider now differs on ${merge.conflicts.join(', ')}; stored values kept.` });
    if (Object.keys(merge.changes).length > 0) {
      await tx.playerMatchStats.update({ where: { id: existing.id }, data: { ...merge.changes, lastUpdated: now } });
      counts.playerStatsFilled += 1;
    }
  }

  // Append-only: a new report is stored only when it says something different from the latest one for that player
  // and match. Players the provider does not list get no row at all, so their availability stays UNKNOWN.
  private async ingestAvailability(
    tx: Prisma.TransactionClient,
    p: PreparedEnrichment,
    linkBySourceId: ReadonlyMap<string, string>,
    teamId: (ref: ProviderTeamRef) => string | undefined,
    ensurePlayer: (sourceId: string, name: string, teamId: string) => Promise<string | null>,
    counts: EnrichmentCounts,
  ): Promise<void> {
    const matchIdBySourceId = new Map(p.matched.map((m) => [m.fixture.sourceId, m.match.id]));
    const matchIds = [...new Set(p.injuries!.map((r) => matchIdBySourceId.get(r.matchSourceId)).filter((id): id is string => id !== undefined))];
    const latest = new Map<string, { status: string; reason: string | null; sourceStatus: string | null }>();
    for (const row of await tx.playerAvailability.findMany({ where: { source: p.source, matchId: { in: matchIds } }, orderBy: [{ reportedAt: 'desc' }, { id: 'asc' }] })) {
      const key = `${row.playerId}|${row.matchId}`;
      if (!latest.has(key)) latest.set(key, { status: row.status, reason: row.reason, sourceStatus: row.sourceStatus });
    }
    const rows: Prisma.PlayerAvailabilityCreateManyInput[] = [];
    for (const r of p.injuries!) {
      const matchId = matchIdBySourceId.get(r.matchSourceId);
      if (!matchId || !linkBySourceId.has(r.matchSourceId)) {
        p.warnings.push({ code: 'INJURY_FIXTURE_UNLINKED', sourceId: r.matchSourceId, message: `${r.player.name}: fixture not mapped to a Nexora match; report skipped.` });
        counts.skipped += 1;
        continue;
      }
      const tid = teamId(r.team);
      if (!tid) {
        counts.skipped += 1;
        continue;
      }
      const playerId = await ensurePlayer(r.player.sourceId, r.player.name, tid);
      if (!playerId) {
        counts.skipped += 1;
        continue;
      }
      const key = `${playerId}|${matchId}`;
      const previous = latest.get(key);
      if (previous && previous.status === r.status && previous.reason === r.reason && previous.sourceStatus === r.sourceType) continue;
      latest.set(key, { status: r.status, reason: r.reason, sourceStatus: r.sourceType });
      rows.push({ playerId, matchId, status: r.status, reason: r.reason, expectedReturn: r.expectedReturn, reportedAt: r.reportedAt, source: p.source, sourceId: `${r.matchSourceId}:${r.player.sourceId}`, sourceStatus: r.sourceType });
    }
    if (rows.length > 0) counts.availabilityImported += (await tx.playerAvailability.createMany({ data: rows, skipDuplicates: true })).count;
  }
}
