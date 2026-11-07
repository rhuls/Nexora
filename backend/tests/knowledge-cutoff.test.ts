import { describe, expect, it } from 'vitest';
import { informationCutoff, isResultKnownBefore, resultKnownAt, visibleEnvironments } from '../src/data/knowledge/cutoff.js';

const at = (iso: string, kickoffTimeKnown = true) => ({ matchDate: new Date(iso), kickoffTimeKnown });

describe('information cutoff', () => {
  it('uses kickoff as the cutoff', () => {
    expect(informationCutoff(at('2024-01-01T15:00:00Z')).toISOString()).toBe('2024-01-01T15:00:00.000Z');
  });

  it('treats a result as public only three hours after kickoff', () => {
    expect(resultKnownAt(at('2024-01-01T12:30:00Z')).toISOString()).toBe('2024-01-01T15:30:00.000Z');
  });

  it('waits a full extra day when the source gave no kickoff time', () => {
    expect(resultKnownAt(at('2024-01-01T00:00:00Z', false)).toISOString()).toBe('2024-01-02T03:00:00.000Z');
  });

  it('excludes a same-day match whose result was not yet public at kickoff', () => {
    const cutoff = new Date('2024-01-01T15:00:00Z');
    expect(isResultKnownBefore(at('2024-01-01T11:30:00Z'), cutoff)).toBe(true);
    expect(isResultKnownBefore(at('2024-01-01T12:00:00Z'), cutoff)).toBe(false);
    expect(isResultKnownBefore(at('2024-01-01T12:30:00Z'), cutoff)).toBe(false);
    expect(isResultKnownBefore(at('2024-01-01T14:00:00Z'), cutoff)).toBe(false);
  });

  it('is strict at the boundary', () => {
    const cutoff = new Date('2024-01-01T15:30:00Z');
    expect(isResultKnownBefore(at('2024-01-01T12:30:00Z'), cutoff)).toBe(false);
    expect(isResultKnownBefore(at('2024-01-01T12:29:59Z'), cutoff)).toBe(true);
  });

  it('never treats a future match as known', () => {
    expect(isResultKnownBefore(at('2024-01-02T15:00:00Z'), new Date('2024-01-01T15:00:00Z'))).toBe(false);
  });
});

describe('data environment visibility', () => {
  it('seals synthetic data off from real data in both directions', () => {
    expect(visibleEnvironments('SYNTHETIC')).toEqual(['SYNTHETIC']);
    expect(visibleEnvironments('HISTORICAL')).not.toContain('SYNTHETIC');
    expect(visibleEnvironments('LIVE')).not.toContain('SYNTHETIC');
  });

  it('lets live analysis use real history', () => {
    expect(visibleEnvironments('LIVE')).toEqual(expect.arrayContaining(['HISTORICAL', 'LIVE']));
  });
});
