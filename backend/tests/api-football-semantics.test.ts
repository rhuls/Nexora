import { describe, expect, it } from 'vitest';
import { FEATURE_NAMES, type FeatureName, type MatchFeatureVector } from '../src/features/feature-engineering.service.js';
import { ENRICHMENT_ONLY_FEATURES, createModelAdapters, withoutEnrichmentFeatures } from '../src/models/adapters.js';
import { attachCardEvidence, parseEvents, parseFixtures, parseStatistics, STAT_NULL_MEANING } from '../src/providers/api-football/normalize.js';
import type { SourceWarning } from '../src/providers/types.js';
import { loadFixture } from './helpers/api-football-mock.js';

const FIXTURE = loadFixture<Record<string, unknown>>('fixture-1035038.json');
const match = parseFixtures([FIXTURE], [])[0]!.match;

describe('card and null-statistic semantics', () => {
  it('defaults every statistic to "null means unknown" until evidence says otherwise', () => {
    expect(STAT_NULL_MEANING).toEqual({});
    const [home] = parseStatistics(FIXTURE.statistics as unknown[], match, []);
    expect(home!.redCards).toBeNull();
    expect(home!.goalkeeperSaves).toBe(0);
    expect(home!.yellowCards).toBe(1);
  });

  it('keeps the provider value verbatim beside the normalised one', () => {
    const [home] = parseStatistics(FIXTURE.statistics as unknown[], match, []);
    expect(home!.raw).toMatchObject({ 'Red Cards': null, 'Ball Possession': '78%', 'Goalkeeper Saves': 0, expected_goals: '2.39' });
    expect(home!.possession).toBe(78);
    expect(home!.additional?.expectedGoals).toBeCloseTo(2.39);
  });

  it('applies an evidence-based ZERO policy only to the statistic it names', () => {
    const [home] = parseStatistics(FIXTURE.statistics as unknown[], match, [], { 'Red Cards': 'ZERO' });
    expect(home!.redCards).toBe(0);
    const stats = [{ team: { id: 42, name: 'Arsenal' }, statistics: [{ type: 'Red Cards', value: null }, { type: 'Corner Kicks', value: null }] }];
    const [row] = parseStatistics(stats, match, [], { 'Red Cards': 'ZERO' });
    expect(row).toMatchObject({ redCards: 0, corners: null });
  });

  it('records event-log card counts as evidence without overwriting the statistic', () => {
    const warnings: SourceWarning[] = [];
    const stats = parseStatistics(FIXTURE.statistics as unknown[], match, warnings);
    const events = parseEvents(FIXTURE.events as unknown[], match, warnings);
    attachCardEvidence(stats, events, match, warnings);
    expect(stats[0]!.derived).toEqual({ yellowCardEvents: 1, secondYellowEvents: 0, redCardEvents: 0 });
    expect(stats[1]!.derived).toEqual({ yellowCardEvents: 1, secondYellowEvents: 0, redCardEvents: 0 });
    expect(stats.every((s) => s.redCards === null)).toBe(true);
    expect(warnings.filter((w) => w.code === 'RED_CARDS_NULL_NO_DISMISSAL_EVENTS')).toHaveLength(2);
  });

  it('flags a null red-card statistic that contradicts a dismissal in the event log', () => {
    const warnings: SourceWarning[] = [];
    const stats = parseStatistics(FIXTURE.statistics as unknown[], match, warnings);
    const red = { time: { elapsed: 60, extra: null }, team: { id: 65, name: 'Nottingham Forest' }, player: { id: 9, name: 'X' }, assist: {}, type: 'Card', detail: 'Red Card', comments: null };
    attachCardEvidence(stats, parseEvents([red], match, warnings), match, warnings);
    expect(warnings.some((w) => w.code === 'RED_CARDS_NULL_WITH_DISMISSAL_EVENTS' && w.message.includes('Nottingham Forest'))).toBe(true);
    expect(stats[1]!.redCards).toBeNull();
  });

  it('flags a known card statistic that disagrees with the event log', () => {
    const warnings: SourceWarning[] = [];
    const stats = parseStatistics([{ team: { id: 42, name: 'Arsenal' }, statistics: [{ type: 'Red Cards', value: 1 }] }], match, warnings);
    attachCardEvidence(stats, [], match, warnings);
    expect(warnings.map((w) => w.code)).toContain('RED_CARDS_EVENT_MISMATCH');
    expect(stats[0]!.redCards).toBe(1);
  });
});

