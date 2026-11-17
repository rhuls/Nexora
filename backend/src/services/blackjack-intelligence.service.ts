// Keeping a record of what the model predicted, and judging it against what happened.
//
// The solver is never edited here. A correction, if the evidence ever supports one, is stored as a
// separate version alongside it, so the baseline remains available to be measured against.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  applyCalibration, compareOnValidation, evaluate, fitCalibration, rollingWindows,
  splitObservations, type Evaluation, type PairedComparison,
} from '../blackjack/evaluation.js';
import { dealerOutcomeIndex, simulateObservations, type Observation, type ObservationSource, type Policy } from '../blackjack/observations.js';
import { evaluate as solve, handTotal } from '../blackjack/solver.js';
import { isNatural, remainingComposition, settleHand } from '../blackjack/trainer.js';
import { DEFAULT_RULES, type Rules } from '../blackjack/types.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Rules change what the correct forecast is, so a version is tied to the rules it was built for. */
export function rulesKey(rules: Rules): string {
  return [
    `${rules.decks}d`,
    rules.hitSoft17 ? 'h17' : 's17',
    rules.doubleAnyTwo ? 'dany' : 'd9to11',
    rules.das ? 'das' : 'nodas',
    rules.surrender ? 'surr' : 'nosurr',
    `bj${rules.blackjackPays}`,
    rules.peek ? 'peek' : 'nopeek',
  ].join('-');
}

export const SOLVER_VERSION = (rules: Rules): string => `solver-1.0/${rulesKey(rules)}`;

export class BlackjackIntelligenceService {
  constructor(private readonly db: Db) {}

  /** The baseline for a set of rules, created on first use. Exact enumeration has no alternative. */
  async solverVersion(rules: Rules): Promise<{ id: string; version: string }> {
    const version = SOLVER_VERSION(rules);
    const existing = await this.db.blackjackModelVersion.findUnique({ where: { version }, select: { id: true, version: true } });
    if (existing) return existing;
    try {
      return await this.db.blackjackModelVersion.create({
        data: {
          version,
          kind: 'SOLVER',
          rules: rules as unknown as Prisma.InputJsonValue,
          notes: 'Exact enumeration of the dealer outcomes over the cards remaining. The baseline, never modified.',
          activatedAt: new Date(),
        },
        select: { id: true, version: true },
      });
    } catch (error) {
      // Another caller created it first; that row is as good as this one would have been.
      const raced = await this.db.blackjackModelVersion.findUnique({ where: { version }, select: { id: true, version: true } });
      if (raced) return raced;
      throw error;
    }
  }

  async record(observations: readonly Observation[], source: ObservationSource): Promise<number> {
    if (observations.length === 0) return 0;
    const version = await this.solverVersion(observations[0].rules);
    const rows = observations.map((o) => ({
      modelVersionId: version.id,
      source,
      predictedAt: o.predictedAt,
      rules: o.rules as unknown as Prisma.InputJsonValue,
      playerCards: o.playerCards,
      dealerUpcard: o.dealerUpcard,
      remaining: o.remaining,
      unseenCards: o.unseenCards,
      dealerDistribution: o.dealerDistribution,
      actionEvs: o.actionEvs as unknown as Prisma.InputJsonValue,
      bestAction: o.bestAction,
      bestActionEv: o.bestActionEv,
      dealerFinalCards: o.dealerFinalCards,
      dealerOutcome: o.dealerOutcome,
      playerFinalCards: o.playerFinalCards,
      playerTotal: o.playerTotal,
      settled: o.settled,
      net: o.net,
      cardsDrawnAfterForecast: o.cardsDrawnAfterForecast,
    }));
    let written = 0;
    // Chunked so one oversized request cannot build a single statement the database refuses.
    for (let i = 0; i < rows.length; i += 1000) {
      written += (await this.db.blackjackObservation.createMany({ data: rows.slice(i, i + 1000) })).count;
    }
    return written;
  }

