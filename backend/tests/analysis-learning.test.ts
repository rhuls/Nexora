import { describe, expect, it } from 'vitest';
import { analyzeAvailability, impactLabel } from '../src/analysis/availability.analyzer.js';
import { ensemble } from '../src/analysis/engine.js';
import { analyzePlayerImpacts } from '../src/analysis/player-impact.analyzer.js';
import type { KnownResult, PlayerHistory } from '../src/data/knowledge/knowledge.service.js';
import { analyzeErrors } from '../src/evaluation/error-analyzer.js';
import { actualNumeric, brier, classificationMetrics, regressionMetrics, scoreNumeric, scoreResult } from '../src/evaluation/metrics.js';
import { FEATURE_NAMES, type FeatureName, type MatchFeatureVector } from '../src/features/feature-engineering.service.js';
import { GUARDRAILS, LearningEngine, type LearningSample } from '../src/learning/learning.engine.js';
import { createModelAdapters, DataAnalysisModelAdapter, MathematicalModelAdapter } from '../src/models/adapters.js';
import { RatingDifferentialModel } from '../src/models/data-analysis.model.js';
import { PoissonBlendModel, resultFromPoisson } from '../src/models/mathematical.model.js';
import { normalizeWeights, type FeatureWeights } from '../src/models/types.js';

const BASE_WEIGHTS: FeatureWeights = normalizeWeights({ recentForm: 0.25, shotsOnTarget: 0.2, goals: 0.15, availability: 0.15, homeAway: 0.1, h2h: 0.05, corners: 0.05, discipline: 0.05 });

function vector(values: Partial<Record<FeatureName, number>>, matchId = 'm'): MatchFeatureVector {
  const features = Object.fromEntries(
    FEATURE_NAMES.map((n) => [n, { value: values[n] ?? null, source: 'test', window: 5, sampleSize: values[n] === undefined ? 0 : 5, asOf: '2025-01-01T00:00:00.000Z' }]),
  ) as MatchFeatureVector['features'];
  return { matchId, dataEnvironment: 'SYNTHETIC', asOf: '2025-01-01T00:00:00.000Z', featureSetVersion: 'test', features };
}

const known = (id: string, gf: number, ga: number): KnownResult => ({
  matchId: id,
  matchDate: '2024-01-01T00:00:00.000Z',
  resultKnownAt: '2024-01-01T03:00:00.000Z',
  dataEnvironment: 'SYNTHETIC',
  venue: 'HOME',
  opponent: { id: 'o', name: 'Opp' },
  goalsFor: gf,
  goalsAgainst: ga,
  outcome: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
  statsRecorded: true,
  stats: { status: 'KNOWN', for: null, against: null },
});

describe('player impact', () => {
  const matches = Array.from({ length: 10 }, (_, i) => known(`m${i}`, i < 6 ? 2 : 0, 1));
  const history: PlayerHistory = {
    matches,
    players: [
      { id: 'star', name: 'Star', position: 'FORWARD' },
      { id: 'squad', name: 'Squad', position: 'DEFENDER' },
    ],
    rows: [
      ...matches.slice(0, 6).map((m) => ({ playerId: 'star', matchId: m.matchId, started: true, minutes: 90, goals: 1, assists: 1, shots: 4, shotsOnTarget: 2, tackles: 0, interceptions: 0, clearances: 0 })),
      ...matches.map((m) => ({ playerId: 'squad', matchId: m.matchId, started: true, minutes: 90, goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, tackles: 3, interceptions: 2, clearances: 4 })),
    ],
  };

  it('scores an explainable impact and uses association language', () => {
    const impacts = analyzePlayerImpacts('t', history, 20);
    const star = impacts.players.find((p) => p.player.id === 'star')!;
    expect(star.impactScore).toBeGreaterThan(60);
    expect(star.withWithout).toMatchObject({ pointsPerGameWith: 3, pointsPerGameWithout: 0 });
    expect(star.factors.join(' ')).toMatch(/associated with this difference/);
    expect(star.factors.join(' ')).not.toMatch(/\bcaused\b/);
    expect(star.impactConfidence).toBe('HIGH');
  });

  it('never compares with/without when either side has fewer than 3 matches', () => {
    const squad = analyzePlayerImpacts('t', history, 20).players.find((p) => p.player.id === 'squad')!;
    expect(squad.components.withWithout).toBeNull();
    expect(squad.impactConfidence).toBe('MEDIUM');
  });

  it('returns DATA UNAVAILABLE rather than inventing a score when no player statistics exist', () => {
    const none = analyzePlayerImpacts('t', { ...history, rows: [] }, 20);
    expect(none.status).toBe('DATA UNAVAILABLE');
    expect(none.players).toEqual([]);
  });
});

