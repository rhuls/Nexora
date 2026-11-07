import type { ConfidenceLevel, DataEnvironment, PredictionTarget } from '@prisma/client';
import type { DataQuality, FeatureBuild, MatchFeatureVector } from '../features/feature-engineering.service.js';
import { featureValue } from '../features/feature-engineering.service.js';
import type { ModelAdapters } from '../models/adapters.js';
import { NUMERIC_TARGETS, type FeatureWeights, type ModelOutput, type NumericTarget, type ResultProbabilities } from '../models/types.js';

export const ENGINE_VERSION = '1.0.0';

export interface EnsembleForecast {
  MATCH_RESULT?: ResultProbabilities & { lean: 'HOME' | 'DRAW' | 'AWAY'; agreement: number };
  numeric: Partial<Record<NumericTarget, { value: number; agreement: number; models: number }>>;
}

export interface Confidence {
  level: ConfidenceLevel;
  score: number;
  reasons: string[];
}

export interface TargetForecast {
  target: PredictionTarget;
  predictedValue: number;
  predictedLabel: string | null;
  probabilities: ResultProbabilities | null;
  confidence: Confidence;
}

export interface MatchAnalysis {
  matchId: string;
  dataEnvironment: DataEnvironment;
  modelVersion: string;
  featureSnapshotId: string | null;
  engineVersion: string;
  asOf: string;
  generatedAt: string;
  resultTrend: { lean: 'HOME' | 'DRAW' | 'AWAY'; probabilities: ResultProbabilities; explanation: string } | null;
  goalTrend: { expectedTotal: number; explanation: string } | null;
  cornerTrend: { expectedTotal: number; explanation: string } | null;
  cardTrend: { expectedTotal: number; explanation: string } | null;
  attackingComparison: string[];
  defensiveComparison: string[];
  availabilityComparison: string[];
  forecasts: TargetForecast[];
  confidence: Confidence;
  keyFactors: string[];
  supportingFactors: string[];
  conflictingFactors: string[];
  warnings: string[];
  dataLimitations: string[];
  dataQuality: DataQuality;
  models: Array<{ model: string; kind: string; status: 'OK' | 'FAILED'; notes: string[]; error?: string }>;
}

