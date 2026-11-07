import { describe, expect, it } from 'vitest';
import { Copycat } from '../src/debate/copycat.agent.js';
import { Skeptic } from '../src/debate/skeptic.agent.js';
import { Bookkeeper } from '../src/debate/bookkeeper.agent.js';
import { DebateEngine, type DebateInput } from '../src/debate/debate.engine.js';
import type { CalibrationCheck, EvidenceBundle, Fact, MarketBaseline, MarketProbabilities, StoredOdds } from '../src/debate/types.js';
import type { MatchAnalysis } from '../src/analysis/engine.js';
import { FEATURE_NAMES, type MatchFeatureVector } from '../src/features/feature-engineering.service.js';

const ASOF = new Date('2026-03-01T15:00:00Z');

const fact = (over: Partial<Fact> = {}): Fact => ({
  key: 'recentFormHome',
  label: 'Home recent form',
  value: 1.8,
  unit: 'ppg',
  source: 'nexora-knowledge',
  asOf: ASOF.toISOString(),
  sampleSize: 5,
  unavailable: false,
  staleHours: null,
  ...over,
});

const evidence = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  matchId: 'm1',
  asOf: ASOF.toISOString(),
  facts: [fact()],
  missing: [],
  stale: [],
  dataQuality: { status: 'GOOD', featuresAvailable: 40, featuresTotal: 41, warnings: [] },
  ...over,
});

// A full feature vector with every value populated, so tests opt in to missingness explicitly.
const vector = (over: Record<string, number | null> = {}): MatchFeatureVector => ({
  matchId: 'm1',
  dataEnvironment: 'HISTORICAL',
  asOf: ASOF.toISOString(),
  featureSetVersion: '2.0.0',
  features: Object.fromEntries(
    FEATURE_NAMES.map((n) => [n, { value: over[n] !== undefined ? over[n] : 1, source: 'test', window: 5, sampleSize: 5, asOf: ASOF.toISOString() }]),
  ) as MatchFeatureVector['features'],
});

const analysis = (over: Partial<MatchAnalysis> = {}): MatchAnalysis => ({
  matchId: 'm1',
  dataEnvironment: 'HISTORICAL',
  modelVersion: 'v1',
  featureSnapshotId: null,
  engineVersion: '1.0.0',
  asOf: ASOF.toISOString(),
  generatedAt: ASOF.toISOString(),
  resultTrend: { lean: 'HOME', probabilities: { home: 0.5, draw: 0.25, away: 0.25 }, explanation: 'x' },
  goalTrend: null,
  cornerTrend: null,
  cardTrend: null,
  attackingComparison: [],
  defensiveComparison: [],
  availabilityComparison: [],
  forecasts: [],
  confidence: { level: 'HIGH', score: 0.8, reasons: [] },
  keyFactors: [],
  supportingFactors: [],
  conflictingFactors: [],
  warnings: [],
  dataLimitations: [],
  dataQuality: { status: 'GOOD', featuresAvailable: 40, featuresTotal: 41, warnings: [] },
  models: [
    { model: 'maths', kind: 'MATHEMATICAL', status: 'OK', notes: [] },
    { model: 'analysis', kind: 'DATA_ANALYSIS', status: 'OK', notes: [] },
  ],
  ...over,
});

const noBaseline: MarketBaseline = {
  status: 'NOT_CONFIGURED',
  reason: 'No odds provider is configured.',
  probabilities: { MATCH_RESULT: null, OVER_UNDER_25: null, BTTS: null },
  bookmaker: null,
  capturedAt: null,
  overround: {},
  method: null,
  oddsSnapshotIds: [],
  prices: {},
};

