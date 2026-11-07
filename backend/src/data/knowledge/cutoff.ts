import type { DataEnvironment } from '@prisma/client';
import { addMs } from '../../utils/time.js';

const HOUR_MS = 60 * 60 * 1000;

// Conservative publication delays: a result is treated as unknown until well after the final whistle.
export const RESULT_KNOWN_AFTER_KICKOFF_MS = 3 * HOUR_MS;
// Date-only fixtures could kick off as late as local midnight, so wait a full day plus the normal delay.
export const RESULT_KNOWN_AFTER_UNKNOWN_KICKOFF_MS = 27 * HOUR_MS;

export interface TimedMatch {
  matchDate: Date;
  kickoffTimeKnown: boolean;
}

// The latest instant whose information may be used for this match. Date-only fixtures are stored at local midnight.
export function informationCutoff(match: TimedMatch): Date {
  return match.matchDate;
}

export function resultKnownAt(match: TimedMatch): Date {
  return addMs(match.matchDate, match.kickoffTimeKnown ? RESULT_KNOWN_AFTER_KICKOFF_MS : RESULT_KNOWN_AFTER_UNKNOWN_KICKOFF_MS);
}

export function isResultKnownBefore(match: TimedMatch, cutoff: Date): boolean {
  return resultKnownAt(match).getTime() < cutoff.getTime();
}

// Real data may draw on any real history; synthetic data is sealed off in both directions.
export function visibleEnvironments(env: DataEnvironment): DataEnvironment[] {
  return env === 'SYNTHETIC' ? ['SYNTHETIC'] : ['HISTORICAL', 'LIVE'];
}

// LIVE statistics count only if Nexora held them, unchanged, before the cutoff. Archives (HISTORICAL/SYNTHETIC)
// were loaded after the fact, so their statistics are assumed published together with the result.
export function areStatsKnownBefore(stats: { createdAt: Date; updatedAt: Date }, matchEnvironment: DataEnvironment, cutoff: Date): boolean {
  if (matchEnvironment !== 'LIVE') return true;
  return stats.createdAt.getTime() < cutoff.getTime() && stats.updatedAt.getTime() < cutoff.getTime();
}
