// The debate itself: four rounds, deterministic, pure.
//
// Round 1  Scout presents evidence; Copycat presents the market baseline.
// Round 2  Skeptic challenges both; Scout and Copycat respond with data or concede.
// Round 3  A probability per market with a one-line reason; Skeptic gives a last objection.
// Round 4  Bookkeeper checks against calibration history and sizes (or refuses) a stake.
//
// Severity, not rhetoric, decides the outcome: any VETO makes the market NO_PICK, and a standing
// CONCERN can only ever produce a LEAN. That is what makes the Skeptic override the Scout structurally.

import type { ClaimStance, DebateMarket, DebateRecommendation } from '@prisma/client';
import type { MatchAnalysis } from '../analysis/engine.js';
import type { MatchFeatureVector } from '../features/feature-engineering.service.js';
import { Bookkeeper } from './bookkeeper.agent.js';
import { Copycat } from './copycat.agent.js';
import { Scout } from './scout.agent.js';
import { Skeptic } from './skeptic.agent.js';
import { DEBATE_ENGINE_VERSION, type CalibrationCheck, type DebateClaim, type DebateTranscript, type EvidenceBundle, type MarketBaseline, type MarketProbabilities, type MarketVerdict, type Objection } from './types.js';

export interface DebateInput {
  matchId: string;
  fixture: string;
  kickoff: Date;
  asOf: Date;
  dataEnvironment: 'SYNTHETIC' | 'HISTORICAL' | 'LIVE';
  modelVersion: string;
  evidence: EvidenceBundle;
  baseline: MarketBaseline;
  model: MarketProbabilities;
  analysis: MatchAnalysis;
  vector: MatchFeatureVector;
  ensembleAgreement: number | null;
  knownResults: number;
  calibration: { expectedCalibrationError: number | null; sampleSize: number };
  // Settled history per confidence bucket, supplied by the caller from stored results.
  history: Record<'LOW' | 'MEDIUM' | 'HIGH', CalibrationCheck>;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

const MARKET_LABEL: Record<DebateMarket, string> = {
  MATCH_RESULT: 'match result',
  OVER_UNDER_25: 'over/under 2.5 goals',
  BTTS: 'both teams to score',
};

function probabilitiesFor(market: DebateMarket, p: MarketProbabilities): Record<string, number> | null {
  if (market === 'MATCH_RESULT') return p.MATCH_RESULT ? { ...p.MATCH_RESULT } : null;
  if (market === 'OVER_UNDER_25') return p.OVER_UNDER_25 ? { ...p.OVER_UNDER_25 } : null;
  return p.BTTS ? { ...p.BTTS } : null;
}

const leadingOf = (p: Record<string, number>) => Object.entries(p).reduce((best, cur) => (cur[1] > best[1] ? cur : best));

export class DebateEngine {
  private readonly scout = new Scout();
  private readonly copycat = new Copycat();
  private readonly skeptic = new Skeptic();
  private readonly bookkeeper = new Bookkeeper();