describe('availability', () => {
  const impacts = analyzePlayerImpacts('t', {
    matches: [known('a', 1, 0), known('b', 1, 0), known('c', 1, 0), known('d', 1, 0), known('e', 1, 0)],
    players: [{ id: 'p1', name: 'Key', position: 'FORWARD' }],
    rows: ['a', 'b', 'c', 'd', 'e'].map((m) => ({ playerId: 'p1', matchId: m, started: true, minutes: 90, goals: 1, assists: 0, shots: 3, shotsOnTarget: 2, tackles: null, interceptions: null, clearances: null })),
  }, 20);
  const team = { id: 't', name: 'Team' };
  const report = (id: string, name: string, status: 'INJURED' | 'DOUBTFUL' | 'AVAILABLE' | 'UNKNOWN') => ({ player: { id, name, position: 'FORWARD', teamId: 't' }, status, reason: null, expectedReturn: null, reportedAt: '2025-01-01T00:00:00.000Z' });

  it('weights absences by who is missing, not by head count', () => {
    const a = analyzeAvailability(team, [report('p1', 'Key', 'INJURED'), report('x', 'Unknown Squad', 'INJURED')], impacts);
    expect(a.unavailableCount).toBe(2);
    expect(a.players[0]!.player.name).toBe('Key');
    expect(a.combinedImpact).toBeCloseTo(a.players[0]!.impactScore! / 100, 3);
    expect(a.limitations.join(' ')).toMatch(/no impact score/);
  });

  it('counts doubtful players at half weight and never counts UNKNOWN as absent', () => {
    const injured = analyzeAvailability(team, [report('p1', 'Key', 'INJURED')], impacts).combinedImpact!;
    const doubtful = analyzeAvailability(team, [report('p1', 'Key', 'DOUBTFUL')], impacts).combinedImpact!;
    expect(doubtful).toBeCloseTo(injured / 2, 3);
    const unknown = analyzeAvailability(team, [report('p1', 'Key', 'UNKNOWN')], impacts);
    expect(unknown.combinedImpact).toBe(0);
    expect(unknown.unknownCount).toBe(1);
  });

  it('is DATA UNAVAILABLE when no report exists', () => {
    expect(analyzeAvailability(team, [], impacts)).toMatchObject({ status: 'DATA UNAVAILABLE', combinedImpact: null, confidence: 'DATA UNAVAILABLE' });
    expect(impactLabel(null)).toBe('UNKNOWN');
  });
});