describe('result models stay isolated from enrichment-only features (Step 3A)', () => {
  const vector = (env: MatchFeatureVector['dataEnvironment'], values: Partial<Record<FeatureName, number>>): MatchFeatureVector => ({
    matchId: 'm',
    dataEnvironment: env,
    asOf: '2024-01-01T00:00:00.000Z',
    featureSetVersion: '2.0.0',
    features: Object.fromEntries(FEATURE_NAMES.map((n) => [n, { value: values[n] ?? null, source: 'test', window: 5, sampleSize: values[n] === undefined ? 0 : 5, asOf: '2024-01-01T00:00:00.000Z' }])) as MatchFeatureVector['features'],
  });
  // Early-season shape: ratings not yet settled, so the result comes from the legacy fallback that reads statistics.
  const base: Partial<Record<FeatureName, number>> = {
    recentFormHome: 2, recentFormAway: 1.2, goalsHomeAverage: 1.8, goalsAwayAverage: 1.1, concededHomeAverage: 0.9, concededAwayAverage: 1.5,
    leagueHomeGoals: 1.55, leagueAwayGoals: 1.25, homeAdvantage: 0.3,
  };
  const enriched: Partial<Record<FeatureName, number>> = {
    ...base, shotsHomeAverage: 17, shotsAwayAverage: 9, shotsOnTargetHomeAverage: 6.5, shotsOnTargetAwayAverage: 2.1, goalsPerShotOnTarget: 0.33,
    cornersHomeAverage: 7, cornersAwayAverage: 3, possessionHomeAverage: 62, possessionAwayAverage: 38, cardsHomeAverage: 1.5, cardsAwayAverage: 2.5,
    availabilityHomeImpact: 0, availabilityAwayImpact: 1.4, availabilityHomeAttacking: 0, availabilityAwayAttacking: 0.8, availabilityHomeDefensive: 0, availabilityAwayDefensive: 0.6,
  };
  const ctx = { weights: { recentForm: 0.25, shotsOnTarget: 0.15, goals: 0.15, availability: 0.15, homeAway: 0.1, h2h: 0.1, corners: 0.05, discipline: 0.05 }, modelVersion: 't' };

  for (const set of ['ratings', 'legacy'] as const) {
    it(`${set}: real-data result and goal forecasts ignore statistics and availability; totals still use them`, async () => {
      const adapters = createModelAdapters(set);
      for (const adapter of [adapters.mathematical, adapters.dataAnalysis]) {
        const plain = await adapter.run(vector('HISTORICAL', base), ctx);
        const rich = await adapter.run(vector('HISTORICAL', enriched), ctx);
        if (!plain.ok || !rich.ok) throw new Error('model failed');
        expect(rich.output.forecasts.MATCH_RESULT).toEqual(plain.output.forecasts.MATCH_RESULT);
        expect(rich.output.forecasts.GOALS).toEqual(plain.output.forecasts.GOALS);
        expect(plain.output.forecasts.CORNERS).toBeUndefined();
        expect(rich.output.forecasts.CORNERS).toBeGreaterThan(0);
      }
    });
  }

  it('synthetic data keeps its original behaviour (statistics still inform its fallback result)', async () => {
    const { dataAnalysis } = createModelAdapters('ratings');
    const plain = await dataAnalysis.run(vector('SYNTHETIC', base), ctx);
    const rich = await dataAnalysis.run(vector('SYNTHETIC', enriched), ctx);
    if (!plain.ok || !rich.ok) throw new Error('model failed');
    expect(rich.output.forecasts.MATCH_RESULT).not.toEqual(plain.output.forecasts.MATCH_RESULT);
  });

  it('masks exactly the 21 enrichment-only features and nothing else', () => {
    const v = withoutEnrichmentFeatures(vector('LIVE', enriched));
    expect(ENRICHMENT_ONLY_FEATURES).toHaveLength(21);
    for (const f of ENRICHMENT_ONLY_FEATURES) expect(v.features[f].value).toBeNull();
    for (const f of Object.keys(base) as FeatureName[]) expect(v.features[f].value).toBe(base[f]);
  });
});
