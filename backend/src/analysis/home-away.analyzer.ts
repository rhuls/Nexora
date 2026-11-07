import type { DataEnvironment } from '@prisma/client';
import type { KnownResult } from '../data/knowledge/knowledge.service.js';
import { analyzeForm, type FormAnalysis } from './form.analyzer.js';

export interface HomeAwayAnalysis {
  team: { id: string; name: string };
  home: FormAnalysis;
  away: FormAnalysis;
}

// Splits come from each team's own last N home and last N away matches, fetched separately (not a filter of the overall window).
export function analyzeHomeAway(input: {
  team: { id: string; name: string };
  window: number;
  homeResults: readonly KnownResult[];
  awayResults: readonly KnownResult[];
  cutoff: Date;
  environments: DataEnvironment[];
  minSample?: number;
}): HomeAwayAnalysis {
  const base = { team: input.team, window: input.window, cutoff: input.cutoff, environments: input.environments, minSample: input.minSample };
  return {
    team: input.team,
    home: analyzeForm({ ...base, scope: 'HOME', results: input.homeResults.filter((r) => r.venue === 'HOME') }),
    away: analyzeForm({ ...base, scope: 'AWAY', results: input.awayResults.filter((r) => r.venue === 'AWAY') }),
  };
}