const r = (v: number, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
const pct = (v: number) => `${Math.round(v * 100)}%`;

// Pure combination of model outputs, shared by live analysis and offline learning evaluation.
export function ensemble(outputs: ModelOutput[]): EnsembleForecast {
  const results = outputs.map((o) => o.forecasts.MATCH_RESULT).filter((p): p is ResultProbabilities => p !== undefined);
  const out: EnsembleForecast = { numeric: {} };
  if (results.length > 0) {
    const avg = (k: keyof ResultProbabilities) => results.reduce((s, p) => s + p[k], 0) / results.length;
    const home = avg('home');
    const draw = avg('draw');
    const away = 1 - home - draw;
    const tvd = results.length < 2 ? 0 : 0.5 * (Math.abs(results[0]!.home - results[1]!.home) + Math.abs(results[0]!.draw - results[1]!.draw) + Math.abs(results[0]!.away - results[1]!.away));
    const lean = home >= draw && home >= away ? 'HOME' : away >= draw ? 'AWAY' : 'DRAW';
    out.MATCH_RESULT = { home, draw, away, lean, agreement: results.length < 2 ? 0.5 : 1 - tvd };
  }
  for (const target of NUMERIC_TARGETS) {
    const values = outputs.map((o) => o.forecasts[target]).filter((v): v is number => v !== undefined);
    if (values.length === 0) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = values.length < 2 || mean === 0 ? 0 : Math.abs(values[0]! - values[1]!) / mean;
    out.numeric[target] = { value: mean, agreement: values.length < 2 ? 0.5 : Math.max(0, 1 - spread), models: values.length };
  }
  return out;
}

export async function runModels(adapters: ModelAdapters, vector: MatchFeatureVector, weights: FeatureWeights, modelVersion: string) {
  const context = { weights, modelVersion };
  const results = await Promise.all([adapters.mathematical.run(vector, context), adapters.dataAnalysis.run(vector, context)]);
  return { results, outputs: results.flatMap((res) => (res.ok ? [res.output] : [])) };
}

function level(score: number): ConfidenceLevel {
  return score >= 0.7 ? 'HIGH' : score >= 0.5 ? 'MEDIUM' : 'LOW';
}

export class MatchAnalysisEngine {
  analyze(build: FeatureBuild, modelResults: Awaited<ReturnType<typeof runModels>>, modelVersion: string, featureSnapshotId: string | null, generatedAt: Date): MatchAnalysis {
    const { vector, context, quality, match } = build;
    const v = (n: Parameters<typeof featureValue>[1]) => featureValue(vector, n);
    const home = match.homeTeam.name;
    const away = match.awayTeam.name;
    const combined = ensemble(modelResults.outputs);

    const supporting: string[] = [];
    const conflicting: string[] = [];
    const keyFactors: string[] = [];
    const attacking: string[] = [];
    const defensive: string[] = [];

    const hf = context.home.form;
    const af = context.away.form;
    if (hf.sequence.length > 0 || af.sequence.length > 0) {
      keyFactors.push(`Recent form (last ${hf.metadata.calculationWindow}): ${home} ${hf.record.wins}W ${hf.record.draws}D ${hf.record.losses}L, ${away} ${af.record.wins}W ${af.record.draws}D ${af.record.losses}L.`);
    }
    const ppgH = v('recentFormHome');
    const ppgA = v('recentFormAway');
    if (ppgH !== null && ppgA !== null && Math.abs(ppgH - ppgA) >= 0.3) {
      const better = ppgH > ppgA ? home : away;
      keyFactors.push(`${better} have taken more points per game recently (${r(Math.max(ppgH, ppgA))} vs ${r(Math.min(ppgH, ppgA))}, ${hf.pointsPerGame.sampleSize} and ${af.pointsPerGame.sampleSize} matches).`);
    }
    const compare = (label: string, a: number | null, b: number | null, into: string[], higherIsBetter = true) => {
      if (a === null || b === null) {
        into.push(`${label}: DATA UNAVAILABLE for ${a === null && b === null ? 'both teams' : a === null ? home : away}.`);
        return;
      }
      if (Math.abs(a - b) < 1e-9) into.push(`${label}: level (${r(a)} each).`);
      else {
        const leader = a > b === higherIsBetter ? home : away;
        into.push(`${label}: ${leader} ahead (${home} ${r(a)}, ${away} ${r(b)}).`);
      }
    };
    compare('Goals scored per match', v('goalsHomeAverage'), v('goalsAwayAverage'), attacking);
    compare('Shots per match', v('shotsHomeAverage'), v('shotsAwayAverage'), attacking);
    compare('Shots on target per match', v('shotsOnTargetHomeAverage'), v('shotsOnTargetAwayAverage'), attacking);
    compare('Corners per match', v('cornersHomeAverage'), v('cornersAwayAverage'), attacking);
    compare('Goals conceded per match', v('concededHomeAverage'), v('concededAwayAverage'), defensive, false);
    compare('Cards per match', v('cardsHomeAverage'), v('cardsAwayAverage'), defensive, false);

    const sotH = v('shotsOnTargetHomeAverage');
    const sotA = v('shotsOnTargetAwayAverage');
    if (sotH !== null && sotA !== null && Math.abs(sotH - sotA) >= 1) {
      keyFactors.push(`${sotH > sotA ? home : away} produced more shots on target over their recent matches (${r(Math.max(sotH, sotA))} vs ${r(Math.min(sotH, sotA))} per match).`);
    }
    const homeSplit = v('homeFormAtHome');
    const awaySplit = v('awayFormAway');
    if (homeSplit !== null && awaySplit !== null) {
      keyFactors.push(`Home/away context: ${home} average ${r(homeSplit)} points per home match; ${away} average ${r(awaySplit)} per away match.`);
    }

    const availability: string[] = [...context.home.availability.explanation, ...context.away.availability.explanation];
    if (context.home.availability.status !== 'REPORTED') availability.push(`${home}: availability DATA UNAVAILABLE.`);
    if (context.away.availability.status !== 'REPORTED') availability.push(`${away}: availability DATA UNAVAILABLE.`);
    for (const [team, a] of [[home, context.home.availability], [away, context.away.availability]] as const) {
      const top = a.players.find((p) => p.absenceWeight > 0 && p.impactLabel === 'HIGH');
      if (top) keyFactors.push(`${team} are without ${top.player.name} (${top.status.toLowerCase()}), whose presence has historically been associated with stronger team results (impact ${top.impactScore}/100).`);
    }

    const h2h = context.h2h;
    if (h2h.meetingsUsed > 0) {
      keyFactors.push(
        `Head-to-head: ${h2h.meetingsUsed} known meeting(s) — ${home} ${h2h.results.subjectHomeWins}W ${h2h.results.draws}D ${h2h.results.subjectAwayWins}L; time-weighted reliability ${h2h.reliability} limits its influence.`,
      );
    }

    // Conflicting evidence: recent form and H2H pointing in opposite directions.
    const balance = v('h2hResultBalance');
    const rel = v('h2hReliability') ?? 0;
    let conflictPenalty = 0;
    if (ppgH !== null && ppgA !== null && balance !== null && rel >= 0.3) {
      const formSide = Math.sign(ppgH - ppgA);
      const h2hSide = Math.sign(balance);
      if (formSide !== 0 && h2hSide !== 0 && Math.abs(ppgH - ppgA) >= 0.3 && Math.abs(balance) >= 0.3) {
        if (formSide === h2hSide) supporting.push(`Recent form and head-to-head both favour ${formSide > 0 ? home : away}.`);
        else {
          conflicting.push(`Recent form favours ${formSide > 0 ? home : away} but head-to-head favours ${h2hSide > 0 ? home : away}.`);
          conflictPenalty += 0.1;
        }
      }
    }
    const signals = modelResults.outputs.find((o) => o.modelKind === 'DATA_ANALYSIS')?.components ?? {};
    const signalEntries = Object.entries(signals).filter(([k]) => k.startsWith('signal.'));
    const positive = signalEntries.filter(([, x]) => x > 0.05).length;
    const negative = signalEntries.filter(([, x]) => x < -0.05).length;
    if (positive > 0 && negative > 0) {
      conflicting.push(`${positive} indicator(s) favour ${home} and ${negative} favour ${away}.`);
      conflictPenalty += Math.min(0.1, 0.03 * Math.min(positive, negative));
    } else if (positive + negative >= 3) {
      supporting.push(`${positive + negative} independent indicators point the same way.`);
    }

    const minSample = Math.min(hf.metadata.sampleSize, af.metadata.sampleSize);
    const sampleCoverage = Math.min(1, minSample / hf.metadata.calculationWindow);
    const featureCoverage = quality.featuresAvailable / quality.featuresTotal;
    const availabilityKnown = [context.home.availability, context.away.availability].filter((a) => a.status === 'REPORTED').length / 2;

    const overallConfidence = (agreement: number, signal: number, extra: string[]): Confidence => {
      const score = Math.max(0, Math.min(1, 0.25 * sampleCoverage + 0.2 * featureCoverage + 0.25 * agreement + 0.15 * signal + 0.1 * availabilityKnown + 0.05 * rel - conflictPenalty));
      const reasons = [
        `${minSample} of ${hf.metadata.calculationWindow} recent matches known for the thinner side (sample coverage ${pct(sampleCoverage)}).`,
        `${quality.featuresAvailable} of ${quality.featuresTotal} features available (${pct(featureCoverage)}).`,
        `The two models agree to ${pct(agreement)}.`,
        ...extra,
        availabilityKnown === 1 ? 'Availability reports known for both teams.' : availabilityKnown === 0 ? 'No availability reports known.' : 'Availability known for one team only.',
        ...(conflictPenalty > 0 ? [`Confidence reduced by ${pct(conflictPenalty)} because the evidence conflicts.`] : []),
      ];
      return { level: level(score), score: r(score, 3), reasons };
    };

    const forecasts: TargetForecast[] = [];
    let resultTrend: MatchAnalysis['resultTrend'] = null;
    let headline: Confidence;
    if (combined.MATCH_RESULT) {
      const p = combined.MATCH_RESULT;
      const top = Math.max(p.home, p.draw, p.away);
      const signal = Math.max(0, (top - 1 / 3) / (2 / 3));
      headline = overallConfidence(p.agreement, signal, [`The leading outcome has ${pct(top)} probability (signal strength ${pct(signal)}).`]);
      const label = p.lean === 'HOME' ? home : p.lean === 'AWAY' ? away : 'a draw';
      resultTrend = { lean: p.lean, probabilities: { home: r(p.home, 4), draw: r(p.draw, 4), away: r(p.away, 4) }, explanation: `The combined models lean towards ${label} (${home} ${pct(p.home)}, draw ${pct(p.draw)}, ${away} ${pct(p.away)}).` };
      forecasts.push({ target: 'MATCH_RESULT', predictedValue: r(top, 4), predictedLabel: p.lean, probabilities: resultTrend.probabilities, confidence: headline });
    } else {
      headline = { level: 'LOW', score: 0, reasons: ['No result forecast could be made from the known information.'] };
    }

    const trend = (target: NumericTarget, label: string) => {
      const n = combined.numeric[target];
      if (!n) return null;
      const conf = overallConfidence(n.agreement, 0.5, [`${n.models} model(s) produced a ${label} forecast.`]);
      forecasts.push({ target, predictedValue: r(n.value, 3), predictedLabel: null, probabilities: null, confidence: conf });
      return { expectedTotal: r(n.value), explanation: `Expected ${label}: ${r(n.value)} (model agreement ${pct(n.agreement)}).` };
    };
    const goalTrend = trend('GOALS', 'total goals');
    const cornerTrend = trend('CORNERS', 'total corners');
    const cardTrend = trend('CARDS', 'total cards');
    trend('SHOTS', 'total shots');
    trend('SHOTS_ON_TARGET', 'total shots on target');

    const failed = modelResults.results.filter((res) => !res.ok);
    const warnings = [
      ...failed.map((f) => `Model ${f.ok ? '' : f.model} failed and was excluded: ${f.ok ? '' : f.error}`),
      ...(forecasts.length === 0 ? ['No forecasts produced: insufficient known information.'] : []),
    ];

    return {
      matchId: match.id,
      dataEnvironment: match.dataEnvironment,
      modelVersion,
      featureSnapshotId,
      engineVersion: ENGINE_VERSION,
      asOf: vector.asOf,
      generatedAt: generatedAt.toISOString(),
      resultTrend,
      goalTrend,
      cornerTrend,
      cardTrend,
      attackingComparison: attacking,
      defensiveComparison: defensive,
      availabilityComparison: availability,
      forecasts,
      confidence: headline,
      keyFactors,
      supportingFactors: supporting,
      conflictingFactors: conflicting,
      warnings,
      dataLimitations: quality.warnings,
      dataQuality: quality,
      models: modelResults.results.map((res) =>
        res.ok ? { model: res.output.model, kind: res.output.modelKind, status: 'OK' as const, notes: res.output.notes } : { model: res.model, kind: 'UNKNOWN', status: 'FAILED' as const, notes: [], error: res.error },
      ),
    };
  }
}
