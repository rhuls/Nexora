// SKEPTIC — attacks everything. Each objection is a coded rule that must name the specific weakness and
// carry the number behind it, so "this is uncertain" can never be the output.
//
// Severity decides what happens downstream: VETO forces NO_PICK, CONCERN downgrades a pick to a lean,
// NOTE is recorded and nothing more. The Skeptic's findings override the Scout's enthusiasm by construction,
// because the engine applies severity after both have spoken.

import type { ISkeptic, Objection, SkepticInput } from './types.js';
import { STAKING } from './staking.js';

export const SKEPTIC_RULES = {
  // Below this many matches, a per-match average is an anecdote.
  minFormSample: 3,
  // Head-to-head reliability from the h2h analyzer, 0-1.
  minH2hReliability: 0.4,
  // Share of the 41 features that must be populated before the vector is considered usable.
  minFeatureCoverage: 0.6,
  // Dixon-Coles and Elo need this many known results; below it the models fall back to the legacy logic.
  minKnownResults: 100,
  // Ensemble agreement below this means the two models genuinely disagree.
  minModelAgreement: 0.75,
  // An availability picture older than this is not the team news that will matter at kickoff.
  maxAvailabilityAgeHours: 72,
} as const;

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export class Skeptic implements ISkeptic {
  readonly id = 'SKEPTIC' as const;

  challenge(input: SkepticInput): Objection[] {
    const out: Objection[] = [];
    const add = (o: Objection) => out.push(o);

    // --- Attacks on the environment itself ---

    if (input.dataEnvironment === 'SYNTHETIC') {
      add({
        code: 'SYNTHETIC_ENV',
        summary: 'This match is synthetic development data. Any verdict on it is a demonstration of the pipeline, not evidence about football.',
        severity: 'VETO',
        targetAgent: 'SCOUT',
        market: null,
        evidence: { dataEnvironment: 'SYNTHETIC' },
      });
    }

    // --- Attacks on Scout ---

    const quality = input.evidence.dataQuality;
    const coverage = quality.featuresTotal === 0 ? 0 : quality.featuresAvailable / quality.featuresTotal;
    if (coverage < SKEPTIC_RULES.minFeatureCoverage) {
      add({
        code: 'MISSING_FEATURES',
        summary: `Only ${quality.featuresAvailable} of ${quality.featuresTotal} features (${Math.round(coverage * 100)}%) could be populated at the cutoff; the forecast rests on a partial picture.`,
        severity: coverage < 0.4 ? 'VETO' : 'CONCERN',
        targetAgent: 'SCOUT',
        market: null,
        evidence: { featuresAvailable: quality.featuresAvailable, featuresTotal: quality.featuresTotal, coverage: r3(coverage), threshold: SKEPTIC_RULES.minFeatureCoverage },
      });
    }

    for (const fact of input.evidence.facts) {
      if (fact.unavailable || fact.sampleSize === null) continue;
      if (fact.sampleSize > 0 && fact.sampleSize < SKEPTIC_RULES.minFormSample && fact.unit !== null) {
        add({
          code: 'SMALL_SAMPLE',
          summary: `${fact.label} is computed from ${fact.sampleSize} match(es); that is an anecdote, not a rate.`,
          severity: 'CONCERN',
          targetAgent: 'SCOUT',
          market: null,
          evidence: { fact: fact.key, sampleSize: fact.sampleSize, threshold: SKEPTIC_RULES.minFormSample },
        });
      }
    }

    const h2hReliability = input.vector.features.h2hReliability?.value ?? null;
    if (h2hReliability !== null && h2hReliability < SKEPTIC_RULES.minH2hReliability) {
      add({
        code: 'THIN_H2H',
        summary: `Head-to-head reliability is ${r3(h2hReliability)} (below ${SKEPTIC_RULES.minH2hReliability}); these meetings are too few or too old to carry weight.`,
        severity: 'NOTE',
        targetAgent: 'SCOUT',
        market: null,
        evidence: { h2hReliability: r3(h2hReliability), threshold: SKEPTIC_RULES.minH2hReliability },
      });
    }

    const staleAvailability = input.evidence.facts.filter((f) => f.key.endsWith('Absentees') && f.staleHours !== null);
    for (const fact of staleAvailability) {
      add({
        code: 'STALE_AVAILABILITY',
        summary: `${fact.label} rests on a report ${Math.round(fact.staleHours!)}h before the cutoff (limit ${SKEPTIC_RULES.maxAvailabilityAgeHours}h); the team news may have moved since.`,
        severity: 'CONCERN',
        targetAgent: 'SCOUT',
        market: null,
        evidence: { fact: fact.key, ageHours: Math.round(fact.staleHours!), threshold: SKEPTIC_RULES.maxAvailabilityAgeHours },
      });
    }

    const missingAvailability = input.evidence.facts.filter((f) => f.key.endsWith('Absentees') && f.unavailable);
    if (missingAvailability.length > 0) {
      add({
        code: 'NO_AVAILABILITY_DATA',
        summary: `No availability report was published before the cutoff for ${missingAvailability.length === 2 ? 'either side' : 'one side'}; absences are UNKNOWN, not zero.`,
        severity: 'CONCERN',
        targetAgent: 'SCOUT',
        market: null,
        evidence: { sides: missingAvailability.map((f) => f.key) },
      });
    }

    // --- Attacks on the models ---

    if (input.knownResults < SKEPTIC_RULES.minKnownResults) {
      add({
        code: 'EARLY_SEASON_FALLBACK',
        summary: `Only ${input.knownResults} results were known before the cutoff; Dixon-Coles and Elo need about ${SKEPTIC_RULES.minKnownResults}, so the ratings have not settled and the models fall back to the legacy logic.`,
        severity: 'CONCERN',
        targetAgent: 'SCOUT',
        market: null,
        evidence: { knownResults: input.knownResults, required: SKEPTIC_RULES.minKnownResults },
      });
    }

    const ensembleAgreement = input.ensembleAgreement;
    if (ensembleAgreement !== null && ensembleAgreement < SKEPTIC_RULES.minModelAgreement) {
      add({
        code: 'MODEL_DISAGREEMENT',
        summary: `The two models agree only ${Math.round(ensembleAgreement * 100)}% (threshold ${Math.round(SKEPTIC_RULES.minModelAgreement * 100)}%); the ensemble is averaging a genuine disagreement, not confirming a signal.`,
        severity: 'CONCERN',
        targetAgent: 'SCOUT',
        market: 'MATCH_RESULT',
        evidence: { agreement: r3(ensembleAgreement), threshold: SKEPTIC_RULES.minModelAgreement },
      });
    }

    const failed = input.analysis.models.filter((m) => m.status === 'FAILED');
    if (failed.length > 0) {
      add({
        code: 'MODEL_FAILED',
        summary: `${failed.length} of ${input.analysis.models.length} models failed to produce output (${failed.map((m) => m.model).join(', ')}); the ensemble is thinner than it looks.`,
        severity: failed.length >= input.analysis.models.length ? 'VETO' : 'CONCERN',
        targetAgent: 'SCOUT',
        market: null,
        evidence: { failed: failed.map((m) => ({ model: m.model, error: m.error })) },
      });
    }

    // The draw rate in the Premier League is about 25%, and the documented limitation is that the model
    // rarely calls one. A DRAW lean is therefore unusual enough to flag rather than trust.
    if (input.model.MATCH_RESULT) {
      const { home, draw, away } = input.model.MATCH_RESULT;
      const lean = home >= draw && home >= away ? 'HOME' : away >= draw ? 'AWAY' : 'DRAW';
      if (lean === 'DRAW') {
        add({
          code: 'DRAW_BLINDSPOT',
          summary: `The model leans DRAW (${Math.round(draw * 100)}%), which it is documented to do rarely and badly; a tuned draw rule failed out-of-sample.`,
          severity: 'CONCERN',
          targetAgent: 'SCOUT',
          market: 'MATCH_RESULT',
          evidence: { probabilities: { home: r3(home), draw: r3(draw), away: r3(away) } },
        });
      }
    }

    // Documented side effect: the confidence score counts populated features, so enrichment raises it
    // even though enriched features are firewalled out of the result forecast.
    const enrichmentFilled = input.evidence.facts.filter((f) => !f.unavailable && f.source === 'api-football').length;
    if (enrichmentFilled > 0 && input.analysis.confidence.level === 'HIGH') {
      add({
        code: 'ENRICHMENT_CONFIDENCE_INFLATION',
        summary: `Confidence is HIGH with ${enrichmentFilled} enrichment-sourced features populated, but those features are excluded from the result forecast; the confidence counts data the forecast did not use.`,
        severity: 'NOTE',
        targetAgent: 'SCOUT',
        market: null,
        evidence: { enrichmentFilled, confidence: input.analysis.confidence.level },
      });
    }

    // --- Attacks on Copycat and on the edge ---

    if (input.baseline.status !== 'AVAILABLE') {
      add({
        code: 'NO_MARKET_BASELINE',
        summary: `No usable market baseline (${input.baseline.status}): ${input.baseline.reason} Without it the edge is unmeasurable, so no deviation can be justified.`,
        severity: 'CONCERN',
        targetAgent: 'COPYCAT',
        market: null,
        evidence: { status: input.baseline.status, reason: input.baseline.reason },
      });
    }

    if (input.baseline.status === 'AVAILABLE' || input.baseline.status === 'STALE') {
      for (const [market, book] of Object.entries(input.baseline.overround)) {
        if (book > 1.12) {
          add({
            code: 'WIDE_MARKET',
            summary: `${market} is priced at an overround of ${book.toFixed(3)}; a book that wide is a soft market whose de-vigged probabilities carry real uncertainty of their own.`,
            severity: 'NOTE',
            targetAgent: 'COPYCAT',
            market: market as Objection['market'],
            evidence: { overround: book },
          });
        }
      }
    }

    // An edge smaller than the model's own calibration error is indistinguishable from miscalibration.
    const ece = input.calibration.expectedCalibrationError;
    if (ece !== null && input.baseline.probabilities.MATCH_RESULT && input.model.MATCH_RESULT) {
      const m = input.model.MATCH_RESULT;
      const b = input.baseline.probabilities.MATCH_RESULT;
      const lean = m.home >= m.draw && m.home >= m.away ? 'home' : m.away >= m.draw ? 'away' : 'draw';
      const edge = m[lean] - b[lean];
      if (Math.abs(edge) < Math.max(ece, STAKING.minEdge)) {
        add({
          code: 'EDGE_WITHIN_NOISE',
          summary: `The ${r3(edge)} edge on ${lean.toUpperCase()} is smaller than the model's own calibration error (${r3(ece)}, n=${input.calibration.sampleSize}); it cannot be distinguished from miscalibration.`,
          severity: 'VETO',
          targetAgent: 'SCOUT',
          market: 'MATCH_RESULT',
          evidence: { edge: r3(edge), expectedCalibrationError: r3(ece), calibrationSamples: input.calibration.sampleSize, minEdge: STAKING.minEdge },
        });
      }
    }

    if (ece === null) {
      add({
        code: 'NO_CALIBRATION_HISTORY',
        summary: `The active model has no settled calibration history in ${input.dataEnvironment} (n=${input.calibration.sampleSize}); there is no basis for trusting its stated probabilities.`,
        severity: 'CONCERN',
        targetAgent: 'BOOKKEEPER',
        market: null,
        evidence: { sampleSize: input.calibration.sampleSize, dataEnvironment: input.dataEnvironment },
      });
    }

    return out;
  }

}
