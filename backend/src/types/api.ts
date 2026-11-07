import { z } from 'zod';
import { IMPORTABLE_DATASETS, findImportable } from '../data/import/catalog.js';
import { DATA_UNAVAILABLE } from '../utils/data-availability.js';
import { isValidTimeZone } from '../utils/time.js';

const IMPORTABLE_SOURCES = [...new Set(IMPORTABLE_DATASETS.map((d) => d.source))] as [string, ...string[]];

export const IdParamsSchema = z.object({ id: z.string().min(1).max(100) });

const unavailable = z.literal(DATA_UNAVAILABLE);
const numberOrUnavailable = z.union([z.number(), unavailable]);

export const TeamRefSchema = z.object({ id: z.string(), name: z.string(), shortName: z.string() });

export const MatchStatusSchema = z.enum(['SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED']);

export const DataEnvironmentSchema = z.enum(['SYNTHETIC', 'HISTORICAL', 'LIVE']);

export const ProvenanceSchema = z.object({
  source: z.string(),
  sourceId: z.string(),
  lastUpdated: z.string(),
  sourceMatchDate: z.string().nullable(),
  kickoffTimeKnown: z.boolean(),
});

export const MatchSummarySchema = z.object({
  id: z.string(),
  matchDate: z.string(),
  status: MatchStatusSchema,
  dataEnvironment: DataEnvironmentSchema,
  round: z.string().nullable(),
  competition: z.object({ id: z.string(), name: z.string() }),
  season: z.object({ id: z.string(), name: z.string() }),
  homeTeam: TeamRefSchema,
  awayTeam: TeamRefSchema,
  homeScore: z.number().nullable(),
  awayScore: z.number().nullable(),
  homeHalfTimeScore: z.number().nullable(),
  awayHalfTimeScore: z.number().nullable(),
  provenance: ProvenanceSchema,
});

export const TeamMatchStatsSchema = z.object({
  goals: numberOrUnavailable,
  possession: numberOrUnavailable,
  shots: numberOrUnavailable,
  shotsOnTarget: numberOrUnavailable,
  corners: numberOrUnavailable,
  yellowCards: numberOrUnavailable,
  redCards: numberOrUnavailable,
  fouls: numberOrUnavailable,
  offsides: numberOrUnavailable,
  additional: z.record(z.string(), z.unknown()).nullable(),
});

export const MatchDetailSchema = MatchSummarySchema.extend({
  stats: z
    .object({
      home: z.union([TeamMatchStatsSchema, unavailable]),
      away: z.union([TeamMatchStatsSchema, unavailable]),
    })
    .nullable(),
});

export const MatchListQuerySchema = z.object({
  status: MatchStatusSchema.optional(),
  dataEnvironment: DataEnvironmentSchema.optional(),
  teamId: z.string().min(1).max(100).optional(),
  seasonId: z.string().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const MatchListResponseSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  items: z.array(MatchSummarySchema),
});

export const PlayerPositionSchema = z.enum(['GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'FORWARD']);

export const PlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: PlayerPositionSchema,
});

export const TeamDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  country: z.string(),
  competition: z.object({ id: z.string(), name: z.string() }),
  squadSize: z.number(),
});

export const TeamPlayersResponseSchema = z.object({
  teamId: z.string(),
  players: z.array(PlayerSchema),
});

export const ErrorResponseSchema = z.object({ error: z.string(), message: z.string() });

export const CompetitionSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  country: z.string(),
  dataEnvironment: DataEnvironmentSchema,
  source: z.string(),
  lastUpdated: z.string(),
  teams: z.number(),
  matches: z.number(),
  matchesByEnvironment: z.record(z.string(), z.number()),
});

export const CompetitionListResponseSchema = z.object({ items: z.array(CompetitionSchema) });

export const TeamListQuerySchema = z.object({ competitionId: z.string().min(1).max(100).optional() });

export const TeamListResponseSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), shortName: z.string(), country: z.string(), competitionId: z.string(), source: z.string() })),
});

const StatLineSchema = z.object({
  possession: z.number().nullable(),
  shots: z.number().nullable(),
  shotsOnTarget: z.number().nullable(),
  corners: z.number().nullable(),
  yellowCards: z.number().nullable(),
  redCards: z.number().nullable(),
  fouls: z.number().nullable(),
  offsides: z.number().nullable(),
});

const KnownResultSchema = z.object({
  matchId: z.string(),
  matchDate: z.string(),
  resultKnownAt: z.string(),
  dataEnvironment: DataEnvironmentSchema,
  venue: z.enum(['HOME', 'AWAY']),
  opponent: z.object({ id: z.string(), name: z.string() }),
  goalsFor: z.number(),
  goalsAgainst: z.number(),
  outcome: z.enum(['W', 'D', 'L']),
  statsRecorded: z.boolean(),
  stats: z.object({
    status: z.enum(['KNOWN', 'NOT_RECORDED', 'PUBLISHED_AFTER_CUTOFF']),
    for: StatLineSchema.nullable(),
    against: StatLineSchema.nullable(),
  }),
});

const KnownTeamSchema = z.object({
  team: z.object({ id: z.string(), name: z.string() }),
  recent: z.array(KnownResultSchema),
  excludedNotYetKnown: z.number(),
});

export const KnowledgeQuerySchema = z.object({
  formWindow: z.coerce.number().int().min(1).max(20).default(5),
  h2hWindow: z.coerce.number().int().min(1).max(20).default(5),
});

