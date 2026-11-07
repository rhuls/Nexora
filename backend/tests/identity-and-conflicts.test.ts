import { describe, expect, it } from 'vitest';
import { CURATED_EPL_TEAMS } from '../src/data/identity/curated-teams.js';
import { normalizeTeamName } from '../src/data/identity/team-identity.js';
import { coreDifferences } from '../src/data/import/football-data.importer.js';
import { CURATED_TEAMS } from '../src/data/identity/curated-teams.js';
import { OPENFOOTBALL_DATASETS } from '../src/providers/openfootball/datasets.js';

describe('team name normalisation', () => {
  it('only removes case, accents, punctuation and spacing differences', () => {
    expect(normalizeTeamName('Brighton & Hove Albion FC')).toBe('brighton and hove albion fc');
    expect(normalizeTeamName('  brighton  AND hove-albion fc ')).toBe('brighton and hove albion fc');
    expect(normalizeTeamName('Atlético')).toBe('atletico');
  });

  it('does not equate abbreviations with full names (no fuzzy matching)', () => {
    expect(normalizeTeamName('Man United')).not.toBe(normalizeTeamName('Manchester United FC'));
    expect(normalizeTeamName('Manchester Utd')).not.toBe(normalizeTeamName('Manchester United FC'));
    expect(normalizeTeamName('Man City')).not.toBe(normalizeTeamName('Manchester City FC'));
  });
});

describe('curated EPL identities', () => {
  it('has unique keys, names and short names', () => {
    for (const field of ['key', 'name', 'shortName'] as const) {
      const values = CURATED_EPL_TEAMS.map((t) => t[field]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('never maps one spelling to two clubs within a source', () => {
    const seen = new Map<string, string>();
    for (const team of CURATED_EPL_TEAMS) {
      for (const [source, spellings] of Object.entries(team.aliases)) {
        for (const spelling of spellings) {
          const key = `${source}|${normalizeTeamName(spelling)}`;
          expect(seen.get(key) ?? team.key).toBe(team.key);
          seen.set(key, team.key);
        }
      }
    }
  });
});

describe('historical conflict detection', () => {
  const stored = {
    homeTeamId: 'a', awayTeamId: 'b', matchDate: new Date('2024-01-01T15:00:00Z'), kickoffTimeKnown: true, sourceMatchDate: '2024-01-01 15:00',
    status: 'FINISHED' as const, homeScore: 2, awayScore: 1, homeHalfTimeScore: 1, awayHalfTimeScore: 0,
  };

  it('finds no difference for an identical record', () => {
    expect(coreDifferences(stored, { ...stored, matchDate: new Date(stored.matchDate) })).toEqual([]);
  });

  it('names every field the source changed', () => {
    expect(coreDifferences(stored, { ...stored, homeScore: 3, matchDate: new Date('2024-01-02T15:00:00Z') })).toEqual(['matchDate', 'homeScore']);
  });

  it('treats a newly missing half-time score as a difference, not as permission to erase', () => {
    expect(coreDifferences(stored, { ...stored, homeHalfTimeScore: null })).toEqual(['homeHalfTimeScore']);
  });
});

describe('curated identities across the five leagues', () => {
  it('covers every club openfootball names, with no duplicate key or alias', () => {
    const keys = CURATED_TEAMS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);

    // An alias spelling must point at exactly one club, or matching would be ambiguous.
    const spellings = CURATED_TEAMS.flatMap((t) => (t.aliases.openfootball ?? []).map((a) => a.toLowerCase()));
    expect(new Set(spellings).size).toBe(spellings.length);

    const byCountry = new Map<string, number>();
    for (const t of CURATED_TEAMS) byCountry.set(t.country, (byCountry.get(t.country) ?? 0) + 1);
    expect([...byCountry.keys()].sort()).toEqual(['England', 'France', 'Germany', 'Italy', 'Spain']);
    for (const [, n] of byCountry) expect(n).toBeGreaterThanOrEqual(18);
  });

  it('gives every club a display name and a short name, distinct within its country', () => {
    for (const t of CURATED_TEAMS) {
      expect(t.name.length).toBeGreaterThan(1);
      expect(t.shortName.length).toBeGreaterThanOrEqual(2);
      expect(t.aliases.openfootball?.length ?? 0).toBeGreaterThan(0);
    }
    for (const country of ['England', 'Spain', 'Germany', 'Italy', 'France']) {
      const codes = CURATED_TEAMS.filter((t) => t.country === country).map((t) => t.shortName);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('allows every league and season the backbone publishes', () => {
    const competitions = new Set(OPENFOOTBALL_DATASETS.map((d) => d.competitionSourceId));
    expect([...competitions].sort()).toEqual(['de.1', 'en.1', 'es.1', 'fr.1', 'it.1']);
    // Exactly one LIVE season per competition; the rest are historical.
    for (const c of competitions) {
      const live = OPENFOOTBALL_DATASETS.filter((d) => d.competitionSourceId === c && d.dataEnvironment === 'LIVE');
      expect(live).toHaveLength(1);
      expect(live[0]!.seasonSourceId).toBe('2026-27');
    }
    // Each league keeps its own local time, which is what the importer converts from.
    expect(OPENFOOTBALL_DATASETS.find((d) => d.competitionSourceId === 'es.1')!.timeZone).toBe('Europe/Madrid');
    expect(OPENFOOTBALL_DATASETS.find((d) => d.competitionSourceId === 'it.1')!.timeZone).toBe('Europe/Rome');
  });
});