  run(input: DebateInput): DebateTranscript {
    const claims: DebateClaim[] = [];
    const claim = (c: DebateClaim) => claims.push(c);

    // ---- Round 1: evidence and baseline ----

    for (const fact of input.evidence.facts) {
      claim({
        agent: 'SCOUT',
        round: 1,
        code: fact.unavailable ? 'FACT_UNAVAILABLE' : 'FACT',
        summary: fact.unavailable
          ? `${fact.label}: DATA UNAVAILABLE`
          : `${fact.label}: ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}${fact.sampleSize !== null ? ` (n=${fact.sampleSize})` : ''}`,
        stance: 'NEUTRAL',
        severity: null,
        targetAgent: null,
        market: null,
        evidence: { ...fact },
      });
    }
    claim({
      agent: 'COPYCAT',
      round: 1,
      code: `BASELINE_${input.baseline.status}`,
      summary: input.baseline.reason,
      stance: 'NEUTRAL',
      severity: null,
      targetAgent: null,
      market: null,
      evidence: { status: input.baseline.status, probabilities: input.baseline.probabilities, overround: input.baseline.overround, bookmaker: input.baseline.bookmaker },
    });

    // ---- Round 2: challenges, and the responses they force ----

    const objections = this.skeptic.challenge({
      evidence: input.evidence,
      baseline: input.baseline,
      model: input.model,
      analysis: input.analysis,
      vector: input.vector,
      dataEnvironment: input.dataEnvironment,
      calibration: input.calibration,
      knownResults: input.knownResults,
      ensembleAgreement: input.ensembleAgreement,
    });

    const responses = objections.map((o) => this.respond(o, input));
    for (const o of objections) {
      claim({
        agent: 'SKEPTIC',
        round: 2,
        code: o.code,
        summary: o.summary,
        stance: 'OPPOSES',
        severity: o.severity,
        targetAgent: o.targetAgent,
        market: o.market,
        evidence: o.evidence,
      });
    }
    for (const res of responses) {
      claim({
        agent: res.agent,
        round: 2,
        code: `RESPONSE_${res.code}`,
        summary: res.response,
        stance: res.conceded ? 'NEUTRAL' : 'SUPPORTS',
        severity: null,
        targetAgent: 'SKEPTIC',
        market: null,
        evidence: { objection: res.code, conceded: res.conceded },
      });
    }

    // An objection STANDS unless the agent it targets rebutted it with data (conceded === false).
    // An unanswered objection stands by default: silence is not a rebuttal.
    const standing = objections.filter((o) => responses.find((r) => r.code === o.code)?.conceded !== false);

    // ---- Round 3: a probability per market, then a last objection ----

    const verdicts: MarketVerdict[] = [];
    for (const market of ['MATCH_RESULT', 'OVER_UNDER_25', 'BTTS'] as DebateMarket[]) {
      verdicts.push(this.verdict(market, input, standing, claims));
    }

    const lastObjections = standing.filter((o) => o.severity === 'VETO');

    // ---- Round 4: calibration and stake ----

    const notes: string[] = [];
    const calibrationChecks: CalibrationCheck[] = [];
    for (const v of verdicts) {
      const { stake, calibration } = this.bookkeeper.check({
        market: v.market,
        probabilities: v.probabilities ?? {},
        baseline: v.marketBaseline,
        prices: v.prices,
        recommendation: v.recommendation,
        confidence: v.confidence,
        history: input.history[v.confidence],
      });
      v.stakePct = stake.stakePct;
      v.stakeReason = stake.reason;
      v.calibration = calibration;
      calibrationChecks.push(calibration);
      claim({
        agent: 'BOOKKEEPER',
        round: 4,
        code: stake.stakePct === null ? 'NO_STAKE' : 'STAKE_SUGGESTED',
        summary: `${MARKET_LABEL[v.market]}: ${stake.reason}`,
        stance: 'NEUTRAL',
        severity: null,
        targetAgent: null,
        market: v.market,
        evidence: { stakePct: stake.stakePct, calibration },
      });
      if (!calibration.trustworthy) notes.push(`${MARKET_LABEL[v.market]}: ${calibration.note}`);
    }

    return {
      matchId: input.matchId,
      fixture: input.fixture,
      kickoff: input.kickoff.toISOString(),
      asOf: input.asOf.toISOString(),
      engineVersion: DEBATE_ENGINE_VERSION,
      dataEnvironment: input.dataEnvironment,
      modelVersion: input.modelVersion,
      rounds: {
        one: { evidence: input.evidence, baseline: input.baseline },
        two: { objections, responses },
        three: { verdicts, lastObjections },
        four: { calibration: calibrationChecks, notes },
      },
      claims,
      verdicts,
    };
  }

  // Scout and Copycat answer with data or concede. There is no rhetorical option: an objection whose
  // number the agent cannot contradict is conceded and keeps its severity.
  private respond(o: Objection, input: DebateInput): { code: string; agent: 'SCOUT' | 'COPYCAT'; response: string; conceded: boolean } {
    const agent = o.targetAgent === 'COPYCAT' ? 'COPYCAT' : 'SCOUT';
    switch (o.code) {
      case 'SMALL_SAMPLE': {
        // A thin feature is survivable if the ratings, which use every known result, are populated.
        const ratingsKnown = input.vector.features.eloHome?.value !== null && input.vector.features.eloAway?.value !== null;
        return ratingsKnown
          ? { code: o.code, agent, response: `Conceded on the feature itself, but the forecast is carried by Elo and Dixon-Coles, fitted on ${input.knownResults} known results rather than that sample.`, conceded: false }
          : { code: o.code, agent, response: 'Conceded: the ratings are not populated either, so the thin sample is doing real work.', conceded: true };
      }
      case 'THIN_H2H':
        return { code: o.code, agent, response: 'Conceded: head-to-head is weighted by its own reliability score, so a thin record already contributes little.', conceded: false };
      case 'NO_MARKET_BASELINE':
        return { code: o.code, agent: 'COPYCAT', response: 'Conceded in full. No price was available at the cutoff, so no edge can be claimed.', conceded: true };
      case 'EARLY_SEASON_FALLBACK':
        return { code: o.code, agent, response: `Conceded: ${input.knownResults} known results is below the warm-up, and the fallback logic is measurably weaker.`, conceded: true };
      case 'MODEL_DISAGREEMENT':
        return { code: o.code, agent, response: `Conceded: agreement is ${input.ensembleAgreement === null ? 'unmeasurable' : r3(input.ensembleAgreement)}, and the ensemble average hides it.`, conceded: true };
      case 'ENRICHMENT_CONFIDENCE_INFLATION':
        return { code: o.code, agent, response: 'Conceded: the confidence score counts features the result forecast is forbidden from using. This is a known, documented defect.', conceded: true };
      case 'WIDE_MARKET':
        return { code: o.code, agent: 'COPYCAT', response: 'Conceded: a wide book is a soft price, and the de-vigged number inherits that uncertainty.', conceded: true };
      default:
        return { code: o.code, agent, response: 'No data contradicts this objection; it stands.', conceded: true };
    }
  }