export const KnowledgeResponseSchema = z.object({
  matchId: z.string(),
  dataEnvironment: DataEnvironmentSchema,
  cutoff: z.string(),
  kickoffTimeKnown: z.boolean(),
  visibleEnvironments: z.array(DataEnvironmentSchema),
  latestInputAt: z.string().nullable(),
  integrity: z.object({ allInputsBeforeCutoff: z.boolean(), inputsChecked: z.number() }),
  home: KnownTeamSchema,
  away: KnownTeamSchema,
  headToHead: z.object({ meetings: z.array(KnownResultSchema), excludedNotYetKnown: z.number() }),
  availability: z.object({
    status: z.enum(['REPORTED', DATA_UNAVAILABLE]),
    reportsBeforeCutoff: z.number(),
    playersReported: z.number(),
    reportsIgnoredAfterCutoff: z.number(),
  }),
  dataLimitations: z.array(z.string()),
});

const TimeZoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, { message: 'Unknown IANA time zone' });

export const TodayQuerySchema = z.object({
  timeZone: TimeZoneSchema.default('UTC'),
  dataEnvironment: DataEnvironmentSchema.optional(),
});

export const TodayResponseSchema = z.object({
  timeZone: z.string(),
  date: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(MatchSummarySchema),
});

export const UpcomingQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(60).default(14),
  dataEnvironment: DataEnvironmentSchema.optional(),
});

export const UpcomingResponseSchema = z.object({
  asOf: z.string(),
  to: z.string(),
  upcoming: z.array(MatchSummarySchema),
  awaitingResult: z.array(MatchSummarySchema),
});

export const RevisionListResponseSchema = z.object({
  matchId: z.string(),
  items: z.array(z.object({ id: z.string(), source: z.string(), importRunId: z.string().nullable(), changes: z.record(z.string(), z.unknown()), createdAt: z.string() })),
});

export const FreshnessResponseSchema = z.object({
  asOf: z.string(),
  datasets: z.array(
    z.object({
      source: z.string(),
      dataset: z.string(),
      dataEnvironment: DataEnvironmentSchema,
      lastAttempt: z.object({ status: z.string(), startedAt: z.string() }).nullable(),
      lastSuccessfulImportAt: z.string().nullable(),
      sourceFetchedAt: z.string().nullable(),
      matches: z.number(),
      finished: z.number(),
      scheduled: z.number(),
      awaitingResult: z.number(),
      nextKickoff: z.string().nullable(),
    }),
  ),
  // Enrichment providers (e.g. API-Football): configuration, request budget, coverage, last run.
  providers: z.array(z.record(z.string(), z.unknown())),
});

export const ImportRequestSchema = z
  .object({
    source: z.enum(IMPORTABLE_SOURCES),
    competition: z.string().min(1).max(20),
    seasons: z.array(z.string().regex(/^\d{4}-\d{2}$/)).min(1).max(10),
  })
  .refine((body) => body.seasons.every((s) => findImportable(body.source, body.competition, s)), {
    message: 'Every requested season must be on the importable dataset allowlist',
    path: ['seasons'],
  });

const ImportCountsSchema = z.object({
  sourceMatches: z.number(),
  created: z.number(),
  unchanged: z.number(),
  updated: z.number(),
  resultsReceived: z.number(),
  revisionsRecorded: z.number(),
  metadataFilled: z.number(),
  conflicts: z.number(),
  missingFromSource: z.number(),
  teamsCreated: z.number(),
  aliasesCreated: z.number(),
  playersCreated: z.number(),
  playersUpdated: z.number(),
  statsCreated: z.number(),
  statsFilled: z.number(),
  statsUpdated: z.number(),
  playerStatsCreated: z.number(),
  playerStatsFilled: z.number(),
  availabilityReportsCreated: z.number(),
});

export const ImportResponseSchema = z.object({
  runs: z.array(
    z.object({
      importRunId: z.string(),
      status: z.enum(['COMPLETED', 'FAILED']),
      source: z.string(),
      dataset: z.string(),
      dataEnvironment: DataEnvironmentSchema,
      counts: ImportCountsSchema.nullable(),
      warningCounts: z.record(z.string(), z.number()),
      unavailableFromSource: z.array(z.string()),
      errorMessage: z.string().nullable(),
    }),
  ),
});

export const ImportRunListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export const ImportRunListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      dataset: z.string(),
      dataEnvironment: DataEnvironmentSchema,
      status: z.enum(['RUNNING', 'COMPLETED', 'FAILED']),
      counts: z.record(z.string(), z.unknown()).nullable(),
      warningCount: z.number(),
      errorMessage: z.string().nullable(),
      startedAt: z.string(),
      completedAt: z.string().nullable(),
    }),
  ),
});

export type MatchListQuery = z.infer<typeof MatchListQuerySchema>;
export type MatchSummary = z.infer<typeof MatchSummarySchema>;
export type MatchDetail = z.infer<typeof MatchDetailSchema>;
export type TeamMatchStats = z.infer<typeof TeamMatchStatsSchema>;
export type TeamDetail = z.infer<typeof TeamDetailSchema>;
export type TeamPlayersResponse = z.infer<typeof TeamPlayersResponseSchema>;
export type ImportRequestBody = z.infer<typeof ImportRequestSchema>;
