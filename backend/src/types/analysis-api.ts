import { z } from 'zod';
import { DATA_UNAVAILABLE } from '../utils/data-availability.js';

const DataEnvironmentSchema = z.enum(['SYNTHETIC', 'HISTORICAL', 'LIVE']);

const MetricSchema = z.object({
  value: z.union([z.number(), z.literal(DATA_UNAVAILABLE)]),
  sampleSize: z.number(),
  window: z.number(),
});

const MetadataSchema = z.object({
  source: z.literal('nexora-knowledge'),
  analyzer: z.string(),
  version: z.string(),
  calculationWindow: z.number(),
  sampleSize: z.number(),
  cutoff: z.string(),
  dataEnvironments: z.array(DataEnvironmentSchema),
});

const TeamRef = z.object({ id: z.string(), name: z.string() });
const Outcome = z.enum(['W', 'D', 'L']);
const StatsStatus = z.enum(['KNOWN', 'NOT_RECORDED', 'PUBLISHED_AFTER_CUTOFF']);

export const FormAnalysisSchema = z.object({
  team: TeamRef,
  scope: z.enum(['ALL', 'HOME', 'AWAY']),
  status: z.enum(['AVAILABLE', 'INSUFFICIENT_DATA']),
  sequence: z.array(Outcome),
  record: z.object({ wins: z.number(), draws: z.number(), losses: z.number() }),
  points: z.number(),
  pointsPerGame: MetricSchema,
  goalsScored: z.number(),
  goalsConceded: z.number(),
  averageGoalsScored: MetricSchema,
  averageGoalsConceded: MetricSchema,
  averagePossession: MetricSchema,
  averageShots: MetricSchema,
  averageShotsOnTarget: MetricSchema,
  averageCorners: MetricSchema,
  averageYellowCards: MetricSchema,
  averageRedCards: MetricSchema,
  matches: z.array(
    z.object({
      matchId: z.string(),
      matchDate: z.string(),
      venue: z.enum(['HOME', 'AWAY']),
      opponent: TeamRef,
      goalsFor: z.number(),
      goalsAgainst: z.number(),
      outcome: Outcome,
      dataEnvironment: DataEnvironmentSchema,
      statsStatus: StatsStatus,
    }),
  ),
  metadata: MetadataSchema,
  limitations: z.array(z.string()),
});

const TeamFormBundleSchema = z.object({
  overall: FormAnalysisSchema,
  homeAway: z.object({ team: TeamRef, home: FormAnalysisSchema, away: FormAnalysisSchema }),
});

export const WindowQuerySchema = z.object({ window: z.coerce.number().int().min(1).max(20).default(5) });

export const TeamFormQuerySchema = WindowQuerySchema.extend({ asOf: z.coerce.date().optional() });

export const MatchFormResponseSchema = z.object({
  matchId: z.string(),
  cutoff: z.string(),
  dataEnvironment: DataEnvironmentSchema,
  home: TeamFormBundleSchema,
  away: TeamFormBundleSchema,
});

export const TeamFormResponseSchema = TeamFormBundleSchema.extend({ teamId: z.string(), asOf: z.string() });

const WeightedMetricSchema = z.object({ unweighted: MetricSchema, timeWeighted: MetricSchema });

export const H2HQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
  halfLifeDays: z.coerce.number().int().min(30).max(3650).default(365),
});

export const H2HResponseSchema = z.object({
  matchId: z.string(),
  subjectHome: TeamRef,
  subjectAway: TeamRef,
  status: z.enum(['AVAILABLE', 'NO_MEETINGS']),
  meetingsUsed: z.number(),
  halfLifeDays: z.number(),
  effectiveSampleSize: z.number(),
  reliability: z.number(),
  results: z.object({ subjectHomeWins: z.number(), draws: z.number(), subjectAwayWins: z.number() }),
  weightedResultShare: z.object({ subjectHomeWin: MetricSchema, draw: MetricSchema, subjectAwayWin: MetricSchema }),
  totalGoals: WeightedMetricSchema,
  subjectHomeGoals: WeightedMetricSchema,
  subjectAwayGoals: WeightedMetricSchema,
  totalCorners: WeightedMetricSchema,
  totalYellowCards: WeightedMetricSchema,
  totalRedCards: WeightedMetricSchema,
  totalShots: WeightedMetricSchema,
  totalShotsOnTarget: WeightedMetricSchema,
  meetings: z.array(
    z.object({
      matchId: z.string(),
      matchDate: z.string(),
      ageDays: z.number(),
      weight: z.number(),
      homeTeamOfMeeting: z.enum(['SUBJECT_HOME', 'SUBJECT_AWAY']),
      subjectHomeGoals: z.number(),
      subjectAwayGoals: z.number(),
      outcomeForSubjectHome: Outcome,
      statsStatus: StatsStatus,
    }),
  ),
  metadata: MetadataSchema,
  limitations: z.array(z.string()),
});