describe('models', () => {
  const full = vector({
    recentFormHome: 2.2, recentFormAway: 1.0, goalsHomeAverage: 2.0, goalsAwayAverage: 1.0, concededHomeAverage: 0.8, concededAwayAverage: 1.6,
    homeFormAtHome: 2.4, awayFormAway: 0.8, homeGoalsAtHome: 2.2, awayGoalsAway: 0.9, homeConcededAtHome: 0.7, awayConcededAway: 1.8,
    shotsOnTargetHomeAverage: 6, shotsOnTargetAwayAverage: 3, cornersHomeAverage: 6, cornersAwayAverage: 4, cardsHomeAverage: 1.5, cardsAwayAverage: 2,
    leagueHomeGoals: 1.5, leagueAwayGoals: 1.2, homeAdvantage: 0.3, goalsPerShotOnTarget: 0.33, h2hReliability: 0.5, h2hResultBalance: 0.4, h2hHomeGoals: 2, h2hAwayGoals: 1, h2hGoalsAverage: 3,
  });
  const ctx = { weights: BASE_WEIGHTS, modelVersion: 'v1.0' };

  it('Poisson result probabilities are valid and symmetric', () => {
    const p = resultFromPoisson(1.4, 1.4);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
    expect(p.home).toBeCloseTo(p.away, 10);
    expect(resultFromPoisson(2.5, 0.8).home).toBeGreaterThan(0.6);
  });

  it('both models favour the clearly stronger side, independently', () => {
    const math = new PoissonBlendModel().calculate(full, ctx);
    const da = new RatingDifferentialModel().analyze(full, ctx);
    expect(math.forecasts.MATCH_RESULT!.home).toBeGreaterThan(math.forecasts.MATCH_RESULT!.away);
    expect(da.forecasts.MATCH_RESULT!.home).toBeGreaterThan(da.forecasts.MATCH_RESULT!.away);
    expect(math.forecasts.MATCH_RESULT).not.toEqual(da.forecasts.MATCH_RESULT);
    expect(math.forecasts.CORNERS).toBeCloseTo(10, 5);
  });

  it('feature weights change the forecast', () => {
    const heavyForm = normalizeWeights({ ...BASE_WEIGHTS, recentForm: 0.6 });
    const a = new RatingDifferentialModel().analyze(full, ctx).forecasts.MATCH_RESULT!.home;
    const b = new RatingDifferentialModel().analyze(full, { ...ctx, weights: heavyForm }).forecasts.MATCH_RESULT!.home;
    expect(a).not.toBeCloseTo(b, 4);
  });

  it('produces no forecast for a target whose inputs are unavailable', () => {
    const math = new PoissonBlendModel().calculate(vector({}), ctx);
    expect(math.forecasts).toEqual({});
    const da = new RatingDifferentialModel().analyze(vector({ goalsHomeAverage: 1 }), ctx);
    expect(da.forecasts.MATCH_RESULT).toBeUndefined();
    expect(da.forecasts.CORNERS).toBeUndefined();
  });

  it('adapters reject invalid outputs and contain failures', async () => {
    const broken = new MathematicalModelAdapter({ id: 'bad', implementationVersion: '0', calculate: () => ({ model: 'bad', modelKind: 'MATHEMATICAL', implementationVersion: '0', forecasts: { MATCH_RESULT: { home: 0.9, draw: 0.9, away: 0.9 } }, components: {}, notes: [] }) });
    expect(await broken.run(full, ctx)).toMatchObject({ ok: false });
    const throwing = new DataAnalysisModelAdapter({ id: 'boom', implementationVersion: '0', analyze: () => { throw new Error('model down'); } });
    expect(await throwing.run(full, ctx)).toEqual({ ok: false, model: 'boom', error: 'model down' });
    const wrongKind = new DataAnalysisModelAdapter({ id: 'k', implementationVersion: '0', analyze: () => new PoissonBlendModel().calculate(full, ctx) });
    expect(await wrongKind.run(full, ctx)).toMatchObject({ ok: false });
  });

  it('ensemble averages probabilities and measures agreement', () => {
    const e = ensemble([
      { model: 'a', modelKind: 'MATHEMATICAL', implementationVersion: '1', forecasts: { MATCH_RESULT: { home: 0.6, draw: 0.2, away: 0.2 }, GOALS: 3 }, components: {}, notes: [] },
      { model: 'b', modelKind: 'DATA_ANALYSIS', implementationVersion: '1', forecasts: { MATCH_RESULT: { home: 0.4, draw: 0.3, away: 0.3 }, GOALS: 2 }, components: {}, notes: [] },
    ]);
    expect(e.MATCH_RESULT).toMatchObject({ lean: 'HOME' });
    expect(e.MATCH_RESULT!.home).toBeCloseTo(0.5, 10);
    expect(e.MATCH_RESULT!.agreement).toBeCloseTo(0.8, 10);
    expect(e.numeric.GOALS).toMatchObject({ value: 2.5, models: 2 });
  });
});

