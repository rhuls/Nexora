import { describe, expect, it } from 'vitest';
import { actualOutcome, brierOf } from '../src/services/debate-settlement.service.js';

describe('settling a debate pick', () => {
  it('reads the actual outcome of each market from the score', () => {
    expect(actualOutcome('MATCH_RESULT', 2, 1)).toBe('home');
    expect(actualOutcome('MATCH_RESULT', 1, 2)).toBe('away');
    expect(actualOutcome('MATCH_RESULT', 1, 1)).toBe('draw');

    expect(actualOutcome('OVER_UNDER_25', 2, 1)).toBe('over');
    expect(actualOutcome('OVER_UNDER_25', 1, 1)).toBe('under');
    // 2.5 cannot be landed on, so a 2-0 is under and a 2-1 is over.
    expect(actualOutcome('OVER_UNDER_25', 2, 0)).toBe('under');

    expect(actualOutcome('BTTS', 1, 1)).toBe('yes');
    expect(actualOutcome('BTTS', 3, 0)).toBe('no');
    expect(actualOutcome('BTTS', 0, 0)).toBe('no');
  });

  it('scores Brier over every priced outcome, rewarding the confident correct call', () => {
    const certain = brierOf({ home: 1, draw: 0, away: 0 }, 'home');
    const wrong = brierOf({ home: 1, draw: 0, away: 0 }, 'away');
    const hedged = brierOf({ home: 0.34, draw: 0.33, away: 0.33 }, 'home');
    expect(certain).toBeCloseTo(0, 10);
    expect(wrong).toBeCloseTo(2, 10);
    expect(hedged).toBeGreaterThan(certain);
    expect(hedged).toBeLessThan(wrong);
  });

  it('scores a binary market on its own two outcomes', () => {
    expect(brierOf({ over: 0.6, under: 0.4 }, 'over')).toBeCloseTo(0.32, 10);
    expect(brierOf({ yes: 0.5, no: 0.5 }, 'no')).toBeCloseTo(0.5, 10);
  });
});
