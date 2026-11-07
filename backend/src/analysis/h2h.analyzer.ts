import type { DataEnvironment } from '@prisma/client';
import type { KnownResult, KnownStatLine } from '../data/knowledge/knowledge.service.js';
import { DATA_UNAVAILABLE } from '../utils/data-availability.js';
import { mean, round, weightedMean, type AnalysisMetadata, type Metric } from './metrics.js';

export const H2H_ANALYZER_VERSION = '1.0.0';
export const DEFAULT_H2H_LIMIT = 5;
export const DEFAULT_H2H_HALF_LIFE_DAYS = 365;
// Effective sample size at which H2H is treated as fully reliable; the analysis engine scales H2H influence by this.
export const H2H_FULL_RELIABILITY_ESS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WeightedMetric {
  unweighted: Metric;
  timeWeighted: Metric;
}

export interface H2HMeeting {
  matchId: string;
  matchDate: string;
  ageDays: number;
  weight: number;
  homeTeamOfMeeting: 'SUBJECT_HOME' | 'SUBJECT_AWAY';
  subjectHomeGoals: number;
  subjectAwayGoals: number;
  outcomeForSubjectHome: 'W' | 'D' | 'L';
  statsStatus: KnownResult['stats']['status'];
}

export interface H2HAnalysis {
  subjectHome: { id: string; name: string };
  subjectAway: { id: string; name: string };
  status: 'AVAILABLE' | 'NO_MEETINGS';
  meetingsUsed: number;
  halfLifeDays: number;
  // Kish effective sample size of the time weights: how many "fully recent" meetings the sample is worth.
  effectiveSampleSize: number;
  reliability: number;
  results: { subjectHomeWins: number; draws: number; subjectAwayWins: number };
  weightedResultShare: { subjectHomeWin: Metric; draw: Metric; subjectAwayWin: Metric };
  totalGoals: WeightedMetric;
  subjectHomeGoals: WeightedMetric;
  subjectAwayGoals: WeightedMetric;
  totalCorners: WeightedMetric;
  totalYellowCards: WeightedMetric;
  totalRedCards: WeightedMetric;
  totalShots: WeightedMetric;
  totalShotsOnTarget: WeightedMetric;
  meetings: H2HMeeting[];
  metadata: AnalysisMetadata;
  limitations: string[];
}

export interface H2HInput {
  subjectHome: { id: string; name: string };
  subjectAway: { id: string; name: string };
  // Meetings from the subject home team's perspective, most recent first.
  meetings: readonly KnownResult[];
  limit?: number;
  halfLifeDays?: number;
  cutoff: Date;
  environments: DataEnvironment[];
}

export function timeWeight(ageDays: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

export function effectiveSampleSize(weights: readonly number[]): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  const sumSq = weights.reduce((a, b) => a + b * b, 0);
  return sumSq === 0 ? 0 : (sum * sum) / sumSq;
}

// Both teams' values must be known for a match total; one missing side makes that meeting's total unavailable.
const total = (r: KnownResult, key: keyof KnownStatLine): number | null => {
  const a = r.stats.for?.[key] ?? null;
  const b = r.stats.against?.[key] ?? null;
  return a === null || b === null ? null : a + b;
};

export function analyzeHeadToHead(input: H2HInput): H2HAnalysis {
  const limit = input.limit ?? DEFAULT_H2H_LIMIT;
  const halfLifeDays = input.halfLifeDays ?? DEFAULT_H2H_HALF_LIFE_DAYS;
  const used = input.meetings.slice(0, limit);
  const n = used.length;
  const ages = used.map((r) => (input.cutoff.getTime() - new Date(r.matchDate).getTime()) / DAY_MS);
  const weights = ages.map((age) => timeWeight(age, halfLifeDays));
  const ess = effectiveSampleSize(weights);

  const pair = (values: (number | null)[]): WeightedMetric => ({ unweighted: mean(values, limit), timeWeighted: weightedMean(values, weights, limit) });
  const share = (outcome: 'W' | 'D' | 'L'): Metric => weightedMean(used.map((r) => (r.outcome === outcome ? 1 : 0)), weights, limit);

  const analysis: H2HAnalysis = {
    subjectHome: input.subjectHome,
    subjectAway: input.subjectAway,
    status: n > 0 ? 'AVAILABLE' : 'NO_MEETINGS',
    meetingsUsed: n,
    halfLifeDays,
    effectiveSampleSize: round(ess),
    reliability: round(Math.min(1, ess / H2H_FULL_RELIABILITY_ESS)),
    results: {
      subjectHomeWins: used.filter((r) => r.outcome === 'W').length,
      draws: used.filter((r) => r.outcome === 'D').length,
      subjectAwayWins: used.filter((r) => r.outcome === 'L').length,
    },
    weightedResultShare: { subjectHomeWin: share('W'), draw: share('D'), subjectAwayWin: share('L') },
    totalGoals: pair(used.map((r) => r.goalsFor + r.goalsAgainst)),
    subjectHomeGoals: pair(used.map((r) => r.goalsFor)),
    subjectAwayGoals: pair(used.map((r) => r.goalsAgainst)),
    totalCorners: pair(used.map((r) => total(r, 'corners'))),
    totalYellowCards: pair(used.map((r) => total(r, 'yellowCards'))),
    totalRedCards: pair(used.map((r) => total(r, 'redCards'))),
    totalShots: pair(used.map((r) => total(r, 'shots'))),
    totalShotsOnTarget: pair(used.map((r) => total(r, 'shotsOnTarget'))),
    meetings: used.map((r, i) => ({
      matchId: r.matchId,
      matchDate: r.matchDate,
      ageDays: round(ages[i]!, 1),
      weight: round(weights[i]!, 4),
      homeTeamOfMeeting: r.venue === 'HOME' ? 'SUBJECT_HOME' : 'SUBJECT_AWAY',
      subjectHomeGoals: r.goalsFor,
      subjectAwayGoals: r.goalsAgainst,
      outcomeForSubjectHome: r.outcome,
      statsStatus: r.stats.status,
    })),
    metadata: {
      source: 'nexora-knowledge',
      analyzer: 'h2h',
      version: H2H_ANALYZER_VERSION,
      calculationWindow: limit,
      sampleSize: n,
      cutoff: input.cutoff.toISOString(),
      dataEnvironments: input.environments,
    },
    limitations: [],
  };

  if (n === 0) analysis.limitations.push('No previous meetings were known before the cutoff; head-to-head is unavailable.');
  else if (n < limit) analysis.limitations.push(`Only ${n} previous meeting(s) were known (window ${limit}).`);
  if (n > 0 && ess < H2H_FULL_RELIABILITY_ESS) {
    analysis.limitations.push(`Time-weighted effective sample is ${round(ess, 2)} meetings; head-to-head reliability is ${round(Math.min(1, ess / H2H_FULL_RELIABILITY_ESS), 2)}.`);
  }
  if (n > 0 && analysis.totalCorners.unweighted.value === DATA_UNAVAILABLE) analysis.limitations.push('Corner statistics unavailable for every known meeting.');
  if (n > 0 && analysis.totalShots.unweighted.value === DATA_UNAVAILABLE) analysis.limitations.push('Shot statistics unavailable for every known meeting.');
  return analysis;
}