  /**
   * Records a hand that was actually played.
   *
   * The caller sends what it saw, never what the model said: the forecast is recomputed here from
   * those same inputs. A stored forecast is then always one this code produced, and anyone can
   * reproduce it from the row.
   */
  async recordPlayed(input: PlayedHand): Promise<{ recorded: number; observation: Observation }> {
    // A hand has to be an instance of the thing that was forecast, or it is not evidence about it.
    if (input.dealerFinalCards[0] !== input.dealerUpcard) {
      throw new ObservationRejected('The dealer hand must begin with the upcard that was showing.');
    }
    if (input.rules.peek && isNatural(input.dealerFinalCards.slice(0, 2))) {
      throw new ObservationRejected('The dealer held a natural, so at a table that peeks this hand ended before anyone acted. The forecast is conditioned on the dealer not holding one, so this hand is not an instance of it.');
    }
    if (isNatural(input.playerCards)) {
      throw new ObservationRejected('The player held a natural, which settles without a decision and without the dealer playing out.');
    }
    if (input.playerFinalCards.length < input.playerCards.length || input.playerCards.some((c, i) => input.playerFinalCards[i] !== c)) {
      throw new ObservationRejected('The final player hand must begin with the cards that were dealt.');
    }

    const remaining = remainingComposition(input.rules, [...input.seen, ...input.playerCards, input.dealerUpcard]);
    const decision = solve(input.playerCards, input.dealerUpcard, remaining, input.rules, {});
    const dealerOutcome = dealerOutcomeIndex(input.dealerFinalCards);
    if (dealerOutcome < 0) throw new Error('The dealer hand given never reached a final total');
    const settlement = settleHand(input.playerFinalCards, input.dealerFinalCards, input.stake, input.surrendered, input.rules);

    const observation: Observation = {
      modelVersion: SOLVER_VERSION(input.rules),
      predictedAt: input.predictedAt,
      rules: input.rules,
      playerCards: input.playerCards,
      dealerUpcard: input.dealerUpcard,
      remaining,
      unseenCards: remaining.reduce((sum, c) => sum + c, 0),
      dealerDistribution: Array.from(decision.dealerDistribution),
      actionEvs: decision.actions.map((a) => ({ action: a.action, ev: a.ev })),
      bestAction: decision.best.action,
      bestActionEv: decision.best.ev,
      dealerFinalCards: input.dealerFinalCards,
      dealerOutcome,
      playerFinalCards: input.playerFinalCards,
      playerTotal: handTotal(input.playerFinalCards)[0],
      settled: settlement.outcome,
      net: settlement.net,
      cardsDrawnAfterForecast: Math.max(0, input.playerFinalCards.length - input.playerCards.length),
      source: 'PLAYED',
    };
    return { recorded: await this.record([observation], 'PLAYED'), observation };
  }

  async simulate(options: { rounds: number; rules?: Rules; seed?: number; policy?: Policy }): Promise<{ generated: number; recorded: number }> {
    const rules = options.rules ?? DEFAULT_RULES;
    const observations = simulateObservations({
      rounds: options.rounds,
      rules,
      seed: options.seed ?? Math.floor(Math.random() * 2 ** 31),
      policy: options.policy ?? 'stand',
      modelVersion: SOLVER_VERSION(rules),
      now: new Date(),
    });
    return { generated: observations.length, recorded: await this.record(observations, 'SIMULATED') };
  }