describe('evaluation metrics', () => {
  it('computes MAE, RMSE and bias', () => {
    const m = regressionMetrics('GOALS', [
      { predicted: 3, actual: 1, confidence: 'LOW' },
      { predicted: 2, actual: 2, confidence: 'LOW' },
      { predicted: 1, actual: 2, confidence: 'HIGH' },
    ])!;
    expect(m.mae).toBeCloseTo(1, 10);
    expect(m.rmse).toBeCloseTo(Math.sqrt(5 / 3), 4);
    expect(m.bias).toBeCloseTo(1 / 3, 4);
    expect(m.withinTolerance).toBeCloseTo(2 / 3, 4);
    expect(m.byConfidence.HIGH).toEqual({ n: 1, mae: 1 });
  });

  it('computes accuracy, precision, recall, F1, Brier and calibration for results', () => {
    const p = (home: number, draw: number, away: number) => ({ home, draw, away });
    const m = classificationMetrics([
      { predicted: 'HOME', actual: 'HOME', probabilities: p(0.7, 0.2, 0.1), confidence: 'HIGH' },
      { predicted: 'HOME', actual: 'AWAY', probabilities: p(0.5, 0.3, 0.2), confidence: 'MEDIUM' },
      { predicted: 'AWAY', actual: 'AWAY', probabilities: p(0.2, 0.2, 0.6), confidence: 'MEDIUM' },
      { predicted: 'DRAW', actual: 'HOME', probabilities: p(0.3, 0.4, 0.3), confidence: 'LOW' },
    ])!;
    expect(m.accuracy).toBe(0.5);
    expect(m.perClass.HOME).toMatchObject({ precision: 0.5, recall: 0.5, f1: 0.5 });
    expect(m.perClass.AWAY).toMatchObject({ precision: 1, recall: 0.5 });
    expect(m.brier).toBeCloseTo((brier(p(0.7, 0.2, 0.1), 'HOME') + brier(p(0.5, 0.3, 0.2), 'AWAY') + brier(p(0.2, 0.2, 0.6), 'AWAY') + brier(p(0.3, 0.4, 0.3), 'HOME')) / 4, 4);
    expect(m.calibration.reduce((s, b) => s + b.n, 0)).toBe(4);
    expect(m.expectedCalibrationError).toBeGreaterThanOrEqual(0);
    expect(m.byConfidence.HIGH).toEqual({ n: 1, accuracy: 1 });
  });

  it('counts a class that occurs but is never predicted as 0 in macro scores', () => {
    const p = { home: 0.5, draw: 0.3, away: 0.2 };
    const m = classificationMetrics([
      { predicted: 'HOME', actual: 'HOME', probabilities: p, confidence: 'LOW' },
      { predicted: 'HOME', actual: 'DRAW', probabilities: p, confidence: 'LOW' },
      { predicted: 'AWAY', actual: 'AWAY', probabilities: { home: 0.2, draw: 0.3, away: 0.5 }, confidence: 'LOW' },
    ])!;
    expect(m.perClass.DRAW).toMatchObject({ support: 1, predicted: 0, precision: 0, recall: 0, f1: 0 });
    expect(m.f1Macro).toBeCloseTo((2 / 3 + 0 + 1) / 3, 4);
    expect(m.f1Macro!).toBeLessThanOrEqual(1);
  });

  it('scores individual forecasts and treats missing actuals as not evaluable', () => {
    expect(scoreResult({ home: 0.5, draw: 0.3, away: 0.2 }, 'HOME', 'AWAY')).toMatchObject({ wasCorrect: false, actualValue: 0.2, actualLabel: 'AWAY' });
    expect(scoreNumeric('CORNERS', 10.2, 5)).toMatchObject({ error: 5.2, absoluteError: 5.2, wasCorrect: false });
    expect(actualNumeric('CORNERS', { homeScore: 1, awayScore: 1, stats: [{ corners: 5, yellowCards: 1, redCards: 0, shots: 9, shotsOnTarget: 3 }, { corners: null, yellowCards: 2, redCards: 0, shots: 8, shotsOnTarget: 2 }] })).toBeNull();
    expect(actualNumeric('CARDS', { homeScore: 1, awayScore: 1, stats: [{ corners: 5, yellowCards: 1, redCards: 1, shots: 9, shotsOnTarget: 3 }, { corners: 2, yellowCards: 2, redCards: 0, shots: 8, shotsOnTarget: 2 }] })).toBe(4);
    expect(actualNumeric('SHOTS', { homeScore: 1, awayScore: 1, stats: [] })).toBeNull();
  });
});

