import { describe, expect, it } from 'vitest';
import { analyzeForm } from '../src/analysis/form.analyzer.js';
import { analyzeHeadToHead, effectiveSampleSize, timeWeight } from '../src/analysis/h2h.analyzer.js';
import { analyzeHomeAway } from '../src/analysis/home-away.analyzer.js';
import { areStatsKnownBefore } from '../src/data/knowledge/cutoff.js';
import type { KnownResult, KnownStatLine } from '../src/data/knowledge/knowledge.service.js';

const CUTOFF = new Date('2025-01-01T15:00:00Z');
const TEAM = { id: 't1', name: 'Team One' };
const OPP = { id: 't2', name: 'Team Two' };
const DAY = 86_400_000;

const line = (v: Partial<KnownStatLine> = {}): KnownStatLine => ({
  possession: null, shots: null, shotsOnTarget: null, corners: null, yellowCards: null, redCards: null, fouls: null, offsides: null, ...v,
});

function result(daysAgo: number, gf: number, ga: number, venue: 'HOME' | 'AWAY' = 'HOME', own?: Partial<KnownStatLine>, opp?: Partial<KnownStatLine>): KnownResult {
  const date = new Date(CUTOFF.getTime() - daysAgo * DAY);
  const known = own !== undefined || opp !== undefined;
  return {
    matchId: `m${daysAgo}`,
    matchDate: date.toISOString(),
    resultKnownAt: new Date(date.getTime() + 3 * 3_600_000).toISOString(),
    dataEnvironment: 'HISTORICAL',
    venue,
    opponent: OPP,
    goalsFor: gf,
    goalsAgainst: ga,
    outcome: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
    statsRecorded: known,
    stats: known ? { status: 'KNOWN', for: line(own), against: line(opp) } : { status: 'NOT_RECORDED', for: null, against: null },
  };
}

const base = { team: TEAM, window: 5, cutoff: CUTOFF, environments: ['HISTORICAL' as const, 'LIVE' as const] };

describe('form analyzer', () => {
  it('counts the record, points and goals over the window, most recent first', () => {
    const f = analyzeForm({ ...base, scope: 'ALL', results: [result(3, 2, 0), result(10, 1, 1), result(17, 0, 2), result(24, 3, 1), result(31, 2, 2), result(38, 5, 0)] });
    expect(f.sequence).toEqual(['W', 'D', 'L', 'W', 'D']);
    expect(f.record).toEqual({ wins: 2, draws: 2, losses: 1 });
    expect(f.points).toBe(8);
    expect(f.pointsPerGame).toEqual({ value: 1.6, sampleSize: 5, window: 5 });
    expect([f.goalsScored, f.goalsConceded]).toEqual([8, 6]);
    expect(f.averageGoalsScored).toEqual({ value: 1.6, sampleSize: 5, window: 5 });
    expect(f.matches.map((m) => m.matchId)).not.toContain('m38');
  });

  it('averages statistics only over matches that supplied them and reports the gap', () => {
    const f = analyzeForm({
      ...base,
      scope: 'ALL',
      results: [result(3, 1, 0, 'HOME', { shots: 10, corners: 6 }), result(10, 1, 0, 'HOME', { shots: 14, corners: null }), result(17, 1, 0), result(24, 1, 0, 'HOME', { shots: 12 })],
    });
    expect(f.averageShots).toEqual({ value: 12, sampleSize: 3, window: 5 });
    expect(f.averageCorners).toEqual({ value: 6, sampleSize: 1, window: 5 });
    expect(f.averagePossession).toEqual({ value: 'DATA UNAVAILABLE', sampleSize: 0, window: 5 });
    expect(f.limitations).toEqual(expect.arrayContaining([
      'Only 4 recent matches were known for Team One (window 5).',
      'Team One: Shots unavailable for 1 of 4 recent matches.',
      'Team One: Corners unavailable for 3 of 4 recent matches.',
      'Team One: Possession unavailable for all 4 recent matches.',
    ]));
  });

  it('returns DATA UNAVAILABLE rather than zeros when nothing is known', () => {
    const f = analyzeForm({ ...base, scope: 'ALL', results: [] });
    expect(f.status).toBe('INSUFFICIENT_DATA');
    expect(f.averageGoalsScored.value).toBe('DATA UNAVAILABLE');
    expect(f.pointsPerGame.value).toBe('DATA UNAVAILABLE');
    expect(f.sequence).toEqual([]);
  });

  it('withholds home/away averages below the minimum sample but still shows the record', () => {
    const split = analyzeHomeAway({ ...base, homeResults: [result(3, 2, 0, 'HOME'), result(17, 1, 0, 'HOME')], awayResults: [result(10, 0, 1, 'AWAY'), result(24, 1, 1, 'AWAY'), result(31, 2, 1, 'AWAY')] });
    expect(split.home.status).toBe('INSUFFICIENT_DATA');
    expect(split.home.record).toEqual({ wins: 2, draws: 0, losses: 0 });
    expect(split.home.averageGoalsScored.value).toBe('DATA UNAVAILABLE');
    expect(split.away.status).toBe('AVAILABLE');
    expect(split.away.averageGoalsScored).toEqual({ value: 1, sampleSize: 3, window: 5 });
    expect(split.home.metadata).toMatchObject({ analyzer: 'form:home', calculationWindow: 5, sampleSize: 2, cutoff: CUTOFF.toISOString() });
  });

  it('never lets a venue split include the other venue', () => {
    const split = analyzeHomeAway({ ...base, homeResults: [result(3, 2, 0, 'AWAY'), result(10, 1, 0, 'HOME')], awayResults: [] });
    expect(split.home.matches.map((m) => m.venue)).toEqual(['HOME']);
  });
});