describe('Copycat', () => {
  const odds = (over: Partial<StoredOdds> = {}): StoredOdds => ({
    id: 'o1',
    market: 'MATCH_RESULT',
    source: 'test',
    bookmaker: 'TestBook',
    capturedAt: new Date(ASOF.getTime() - 3_600_000),
    prices: { home: 2.1, draw: 3.4, away: 3.6 },
    ...over,
  });

  it('reports NOT_CONFIGURED rather than inventing a baseline', () => {
    const out = new Copycat().baseline({ odds: [], asOf: ASOF, providerConfigured: false });
    expect(out.status).toBe('NOT_CONFIGURED');
    expect(out.probabilities.MATCH_RESULT).toBeNull();
    expect(out.reason).toMatch(/no odds provider/i);
  });

  it('ignores prices published after the cutoff', () => {
    const late = odds({ capturedAt: new Date(ASOF.getTime() + 60_000) });
    const out = new Copycat().baseline({ odds: [late], asOf: ASOF, providerConfigured: true });
    expect(out.status).toBe('NO_ODDS_BEFORE_CUTOFF');
    expect(out.probabilities.MATCH_RESULT).toBeNull();
  });

  it('de-vigs a usable book and reports the overround', () => {
    const out = new Copycat().baseline({ odds: [odds()], asOf: ASOF, providerConfigured: true });
    expect(out.status).toBe('AVAILABLE');
    const p = out.probabilities.MATCH_RESULT!;
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
    expect(out.overround.MATCH_RESULT).toBeGreaterThan(1);
    expect(out.bookmaker).toBe('TestBook');
  });

  it('takes the latest capture per market and keeps each market separate', () => {
    const older = odds({ id: 'old', capturedAt: new Date(ASOF.getTime() - 7_200_000), prices: { home: 5, draw: 5, away: 1.5 } });
    const newer = odds({ id: 'new', capturedAt: new Date(ASOF.getTime() - 600_000) });
    const ou = odds({ id: 'ou', market: 'OVER_UNDER_25', prices: { over: 1.9, under: 1.95 } });
    const out = new Copycat().baseline({ odds: [older, newer, ou], asOf: ASOF, providerConfigured: true });
    expect(out.oddsSnapshotIds).toContain('new');
    expect(out.oddsSnapshotIds).not.toContain('old');
    expect(out.probabilities.OVER_UNDER_25).not.toBeNull();
    expect(out.probabilities.BTTS).toBeNull();
  });

  it('flags a baseline whose newest price is too old to describe the market', () => {
    const stale = odds({ capturedAt: new Date(ASOF.getTime() - 100 * 3_600_000) });
    expect(new Copycat().baseline({ odds: [stale], asOf: ASOF, providerConfigured: true }).status).toBe('STALE');
  });

  it('rejects a corrupt book instead of de-vigging it', () => {
    const bad = odds({ prices: { home: 0.4, draw: 3.4, away: 3.6 } });
    const out = new Copycat().baseline({ odds: [bad], asOf: ASOF, providerConfigured: true });
    expect(out.status).toBe('NO_ODDS_BEFORE_CUTOFF');
    expect(out.reason).toMatch(/outside/);
  });
});