describe('error analysis', () => {
  const row = (error: number, qualityStatus: 'GOOD' | 'WARNINGS' = 'GOOD') => ({ error, absoluteError: Math.abs(error), predicted: 2.5, qualityStatus, features: {} });

  it('flags a small sample as provisional', () => {
    expect(analyzeErrors('GOALS', [row(0.5), row(-0.5)]).findings.map((f) => f.category)).toContain('SAMPLE_SIZE_UNCERTAINTY');
  });

  it('detects systematic bias distinct from random noise', () => {
    const biased = Array.from({ length: 60 }, (_, i) => row(1.2 + (i % 3) * 0.1));
    const findings = analyzeErrors('CORNERS', biased).findings;
    expect(findings.find((f) => f.category === 'SYSTEMATIC_ERROR')?.explanation).toMatch(/too high/);
  });

  it('attributes worse error under data-quality warnings to data quality', () => {
    const rows = [...Array.from({ length: 30 }, () => row(0.5)), ...Array.from({ length: 30 }, (_, i) => row(i % 2 ? 1.5 : -1.5, 'WARNINGS'))];
    expect(analyzeErrors('GOALS', rows).findings.map((f) => f.category)).toContain('DATA_QUALITY_ERROR');
  });
});

describe('learning engine guardrails', () => {
  const engine = new LearningEngine(createModelAdapters());
  // Goal averages exactly explain the outcome while the home/away split is noise, so the goals weight should rise.
  const sample = (i: number): LearningSample => {
    const gh = 1 + (i % 3);
    const ga = (i * 7) % 3;
    const noise = (i * 13) % 5;
    return {
      matchId: `s${i}`,
      cutoff: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000),
      resultKnownAt: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000 + 3 * 3_600_000),
      vector: vector({ goalsHomeAverage: gh, concededAwayAverage: gh, goalsAwayAverage: ga, concededHomeAverage: ga, homeGoalsAtHome: noise, awayConcededAway: noise, awayGoalsAway: 4 - noise, homeConcededAtHome: 4 - noise }, `s${i}`),
      actual: { result: null, numeric: { GOALS: gh + ga } },
    };
  };
  const samples = Array.from({ length: 120 }, (_, i) => sample(i));

  it('refuses to learn from fewer than the minimum samples', async () => {
    const p = await engine.propose(BASE_WEIGHTS, samples.slice(0, GUARDRAILS.minTrainingSamples - 1));
    expect(p.status).toBe('INSUFFICIENT_DATA');
    expect(p.weights).toEqual(BASE_WEIGHTS);
  });

  it('proposes shifting weight towards the feature that explains the outcome, with learning signals', async () => {
    const p = await engine.propose(BASE_WEIGHTS, samples.slice(0, 60));
    expect(p.status).toBe('PROPOSED');
    expect(p.weights.goals / p.weights.homeAway).toBeGreaterThan(BASE_WEIGHTS.goals / BASE_WEIGHTS.homeAway);
    expect(p.changes.length).toBeLessThanOrEqual(GUARDRAILS.maxChangesPerProposal);
    expect(p.signals.find((s) => s.feature === 'goals')!.usefulness).toBeGreaterThan(0);
    for (const w of Object.values(p.weights)) expect(w).toBeGreaterThanOrEqual(0);
    expect(Object.values(p.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('promotes only on a meaningful out-of-sample improvement and rejects a worse candidate', async () => {
    const p = await engine.propose(BASE_WEIGHTS, samples.slice(0, 60));
    const good = await engine.validate(BASE_WEIGHTS, p.weights, samples.slice(60));
    expect(good.decision).toBe('PROMOTE');
    expect(good.pairedZ).toBeGreaterThanOrEqual(GUARDRAILS.minPairedZ);
    const worse = await engine.validate(p.weights, BASE_WEIGHTS, samples.slice(60));
    expect(worse.decision).toBe('REJECT');
    const same = await engine.validate(BASE_WEIGHTS, BASE_WEIGHTS, samples.slice(60));
    expect(same.decision).toBe('REJECT');
    const small = await engine.validate(BASE_WEIGHTS, p.weights, samples.slice(60, 60 + GUARDRAILS.minValidationSamples - 1));
    expect(small.decision).toBe('INSUFFICIENT_DATA');
  });
});
