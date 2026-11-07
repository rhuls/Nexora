import { describe, expect, it } from 'vitest';
import type { OpenFootballDataset } from '../src/providers/openfootball/datasets.js';
import { matchSourceId, parseOpenFootballFile, parseScore } from '../src/providers/openfootball/parser.js';
import { zonedLocalToUtc } from '../src/utils/time.js';

const DATASET: OpenFootballDataset = { competitionSourceId: 'en.1', seasonSourceId: '2025-26', dataEnvironment: 'HISTORICAL', timeZone: 'Europe/London' };
const NOW = new Date('2026-09-27T10:00:00Z');

const file = (matches: unknown[]) => JSON.stringify({ name: 'English Premier League 2025/26', matches });
const base = { round: 'Matchday 1', date: '2025-08-16', time: '15:00', team1: 'Arsenal FC', team2: 'Chelsea FC' };

describe('openfootball score parsing', () => {
  it('reads labelled full-time and half-time scores', () => {
    expect(parseScore({ ft: [2, 1], ht: [1, 0] })).toEqual({ fullTime: [2, 1], halfTime: [1, 0], shape: 'labelled', unknownKeys: [] });
  });

  it('treats an unlabelled array as full-time only and never infers half-time', () => {
    expect(parseScore([0, 0])).toEqual({ fullTime: [0, 0], halfTime: null, shape: 'bare-array', unknownKeys: [] });
  });

  it('reports missing scores as missing', () => {
    expect(parseScore(undefined).shape).toBe('missing');
  });

  it('rejects impossible scores', () => {
    expect(() => parseScore({ ft: [1, 0], ht: [2, 0] })).toThrow(/exceeds/);
    expect(() => parseScore({ ft: [-1, 0] })).toThrow();
    expect(() => parseScore({ ft: [1.5, 0] })).toThrow();
    expect(() => parseScore([1, 2, 3])).toThrow();
  });
});

describe('openfootball file parsing', () => {
  it('normalises a finished match and preserves the original date text', () => {
    const { matches, warnings } = parseOpenFootballFile(file([{ ...base, score: { ft: [2, 1], ht: [1, 1] } }]), DATASET, NOW);
    expect(warnings).toEqual([]);
    expect(matches[0]).toMatchObject({
      sourceId: 'en.1/2025-26/Arsenal FC~Chelsea FC',
      status: 'FINISHED',
      round: 'Matchday 1',
      sourceMatchDate: '2025-08-16 15:00',
      kickoffTimeKnown: true,
      homeScore: 2,
      awayScore: 1,
      homeHalfTimeScore: 1,
      awayHalfTimeScore: 1,
      homeTeam: { sourceId: null, name: 'Arsenal FC' },
    });
    expect(matches[0]!.kickoff.toISOString()).toBe('2025-08-16T14:00:00.000Z');
  });

  it('warns about unlabelled scores and leaves half-time unavailable', () => {
    const { matches, warnings } = parseOpenFootballFile(file([{ ...base, score: [0, 0] }]), DATASET, NOW);
    expect(matches[0]).toMatchObject({ status: 'FINISHED', homeScore: 0, awayScore: 0, homeHalfTimeScore: null, awayHalfTimeScore: null });
    expect(warnings.map((w) => w.code)).toEqual(['SCORE_UNLABELLED']);
  });

  it('keeps future fixtures without a score as SCHEDULED', () => {
    const { matches } = parseOpenFootballFile(file([{ ...base, date: '2026-10-10' }]), DATASET, NOW);
    expect(matches[0]).toMatchObject({ status: 'SCHEDULED', homeScore: null, awayScore: null });
  });

  it('keeps a past fixture without a result SCHEDULED (awaiting result) and never invents one', () => {
    const { matches, warnings } = parseOpenFootballFile(file([base]), DATASET, NOW);
    expect(matches[0]).toMatchObject({ status: 'SCHEDULED', homeScore: null, awayScore: null });
    expect(warnings.map((w) => w.code)).toEqual(['RESULT_PENDING']);
  });

  it('does not flag a future fixture as awaiting a result', () => {
    const { warnings } = parseOpenFootballFile(file([{ ...base, date: '2026-10-10' }]), DATASET, NOW);
    expect(warnings).toEqual([]);
  });

  it('warns when the source gives full-time but no half-time', () => {
    const { matches, warnings } = parseOpenFootballFile(file([{ ...base, score: { ft: [3, 1] } }]), DATASET, NOW);
    expect(matches[0]).toMatchObject({ homeScore: 3, awayScore: 1, homeHalfTimeScore: null, awayHalfTimeScore: null });
    expect(warnings.map((w) => w.code)).toEqual(['HALF_TIME_MISSING']);
  });

  it('marks date-only fixtures as having an unknown kickoff time', () => {
    const { time: _omit, ...dateOnly } = base;
    const { matches, warnings } = parseOpenFootballFile(file([{ ...dateOnly, score: { ft: [1, 0] } }]), DATASET, NOW);
    expect(matches[0]).toMatchObject({ kickoffTimeKnown: false, sourceMatchDate: '2025-08-16' });
    expect(matches[0]!.kickoff.toISOString()).toBe('2025-08-15T23:00:00.000Z');
    expect(warnings.map((w) => w.code)).toContain('KICKOFF_TIME_UNKNOWN');
  });

  it('rejects duplicate fixtures, self-matches and malformed files', () => {
    const ok = { ...base, score: { ft: [1, 0] } };
    expect(() => parseOpenFootballFile(file([ok, ok]), DATASET, NOW)).toThrow(/duplicate/);
    expect(() => parseOpenFootballFile(file([{ ...ok, team2: 'Arsenal FC' }]), DATASET, NOW)).toThrow(/itself/);
    expect(() => parseOpenFootballFile('not json', DATASET, NOW)).toThrow(/not valid JSON/);
    expect(() => parseOpenFootballFile(file([{ ...ok, date: '16/08/2025' }]), DATASET, NOW)).toThrow();
  });

  it('builds source IDs from the ordered pair so a rescheduled date keeps the same identity', () => {
    expect(matchSourceId(DATASET, { team1: 'A', team2: 'B' })).toBe('en.1/2025-26/A~B');
    expect(matchSourceId(DATASET, { team1: 'B', team2: 'A' })).not.toBe(matchSourceId(DATASET, { team1: 'A', team2: 'B' }));
  });
});

describe('UK local time conversion', () => {
  it.each([
    ['2023-08-11', '20:00', '2023-08-11T19:00:00.000Z'],
    ['2023-12-26', '15:00', '2023-12-26T15:00:00.000Z'],
    ['2024-03-31', '15:00', '2024-03-31T14:00:00.000Z'],
    ['2024-10-27', '15:00', '2024-10-27T15:00:00.000Z'],
    ['2024-03-30', '17:30', '2024-03-30T17:30:00.000Z'],
  ])('%s %s Europe/London is %s', (date, time, expected) => {
    expect(zonedLocalToUtc(date, time, 'Europe/London').toISOString()).toBe(expected);
  });
});
