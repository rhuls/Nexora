import type { ProviderDataEnvironment } from '../types.js';

export const OPENFOOTBALL_SOURCE = 'openfootball';
export const OPENFOOTBALL_BASE_URL = 'https://raw.githubusercontent.com/openfootball/football.json/master/';
// openfootball publishes each league's fixtures in that league's local time.
export const OPENFOOTBALL_EPL_TIMEZONE = 'Europe/London';
const TZ = {
  'en.1': OPENFOOTBALL_EPL_TIMEZONE,
  'es.1': 'Europe/Madrid',
  'de.1': 'Europe/Berlin',
  'it.1': 'Europe/Rome',
  'fr.1': 'Europe/Paris',
} as const;

export interface OpenFootballDataset {
  competitionSourceId: string;
  seasonSourceId: string;
  dataEnvironment: ProviderDataEnvironment;
  timeZone: string;
}

export const OPENFOOTBALL_COMPETITIONS = {
  'en.1': { sourceId: 'en.1', code: 'EPL', name: 'English Premier League', country: 'England' },
  'es.1': { sourceId: 'es.1', code: 'LALIGA', name: 'Spanish La Liga', country: 'Spain' },
  'de.1': { sourceId: 'de.1', code: 'BUNDESLIGA', name: 'German Bundesliga', country: 'Germany' },
  'it.1': { sourceId: 'it.1', code: 'SERIEA', name: 'Italian Serie A', country: 'Italy' },
  'fr.1': { sourceId: 'fr.1', code: 'LIGUE1', name: 'French Ligue 1', country: 'France' },
} as const;

// Allowlist: only these files can be fetched or imported. Completed seasons are HISTORICAL; the current season is LIVE.
// Every league openfootball publishes for these seasons is listed, so widening coverage is an import, not a code change.
export const OPENFOOTBALL_DATASETS: readonly OpenFootballDataset[] = (
  ['en.1', 'es.1', 'de.1', 'it.1', 'fr.1'] as const
).flatMap((competitionSourceId) =>
  (
    [
      ['2023-24', 'HISTORICAL'],
      ['2024-25', 'HISTORICAL'],
      ['2025-26', 'HISTORICAL'],
      ['2026-27', 'LIVE'],
    ] as const
  ).map(([seasonSourceId, dataEnvironment]) => ({
    competitionSourceId,
    seasonSourceId,
    dataEnvironment: dataEnvironment as ProviderDataEnvironment,
    timeZone: TZ[competitionSourceId],
  })),
);

export function findOpenFootballDataset(competitionSourceId: string, seasonSourceId: string): OpenFootballDataset | undefined {
  return OPENFOOTBALL_DATASETS.find((d) => d.competitionSourceId === competitionSourceId && d.seasonSourceId === seasonSourceId);
}

export function openFootballUrl(dataset: Pick<OpenFootballDataset, 'competitionSourceId' | 'seasonSourceId'>): string {
  return `${OPENFOOTBALL_BASE_URL}${dataset.seasonSourceId}/${dataset.competitionSourceId}.json`;
}

export function seasonDisplayName(seasonSourceId: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(seasonSourceId);
  return match ? `${match[1]}/${match[2]}` : seasonSourceId;
}
