import { describe, expect, it } from 'vitest';
import { generateDataset } from '../src/data/synthetic/generator.js';
import { SEED_REFERENCE_DATE } from '../src/data/synthetic/reference.js';
import { importTransactionTimeoutMs } from '../src/config/env.js';

const data = generateDataset();

describe('seed dataset', () => {
  it('is deterministic across runs', () => {
    const again = generateDataset();
    expect(JSON.stringify(again)).toBe(JSON.stringify(data));
  });

  it('meets the MVP volume requirements', () => {
    expect(data.teams.length).toBeGreaterThanOrEqual(8);
    expect(data.matches.filter((m) => m.status === 'FINISHED').length).toBeGreaterThanOrEqual(100);
    expect(data.matches.some((m) => m.status === 'SCHEDULED')).toBe(true);
  });

  it('only finishes matches that kicked off before the reference date', () => {
    for (const m of data.matches) {
      const played = m.matchDate.getTime() < SEED_REFERENCE_DATE.getTime();
      expect(m.status).toBe(played ? 'FINISHED' : 'SCHEDULED');
      if (!played) {
        expect(m.homeScore).toBeNull();
        expect(m.awayScore).toBeNull();
      }
    }
  });

  it('keeps scores, team stats and player stats consistent', () => {
    const statsByMatchTeam = new Map(data.matchStats.map((s) => [`${s.matchId}|${s.teamId}`, s]));
    for (const m of data.matches.filter((x) => x.status === 'FINISHED')) {
      for (const [teamId, score] of [[m.homeTeamId, m.homeScore], [m.awayTeamId, m.awayScore]] as const) {
        const team = statsByMatchTeam.get(`${m.id}|${teamId}`);
        expect(team).toBeDefined();
        expect(team!.goals).toBe(score);
        expect(team!.shotsOnTarget).toBeLessThanOrEqual(team!.shots);
        expect(team!.goals).toBeLessThanOrEqual(team!.shotsOnTarget);

        const players = data.playerMatchStats.filter((p) => p.matchId === m.id && p.teamId === teamId);
        const sum = (key: 'goals' | 'shots' | 'shotsOnTarget' | 'yellowCards' | 'redCards') => players.reduce((s, p) => s + p[key], 0);
        expect(sum('goals')).toBe(team!.goals);
        expect(sum('shots')).toBe(team!.shots);
        expect(sum('shotsOnTarget')).toBe(team!.shotsOnTarget);
        expect(sum('yellowCards')).toBe(team!.yellowCards);
        expect(sum('redCards')).toBe(team!.redCards);
        expect(players.filter((p) => p.started).length).toBe(11);
      }
    }
  });

  it('never fields an injured or suspended player', () => {
    const played = new Set(data.playerMatchStats.map((p) => `${p.playerId}|${p.matchId}`));
    for (const a of data.availability) {
      if (a.status === 'INJURED' || a.status === 'SUSPENDED') {
        expect(played.has(`${a.playerId}|${a.matchId}`)).toBe(false);
      }
    }
  });

  it('reports availability before kick-off and never after the reference date', () => {
    const matchById = new Map(data.matches.map((m) => [m.id, m]));
    for (const a of data.availability) {
      const match = matchById.get(a.matchId)!;
      expect(a.reportedAt.getTime()).toBeLessThan(match.matchDate.getTime());
      expect(a.reportedAt.getTime()).toBeLessThanOrEqual(SEED_REFERENCE_DATE.getTime());
    }
  });

  it('includes injuries, suspensions and doubtful players', () => {
    const statuses = new Set(data.availability.map((a) => a.status));
    expect(statuses).toContain('INJURED');
    expect(statuses).toContain('SUSPENDED');
    expect(statuses).toContain('DOUBTFUL');
  });

  it('only publishes availability for each team’s next scheduled fixture', () => {
    const scheduled = new Set(data.matches.filter((m) => m.status === 'SCHEDULED').map((m) => m.id));
    const futureMatchesWithReports = new Set(data.availability.filter((a) => scheduled.has(a.matchId)).map((a) => a.matchId));
    expect(futureMatchesWithReports.size).toBeGreaterThan(0);
    expect(futureMatchesWithReports.size).toBeLessThanOrEqual(data.teams.length);
  });

  it('contains genuine data gaps rather than filled-in values', () => {
    expect(data.matchStats.some((s) => s.corners === null || s.possession === null)).toBe(true);
  });
});

describe('import transaction timeout', () => {
  it('defaults to two minutes, which suits a database on the same host', () => {
    expect(importTransactionTimeoutMs({})).toBe(120_000);
    expect(importTransactionTimeoutMs({ IMPORT_TRANSACTION_TIMEOUT_MS: '' })).toBe(120_000);
  });

  it('can be raised for a managed database across a network', () => {
    // A season against Neon spends its time on round-trips, not work, and overran 120s.
    expect(importTransactionTimeoutMs({ IMPORT_TRANSACTION_TIMEOUT_MS: '600000' })).toBe(600_000);
  });

  it('refuses a value that would hide a hung import or fail instantly', () => {
    for (const bad of ['0', '500', '9999', '99999999', 'soon', '-1']) {
      expect(() => importTransactionTimeoutMs({ IMPORT_TRANSACTION_TIMEOUT_MS: bad })).toThrow(/between 10000 and 1800000/);
    }
  });
});