describe('head-to-head analyzer', () => {
  it('halves the weight every half-life and computes the effective sample size', () => {
    expect(timeWeight(0, 365)).toBe(1);
    expect(timeWeight(365, 365)).toBeCloseTo(0.5, 10);
    expect(timeWeight(730, 365)).toBeCloseTo(0.25, 10);
    expect(effectiveSampleSize([1, 1, 1, 1])).toBeCloseTo(4, 10);
    expect(effectiveSampleSize([1, 0.25])).toBeCloseTo(1.25 ** 2 / 1.0625, 10);
  });

  it('weights recent meetings more heavily than old ones', () => {
    const h = analyzeHeadToHead({ subjectHome: TEAM, subjectAway: OPP, meetings: [result(30, 4, 0), result(1095, 0, 0)], cutoff: CUTOFF, environments: ['HISTORICAL'] });
    expect(h.totalGoals.unweighted.value).toBe(2);
    expect(h.totalGoals.timeWeighted.value).toBeGreaterThan(3.5);
    expect(h.meetings[0]!.weight).toBeGreaterThan(h.meetings[1]!.weight);
    expect(h.results).toEqual({ subjectHomeWins: 1, draws: 1, subjectAwayWins: 0 });
  });

  it('reports low reliability for thin or old samples so H2H cannot dominate', () => {
    const recentFive = analyzeHeadToHead({ subjectHome: TEAM, subjectAway: OPP, meetings: [1, 2, 3, 4, 5].map((d) => result(d, 1, 1)), cutoff: CUTOFF, environments: ['HISTORICAL'] });
    const oneOld = analyzeHeadToHead({ subjectHome: TEAM, subjectAway: OPP, meetings: [result(900, 1, 0)], cutoff: CUTOFF, environments: ['HISTORICAL'] });
    expect(recentFive.reliability).toBeCloseTo(1, 2);
    expect(oneOld.reliability).toBe(0.2);
    expect(oneOld.limitations.join(' ')).toMatch(/effective sample/);
  });

  it('reports meetings from the upcoming home team perspective regardless of where they were played', () => {
    const h = analyzeHeadToHead({ subjectHome: TEAM, subjectAway: OPP, meetings: [result(20, 0, 2, 'AWAY')], cutoff: CUTOFF, environments: ['HISTORICAL'] });
    expect(h.meetings[0]).toMatchObject({ homeTeamOfMeeting: 'SUBJECT_AWAY', subjectHomeGoals: 0, subjectAwayGoals: 2, outcomeForSubjectHome: 'L' });
    expect(h.results.subjectAwayWins).toBe(1);
  });

  it('only totals a statistic when both teams supplied it', () => {
    const h = analyzeHeadToHead({
      subjectHome: TEAM,
      subjectAway: OPP,
      meetings: [result(10, 1, 0, 'HOME', { corners: 6 }, { corners: 4 }), result(40, 1, 0, 'HOME', { corners: 5 }, { corners: null })],
      cutoff: CUTOFF,
      environments: ['HISTORICAL'],
    });
    expect(h.totalCorners.unweighted).toEqual({ value: 10, sampleSize: 1, window: 5 });
  });

  it('is unavailable, not zero, with no meetings', () => {
    const h = analyzeHeadToHead({ subjectHome: TEAM, subjectAway: OPP, meetings: [], cutoff: CUTOFF, environments: ['HISTORICAL'] });
    expect(h.status).toBe('NO_MEETINGS');
    expect(h.totalGoals.timeWeighted.value).toBe('DATA UNAVAILABLE');
    expect(h.effectiveSampleSize).toBe(0);
  });
});

describe('statistics knowability', () => {
  const at = (iso: string) => new Date(iso);
  it('accepts LIVE statistics only if stored and unchanged before the cutoff', () => {
    expect(areStatsKnownBefore({ createdAt: at('2025-01-01T10:00Z'), updatedAt: at('2025-01-01T10:00Z') }, 'LIVE', CUTOFF)).toBe(true);
    expect(areStatsKnownBefore({ createdAt: at('2025-01-01T10:00Z'), updatedAt: at('2025-01-02T10:00Z') }, 'LIVE', CUTOFF)).toBe(false);
    expect(areStatsKnownBefore({ createdAt: at('2025-01-02T10:00Z'), updatedAt: at('2025-01-02T10:00Z') }, 'LIVE', CUTOFF)).toBe(false);
  });

  it('treats archived statistics as published with the result', () => {
    expect(areStatsKnownBefore({ createdAt: at('2026-09-28T00:00Z'), updatedAt: at('2026-09-28T00:00Z') }, 'HISTORICAL', CUTOFF)).toBe(true);
    expect(areStatsKnownBefore({ createdAt: at('2026-09-28T00:00Z'), updatedAt: at('2026-09-28T00:00Z') }, 'SYNTHETIC', CUTOFF)).toBe(true);
  });
});