  private async load(rules: Rules, source: ObservationSource | 'ALL', limit: number): Promise<Observation[]> {
    const version = await this.solverVersion(rules);
    const rows = await this.db.blackjackObservation.findMany({
      where: { modelVersionId: version.id, ...(source === 'ALL' ? {} : { source }) },
      orderBy: { predictedAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({
      modelVersion: version.version,
      predictedAt: r.predictedAt,
      rules: r.rules as unknown as Rules,
      playerCards: r.playerCards,
      dealerUpcard: r.dealerUpcard,
      remaining: r.remaining,
      unseenCards: r.unseenCards,
      dealerDistribution: r.dealerDistribution,
      actionEvs: r.actionEvs as unknown as Observation['actionEvs'],
      bestAction: r.bestAction as Observation['bestAction'],
      bestActionEv: r.bestActionEv,
      dealerFinalCards: r.dealerFinalCards,
      dealerOutcome: r.dealerOutcome,
      playerFinalCards: r.playerFinalCards,
      playerTotal: r.playerTotal,
      settled: r.settled as Observation['settled'],
      net: r.net,
      cardsDrawnAfterForecast: r.cardsDrawnAfterForecast,
      source: r.source,
    }));
  }

  /**
   * Scores the record, looks for weaknesses, and puts a fitted correction on trial.
   *
   * The correction is fitted on one part of the record and judged on the other, so it cannot pass
   * by having memorised what it is being tested on. The verdict is stored either way: a refusal is
   * as much a result as an acceptance, and burying it would make the accepted ones meaningless.
   */
  async runEvaluation(options: { rules?: Rules; source?: ObservationSource | 'ALL'; limit?: number; windowSize?: number } = {}): Promise<EvaluationReport> {
    const rules = options.rules ?? DEFAULT_RULES;
    const source = options.source ?? 'ALL';
    const limit = options.limit ?? 200_000;
    const observations = await this.load(rules, source, limit);
    const version = await this.solverVersion(rules);

    const result = evaluate(observations);
    const windows = rollingWindows(observations, options.windowSize ?? Math.max(500, Math.floor(observations.length / 12)));
    const { training, validation } = splitObservations(observations);
    const candidate = fitCalibration(training);
    const comparison = compareOnValidation(validation, (o) => applyCalibration(candidate, o));

    const report: EvaluationReport = {
      modelVersion: version.version,
      source,
      observations: observations.length,
      training: training.length,
      validation: validation.length,
      evaluation: result,
      windows,
      recalibration: {
        priorStrength: candidate.priorStrength,
        adjustments: candidate.adjustments,
        comparison,
        verdict: verdictFor(comparison, observations.length),
      },
      generatedAt: new Date(),
    };

    await this.db.blackjackEvaluationRun.create({
      data: {
        modelVersionId: version.id,
        observationCount: observations.length,
        trainingCount: training.length,
        validationCount: validation.length,
        source,
        summary: report as unknown as Prisma.InputJsonValue,
        recalibrationJustified: comparison.justified,
        notes: report.recalibration.verdict,
      },
    });
    return report;
  }

  async history(rules: Rules = DEFAULT_RULES, take = 20): Promise<Array<{ id: string; createdAt: Date; observationCount: number; recalibrationJustified: boolean; notes: string; source: string }>> {
    const version = await this.solverVersion(rules);
    return this.db.blackjackEvaluationRun.findMany({
      where: { modelVersionId: version.id },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, createdAt: true, observationCount: true, recalibrationJustified: true, notes: true, source: true },
    });
  }

  async counts(rules: Rules = DEFAULT_RULES): Promise<{ played: number; simulated: number }> {
    const version = await this.solverVersion(rules);
    const [played, simulated] = await Promise.all([
      this.db.blackjackObservation.count({ where: { modelVersionId: version.id, source: 'PLAYED' } }),
      this.db.blackjackObservation.count({ where: { modelVersionId: version.id, source: 'SIMULATED' } }),
    ]);
    return { played, simulated };
  }
}

function verdictFor(comparison: PairedComparison, n: number): string {
  if (n < 2000) return `Too few observations (${n}) to put a correction on trial; nothing was changed.`;
  if (comparison.justified) {
    return `A fitted correction improved log loss by ${comparison.meanImprovement.toFixed(5)} per hand on ${comparison.n.toLocaleString()} held-out observations (95% interval ${comparison.interval.low.toFixed(5)} to ${comparison.interval.high.toFixed(5)}, p = ${comparison.pValue.toExponential(2)}). Recalibration is justified.`;
  }
  return `A fitted correction changed held-out log loss by ${comparison.meanImprovement.toFixed(5)} per hand (95% interval ${comparison.interval.low.toFixed(5)} to ${comparison.interval.high.toFixed(5)}, p = ${comparison.pValue.toFixed(3)}), which is not distinguishable from chance. The solver is left as it is.`;
}

export type EvaluationReport = {
  modelVersion: string;
  source: string;
  observations: number;
  training: number;
  validation: number;
  evaluation: Evaluation;
  windows: ReturnType<typeof rollingWindows>;
  recalibration: {
    priorStrength: number;
    adjustments: ReturnType<typeof fitCalibration>['adjustments'];
    comparison: PairedComparison;
    verdict: string;
  };
  generatedAt: Date;
};

/** A hand that cannot be scored against the forecast, with the reason given to the caller. */
export class ObservationRejected extends Error {}

export interface PlayedHand {
  rules: Rules;
  /** Cards already out of the shoe before this hand, excluding its own opening cards. */
  seen: number[];
  playerCards: number[];
  dealerUpcard: number;
  dealerFinalCards: number[];
  playerFinalCards: number[];
  stake: number;
  surrendered: boolean;
  predictedAt: Date;
}
