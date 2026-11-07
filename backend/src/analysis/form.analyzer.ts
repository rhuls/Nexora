import type { DataEnvironment } from '@prisma/client';
import type { KnownResult, KnownStatLine } from '../data/knowledge/knowledge.service.js';
import { describeGap, mean, round, type AnalysisMetadata, type Metric } from './metrics.js';

export const FORM_ANALYZER_VERSION = '1.0.0';
export const MIN_SPLIT_SAMPLE = 3;

export type FormScope = 'ALL' | 'HOME' | 'AWAY';

export interface FormAnalysis {
  team: { id: string; name: string };
  scope: FormScope;
  status: 'AVAILABLE' | 'INSUFFICIENT_DATA';
  // Most recent first.
  sequence: Array<'W' | 'D' | 'L'>;
  record: { wins: number; draws: number; losses: number };
  points: number;
  pointsPerGame: Metric;
  goalsScored: number;
  goalsConceded: number;
  averageGoalsScored: Metric;
  averageGoalsConceded: Metric;
  averagePossession: Metric;
  averageShots: Metric;
  averageShotsOnTarget: Metric;
  averageCorners: Metric;
  averageYellowCards: Metric;
  averageRedCards: Metric;
  matches: Array<Pick<KnownResult, 'matchId' | 'matchDate' | 'venue' | 'opponent' | 'goalsFor' | 'goalsAgainst' | 'outcome' | 'dataEnvironment'> & { statsStatus: KnownResult['stats']['status'] }>;
  metadata: AnalysisMetadata;
  limitations: string[];
}

export interface FormInput {
  team: { id: string; name: string };
  scope: FormScope;
  window: number;
  results: readonly KnownResult[];
  cutoff: Date;
  environments: DataEnvironment[];
  minSample?: number;
}

const own = (r: KnownResult, key: keyof KnownStatLine): number | null => r.stats.for?.[key] ?? null;

export function analyzeForm(input: FormInput): FormAnalysis {
  const { team, scope, window } = input;
  const used = input.results.slice(0, window);
  const n = used.length;
  const minSample = input.minSample ?? (scope === 'ALL' ? 1 : MIN_SPLIT_SAMPLE);
  const subject = scope === 'ALL' ? 'recent matches' : `recent ${scope.toLowerCase()} matches`;

  const wins = used.filter((r) => r.outcome === 'W').length;
  const draws = used.filter((r) => r.outcome === 'D').length;
  const losses = n - wins - draws;
  const points = wins * 3 + draws;
  const goalsScored = used.reduce((s, r) => s + r.goalsFor, 0);
  const goalsConceded = used.reduce((s, r) => s + r.goalsAgainst, 0);
  const sufficient = n >= minSample;

  const gate = (m: Metric): Metric => (sufficient ? m : { value: 'DATA UNAVAILABLE', sampleSize: m.sampleSize, window });
  const statMetric = (key: keyof KnownStatLine) => gate(mean(used.map((r) => own(r, key)), window));

  const analysis: FormAnalysis = {
    team,
    scope,
    status: sufficient ? 'AVAILABLE' : 'INSUFFICIENT_DATA',
    sequence: used.map((r) => r.outcome),
    record: { wins, draws, losses },
    points,
    pointsPerGame: gate(n > 0 ? { value: round(points / n), sampleSize: n, window } : { value: 'DATA UNAVAILABLE', sampleSize: 0, window }),
    goalsScored,
    goalsConceded,
    averageGoalsScored: gate(mean(used.map((r) => r.goalsFor), window)),
    averageGoalsConceded: gate(mean(used.map((r) => r.goalsAgainst), window)),
    averagePossession: statMetric('possession'),
    averageShots: statMetric('shots'),
    averageShotsOnTarget: statMetric('shotsOnTarget'),
    averageCorners: statMetric('corners'),
    averageYellowCards: statMetric('yellowCards'),
    averageRedCards: statMetric('redCards'),
    matches: used.map((r) => ({
      matchId: r.matchId,
      matchDate: r.matchDate,
      venue: r.venue,
      opponent: r.opponent,
      goalsFor: r.goalsFor,
      goalsAgainst: r.goalsAgainst,
      outcome: r.outcome,
      dataEnvironment: r.dataEnvironment,
      statsStatus: r.stats.status,
    })),
    metadata: {
      source: 'nexora-knowledge',
      analyzer: `form:${scope.toLowerCase()}`,
      version: FORM_ANALYZER_VERSION,
      calculationWindow: window,
      sampleSize: n,
      cutoff: input.cutoff.toISOString(),
      dataEnvironments: input.environments,
    },
    limitations: [],
  };

  if (n === 0) analysis.limitations.push(`No completed ${subject} were known for ${team.name} before the cutoff.`);
  else if (n < window) analysis.limitations.push(`Only ${n} ${subject} were known for ${team.name} (window ${window}).`);
  if (!sufficient && n > 0) analysis.limitations.push(`${n} ${subject} is below the minimum of ${minSample}; averages withheld.`);
  if (sufficient) {
    const labels: Array<[string, Metric]> = [
      ['Possession', analysis.averagePossession],
      ['Shots', analysis.averageShots],
      ['Shots on target', analysis.averageShotsOnTarget],
      ['Corners', analysis.averageCorners],
      ['Card', analysis.averageYellowCards],
    ];
    for (const [label, metric] of labels) {
      const gap = describeGap(label === 'Card' ? 'Card statistics' : label, metric, n, subject);
      if (gap) analysis.limitations.push(`${team.name}: ${gap}`);
    }
    const late = used.filter((r) => r.stats.status === 'PUBLISHED_AFTER_CUTOFF').length;
    if (late > 0) analysis.limitations.push(`${team.name}: statistics for ${late} match(es) were recorded after the cutoff and were not used.`);
  }
  return analysis;
}