describe('Skeptic', () => {
  const base = {
    evidence: evidence(),
    baseline: noBaseline,
    model: { MATCH_RESULT: { home: 0.5, draw: 0.25, away: 0.25 }, OVER_UNDER_25: null, BTTS: null } as MarketProbabilities,
    analysis: analysis(),
    vector: vector(),
    dataEnvironment: 'HISTORICAL' as const,
    calibration: { expectedCalibrationError: 0.014, sampleSize: 1105 },
    knownResults: 500,
    ensembleAgreement: 0.95,
  };
  const codes = (o: ReturnType<Skeptic['challenge']>) => o.map((x) => x.code);

  it('vetoes any verdict on synthetic data', () => {
    const out = new Skeptic().challenge({ ...base, dataEnvironment: 'SYNTHETIC' });
    const veto = out.find((o) => o.code === 'SYNTHETIC_ENV');
    expect(veto?.severity).toBe('VETO');
  });

  it('objects when the market baseline is missing, naming it as the reason no edge can be claimed', () => {
    const out = new Skeptic().challenge(base);
    const o = out.find((x) => x.code === 'NO_MARKET_BASELINE');
    expect(o).toBeDefined();
    expect(o!.targetAgent).toBe('COPYCAT');
    expect(o!.summary).toMatch(/edge is unmeasurable/);
  });

  it('flags the early-season fallback with the actual count', () => {
    const out = new Skeptic().challenge({ ...base, knownResults: 42 });
    const o = out.find((x) => x.code === 'EARLY_SEASON_FALLBACK')!;
    expect(o.summary).toContain('42');
    expect(o.evidence).toMatchObject({ knownResults: 42, required: 100 });
  });

  it('escalates missing features to a veto once coverage collapses', () => {
    const thin = new Skeptic().challenge({ ...base, evidence: evidence({ dataQuality: { status: 'WARNINGS', featuresAvailable: 24, featuresTotal: 41, warnings: [] } }) });
    expect(thin.find((o) => o.code === 'MISSING_FEATURES')!.severity).toBe('CONCERN');
    const collapsed = new Skeptic().challenge({ ...base, evidence: evidence({ dataQuality: { status: 'WARNINGS', featuresAvailable: 10, featuresTotal: 41, warnings: [] } }) });
    expect(collapsed.find((o) => o.code === 'MISSING_FEATURES')!.severity).toBe('VETO');
  });

  it('vetoes an edge smaller than the model’s own calibration error', () => {
    const baseline: MarketBaseline = { ...noBaseline, status: 'AVAILABLE', probabilities: { MATCH_RESULT: { home: 0.49, draw: 0.26, away: 0.25 }, OVER_UNDER_25: null, BTTS: null } };
    const out = new Skeptic().challenge({ ...base, baseline, calibration: { expectedCalibrationError: 0.08, sampleSize: 900 } });
    const o = out.find((x) => x.code === 'EDGE_WITHIN_NOISE')!;
    expect(o.severity).toBe('VETO');
    expect(o.summary).toMatch(/cannot be distinguished from miscalibration/);
  });

  it('does not veto an edge comfortably beyond the calibration error', () => {
    const baseline: MarketBaseline = { ...noBaseline, status: 'AVAILABLE', probabilities: { MATCH_RESULT: { home: 0.3, draw: 0.35, away: 0.35 }, OVER_UNDER_25: null, BTTS: null } };
    const out = new Skeptic().challenge({ ...base, baseline, calibration: { expectedCalibrationError: 0.014, sampleSize: 1105 } });
    expect(codes(out)).not.toContain('EDGE_WITHIN_NOISE');
  });

  it('flags a draw lean as a documented blind spot', () => {
    const out = new Skeptic().challenge({ ...base, model: { MATCH_RESULT: { home: 0.3, draw: 0.4, away: 0.3 }, OVER_UNDER_25: null, BTTS: null } });
    expect(codes(out)).toContain('DRAW_BLINDSPOT');
  });

  it('flags stale and missing availability separately', () => {
    const stale = new Skeptic().challenge({
      ...base,
      evidence: evidence({ facts: [fact({ key: 'homeAbsentees', label: 'Home absentees', staleHours: 120 })] }),
    });
    expect(codes(stale)).toContain('STALE_AVAILABILITY');

    const missing = new Skeptic().challenge({
      ...base,
      evidence: evidence({ facts: [fact({ key: 'homeAbsentees', label: 'Home absentees', value: null, unavailable: true })] }),
    });
    expect(codes(missing)).toContain('NO_AVAILABILITY_DATA');
  });

  it('vetoes when every model failed and only concerns when one did', () => {
    const one = new Skeptic().challenge({ ...base, analysis: analysis({ models: [{ model: 'a', kind: 'MATHEMATICAL', status: 'FAILED', notes: [], error: 'boom' }, { model: 'b', kind: 'DATA_ANALYSIS', status: 'OK', notes: [] }] }) });
    expect(one.find((o) => o.code === 'MODEL_FAILED')!.severity).toBe('CONCERN');
    const all = new Skeptic().challenge({ ...base, analysis: analysis({ models: [{ model: 'a', kind: 'MATHEMATICAL', status: 'FAILED', notes: [], error: 'boom' }] }) });
    expect(all.find((o) => o.code === 'MODEL_FAILED')!.severity).toBe('VETO');
  });

  it('objects when there is no calibration history to trust the probabilities with', () => {
    const out = new Skeptic().challenge({ ...base, calibration: { expectedCalibrationError: null, sampleSize: 4 } });
    expect(codes(out)).toContain('NO_CALIBRATION_HISTORY');
  });

  it('names a number in every objection it raises', () => {
    const out = new Skeptic().challenge({ ...base, knownResults: 10, calibration: { expectedCalibrationError: null, sampleSize: 2 } });
    expect(out.length).toBeGreaterThan(0);
    for (const o of out) {
      expect(o.summary.length).toBeGreaterThan(20);
      expect(o.code).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('Bookkeeper', () => {
  const history = (over: Partial<CalibrationCheck> = {}): CalibrationCheck => ({ bucket: 'HIGH', observed: 0.6, expected: 0.58, sampleSize: 200, trustworthy: false, note: '', ...over });

  it('refuses a stake while the bucket history is thin, and says how thin', () => {
    const { stake, calibration } = new Bookkeeper().check({
      market: 'MATCH_RESULT',
      probabilities: { home: 0.6, draw: 0.2, away: 0.2 },
      baseline: { home: 0.45, draw: 0.27, away: 0.28 },
      prices: { home: 2.4, draw: 3.4, away: 3.6 },
      recommendation: 'PICK',
      confidence: 'HIGH',
      history: history({ sampleSize: 7 }),
    });
    expect(stake.stakePct).toBeNull();
    expect(calibration.trustworthy).toBe(false);
    expect(calibration.note).toContain('7');
  });

  it('sizes a stake on the leading outcome once the history supports it', () => {
    const { stake, calibration } = new Bookkeeper().check({
      market: 'MATCH_RESULT',
      probabilities: { home: 0.6, draw: 0.2, away: 0.2 },
      baseline: { home: 0.45, draw: 0.27, away: 0.28 },
      prices: { home: 2.4, draw: 3.4, away: 3.6 },
      recommendation: 'PICK',
      confidence: 'HIGH',
      history: history(),
    });
    expect(stake.stakePct).toBeGreaterThan(0);
    expect(calibration.trustworthy).toBe(true);
  });

  it('calls out an overconfident bucket', () => {
    const { calibration } = new Bookkeeper().check({
      market: 'MATCH_RESULT',
      probabilities: { home: 0.6, draw: 0.2, away: 0.2 },
      baseline: null,
      prices: null,
      recommendation: 'LEAN',
      confidence: 'HIGH',
      history: history({ observed: 0.4, expected: 0.7 }),
    });
    expect(calibration.note).toMatch(/^Overconfident/);
  });
});

describe('DebateEngine', () => {
  const history: Record<'LOW' | 'MEDIUM' | 'HIGH', CalibrationCheck> = {
    LOW: { bucket: 'LOW', observed: 0.33, expected: 0.4, sampleSize: 120, trustworthy: false, note: '' },
    MEDIUM: { bucket: 'MEDIUM', observed: 0.48, expected: 0.5, sampleSize: 150, trustworthy: false, note: '' },
    HIGH: { bucket: 'HIGH', observed: 0.6, expected: 0.58, sampleSize: 200, trustworthy: false, note: '' },
  };

  const input = (over: Partial<DebateInput> = {}): DebateInput => ({
    matchId: 'm1',
    fixture: 'Home vs Away',
    kickoff: new Date('2026-03-01T15:00:00Z'),
    asOf: ASOF,
    dataEnvironment: 'HISTORICAL',
    modelVersion: 'v1',
    evidence: evidence(),
    baseline: noBaseline,
    model: { MATCH_RESULT: { home: 0.5, draw: 0.25, away: 0.25 }, OVER_UNDER_25: { over: 0.55, under: 0.45 }, BTTS: { yes: 0.52, no: 0.48 } },
    analysis: analysis(),
    vector: vector(),
    ensembleAgreement: 0.95,
    knownResults: 500,
    calibration: { expectedCalibrationError: 0.014, sampleSize: 1105 },
    history,
    ...over,
  });

  it('produces a verdict for all three markets', () => {
    const t = new DebateEngine().run(input());
    expect(t.verdicts.map((v) => v.market).sort()).toEqual(['BTTS', 'MATCH_RESULT', 'OVER_UNDER_25']);
    expect(t.rounds.one.evidence.facts.length).toBeGreaterThan(0);
  });

  it('never returns a PICK without a market baseline, because the edge is unmeasurable', () => {
    const t = new DebateEngine().run(input());
    expect(t.verdicts.every((v) => v.recommendation !== 'PICK')).toBe(true);
    expect(t.verdicts.every((v) => v.edge === null)).toBe(true);
    expect(t.verdicts.every((v) => v.stakePct === null)).toBe(true);
    expect(t.verdicts[0]!.unresolvedObjections.some((o) => o.startsWith('NO_MARKET_BASELINE'))).toBe(true);
  });

  it('turns a veto into NO_PICK on every market', () => {
    const t = new DebateEngine().run(input({ dataEnvironment: 'SYNTHETIC' }));
    expect(t.verdicts.every((v) => v.recommendation === 'NO_PICK')).toBe(true);
    expect(t.verdicts.every((v) => v.confidence === 'LOW')).toBe(true);
    expect(t.rounds.three.lastObjections.some((o) => o.code === 'SYNTHETIC_ENV')).toBe(true);
  });

  it('reaches a PICK when a baseline exists, the edge is real and nothing stands against it', () => {
    const baseline: MarketBaseline = {
      ...noBaseline,
      status: 'AVAILABLE',
      reason: 'ok',
      probabilities: { MATCH_RESULT: { home: 0.35, draw: 0.3, away: 0.35 }, OVER_UNDER_25: { over: 0.5, under: 0.5 }, BTTS: { yes: 0.5, no: 0.5 } },
      bookmaker: 'TestBook',
      capturedAt: ASOF.toISOString(),
      overround: { MATCH_RESULT: 1.05 },
      method: 'shin',
      oddsSnapshotIds: ['o1'],
      prices: { MATCH_RESULT: { home: 2.4, draw: 3.4, away: 3.6 } },
    };
    const t = new DebateEngine().run(input({ baseline }));
    const result = t.verdicts.find((v) => v.market === 'MATCH_RESULT')!;
    expect(result.recommendation).toBe('PICK');
    expect(result.edge).toBeCloseTo(0.15, 6);
    expect(result.stakePct).toBeGreaterThan(0);
  });

  it('downgrades a pick to a lean for each standing concern', () => {
    const baseline: MarketBaseline = {
      ...noBaseline,
      status: 'AVAILABLE',
      probabilities: { MATCH_RESULT: { home: 0.35, draw: 0.3, away: 0.35 }, OVER_UNDER_25: null, BTTS: null },
      prices: { MATCH_RESULT: { home: 2.4, draw: 3.4, away: 3.6 } },
      oddsSnapshotIds: ['o1'],
    };
    const t = new DebateEngine().run(input({ baseline, knownResults: 20 }));
    const result = t.verdicts.find((v) => v.market === 'MATCH_RESULT')!;
    expect(result.recommendation).toBe('LEAN');
    expect(result.stakePct).toBeNull();
    expect(result.unresolvedObjections.some((o) => o.startsWith('EARLY_SEASON_FALLBACK'))).toBe(true);
  });

  it('returns NO_PICK for a market it could not derive a probability for', () => {
    const t = new DebateEngine().run(input({ model: { MATCH_RESULT: { home: 0.5, draw: 0.25, away: 0.25 }, OVER_UNDER_25: null, BTTS: null } }));
    const ou = t.verdicts.find((v) => v.market === 'OVER_UNDER_25')!;
    expect(ou.recommendation).toBe('NO_PICK');
    expect(ou.probabilities).toBeNull();
    expect(ou.reasoning).toMatch(/DATA UNAVAILABLE/);
  });

  it('records every agent’s claims across the four rounds', () => {
    const t = new DebateEngine().run(input());
    const agents = new Set(t.claims.map((c) => c.agent));
    expect(agents.has('SCOUT')).toBe(true);
    expect(agents.has('COPYCAT')).toBe(true);
    expect(agents.has('SKEPTIC')).toBe(true);
    expect(agents.has('BOOKKEEPER')).toBe(true);
    expect(new Set(t.claims.map((c) => c.round))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('is deterministic: the same input always yields the same verdicts', () => {
    const a = new DebateEngine().run(input());
    const b = new DebateEngine().run(input());
    expect(JSON.stringify(a.verdicts)).toBe(JSON.stringify(b.verdicts));
  });
});