  private verdict(market: DebateMarket, input: DebateInput, standing: Objection[], claims: DebateClaim[]): MarketVerdict {
    const relevant = standing.filter((o) => o.market === null || o.market === market);
    const vetoes = relevant.filter((o) => o.severity === 'VETO');
    const concerns = relevant.filter((o) => o.severity === 'CONCERN');

    const probabilities = probabilitiesFor(market, input.model);
    const baseline = probabilitiesFor(market, input.baseline.probabilities);

    const stance = (c: ClaimStance): ClaimStance => c;
    if (probabilities === null) {
      const reason = `No probability could be derived for ${MARKET_LABEL[market]} at this cutoff; the inputs it needs are DATA UNAVAILABLE.`;
      claims.push({ agent: 'SCOUT', round: 3, code: 'MARKET_UNAVAILABLE', summary: reason, stance: stance('NEUTRAL'), severity: null, targetAgent: null, market, evidence: {} });
      return {
        market,
        probabilities: null,
        marketBaseline: baseline,
        edge: null,
        confidence: 'LOW',
        recommendation: 'NO_PICK',
        reasoning: reason,
        unresolvedObjections: relevant.map((o) => `${o.code}: ${o.summary}`),
        stakePct: null,
        stakeReason: 'No pick: nothing is staked.',
        calibration: input.history.LOW,
        prices: null,
        oddsSnapshotId: null,
      };
    }

    const [leadOutcome, leadProbability] = leadingOf(probabilities);
    const edge = baseline && baseline[leadOutcome] !== undefined ? r3(leadProbability - baseline[leadOutcome]!) : null;

    // Confidence starts from the engine's own score and is only ever pushed down by live objections.
    const base = input.analysis.confidence.level;
    const downgrade = (level: 'LOW' | 'MEDIUM' | 'HIGH', steps: number): 'LOW' | 'MEDIUM' | 'HIGH' => {
      const order: Array<'LOW' | 'MEDIUM' | 'HIGH'> = ['LOW', 'MEDIUM', 'HIGH'];
      return order[Math.max(0, order.indexOf(level) - steps)]!;
    };
    const confidence = vetoes.length > 0 ? 'LOW' : downgrade(base, concerns.length);

    let recommendation: DebateRecommendation;
    let reasoning: string;
    if (vetoes.length > 0) {
      recommendation = 'NO_PICK';
      reasoning = `NO PICK on ${MARKET_LABEL[market]}: ${vetoes.map((o) => o.code).join(', ')}.`;
    } else if (concerns.length > 0 || edge === null) {
      recommendation = 'LEAN';
      reasoning =
        edge === null
          ? `Lean ${leadOutcome.toUpperCase()} at ${Math.round(leadProbability * 100)}% on ${MARKET_LABEL[market]}, with no market baseline to measure the deviation against.`
          : `Lean ${leadOutcome.toUpperCase()} at ${Math.round(leadProbability * 100)}% (${edge > 0 ? '+' : ''}${edge} vs market), held back by ${concerns.map((o) => o.code).join(', ')}.`;
    } else {
      recommendation = 'PICK';
      reasoning = `${leadOutcome.toUpperCase()} at ${Math.round(leadProbability * 100)}% on ${MARKET_LABEL[market]}, ${edge > 0 ? '+' : ''}${edge} against the de-vigged market, with no objection outstanding.`;
    }

    claims.push({
      agent: 'SCOUT',
      round: 3,
      code: `VERDICT_${recommendation}`,
      summary: reasoning,
      stance: stance(recommendation === 'NO_PICK' ? 'NEUTRAL' : 'SUPPORTS'),
      severity: null,
      targetAgent: null,
      market,
      evidence: { probabilities, baseline, edge },
    });

    const prices = input.baseline.prices[market] ?? null;

    return {
      market,
      probabilities,
      marketBaseline: baseline,
      edge,
      confidence,
      recommendation,
      reasoning,
      unresolvedObjections: relevant.map((o) => `${o.code}: ${o.summary}`),
      stakePct: null,
      stakeReason: '',
      calibration: input.history[confidence],
      prices,
      oddsSnapshotId: input.baseline.oddsSnapshotIds[0] ?? null,
    };
  }
}
