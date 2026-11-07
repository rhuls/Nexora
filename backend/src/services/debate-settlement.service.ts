// Settling debate picks and reporting on them.
//
// A pick is settled only against a finished match with both scores recorded. Settlement is append-only:
// the pick itself is never rewritten, so what the debate believed before kickoff stays on the record.

import type { DataEnvironment, DebateMarket, Prisma, PrismaClient } from '@prisma/client';
import { flatStakeRoi, profitUnits, type RoiSummary } from '../debate/staking.js';

type Db = PrismaClient | Prisma.TransactionClient;

const EPS = 1e-12;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export function actualOutcome(market: DebateMarket, homeScore: number, awayScore: number): string {
  if (market === 'MATCH_RESULT') return homeScore > awayScore ? 'home' : homeScore < awayScore ? 'away' : 'draw';
  if (market === 'OVER_UNDER_25') return homeScore + awayScore > 2.5 ? 'over' : 'under';
  return homeScore > 0 && awayScore > 0 ? 'yes' : 'no';
}

// Multi-outcome Brier: the squared distance between the forecast and the one-hot truth, over the
// outcomes the forecast actually priced.
export function brierOf(probabilities: Record<string, number>, actual: string): number {
  return Object.entries(probabilities).reduce((s, [outcome, p]) => s + (p - (outcome === actual ? 1 : 0)) ** 2, 0);
}

export interface SettlementSummary {
  settled: number;
  skippedNoResult: number;
  skippedNoProbabilities: number;
  alreadySettled: number;
}

export class DebateSettlementService {
  constructor(private readonly db: Db) {}

  async settlePending(options: { dataEnvironment?: DataEnvironment } = {}): Promise<SettlementSummary> {
    const picks = await this.db.debatePick.findMany({
      where: {
        result: { is: null },
        match: { status: 'FINISHED', homeScore: { not: null }, awayScore: { not: null } },
        ...(options.dataEnvironment ? { debateRun: { dataEnvironment: options.dataEnvironment } } : {}),
      },
      include: { match: { select: { homeScore: true, awayScore: true } } },
    });

    const summary: SettlementSummary = { settled: 0, skippedNoResult: 0, skippedNoProbabilities: 0, alreadySettled: 0 };

    for (const pick of picks) {
      const { homeScore, awayScore } = pick.match;
      if (homeScore === null || awayScore === null) {
        summary.skippedNoResult += 1;
        continue;
      }
      const probabilities = pick.probabilities as Record<string, number>;
      const outcomes = Object.keys(probabilities);
      // A NO_PICK whose market could not be derived has no probabilities; there is nothing to score.
      if (outcomes.length === 0) {
        summary.skippedNoProbabilities += 1;
        continue;
      }

      const actual = actualOutcome(pick.market, homeScore, awayScore);
      const pActual = probabilities[actual] ?? 0;
      const leading = outcomes.reduce((best, cur) => (probabilities[cur]! > probabilities[best]! ? cur : best));
      const won = leading === actual;
      const prices = pick.oddsAtPick as Record<string, number> | null;
      // Only a real pick is treated as a bet; a lean or a no-pick returns nothing either way.
      const price = pick.recommendation === 'PICK' && prices ? prices[leading] ?? null : null;

      await this.db.debatePickResult.create({
        data: {
          debatePickId: pick.id,
          actualLabel: actual,
          probabilityOfActual: r4(pActual),
          brier: r4(brierOf(probabilities, actual)),
          logLoss: r4(-Math.log(Math.max(EPS, pActual))),
          wasCorrect: won,
          profitUnits: profitUnits(price, won),
        },
      });
      await this.scoreClaims(pick.debateRunId, pick.market, won);
      summary.settled += 1;
    }
    return summary;
  }

  // Scoring the arguments, not just the pick.
  //
  // A standing objection is credited when the verdict it attacked turned out wrong, and marked wrong when
  // the verdict was right: an objection that talked Nexora out of a correct call cost something. A verdict
  // claim is scored on whether its leading outcome happened. Facts are not scored — they are not claims
  // about the future.
  private async scoreClaims(debateRunId: string, market: DebateMarket, verdictWasRight: boolean): Promise<void> {
    await this.db.debateAgentClaim.updateMany({
      where: { debateRunId, market, agent: 'SKEPTIC', scoredAt: null, severity: { in: ['VETO', 'CONCERN'] } },
      data: { wasCorrect: !verdictWasRight, scoredAt: new Date() },
    });
    await this.db.debateAgentClaim.updateMany({
      where: { debateRunId, market, code: { startsWith: 'VERDICT_' }, scoredAt: null },
      data: { wasCorrect: verdictWasRight, scoredAt: new Date() },
    });
  }

  // The running report: accuracy, calibration by confidence bucket, ROI, and which agent has been right.
  async report(options: { dataEnvironment?: DataEnvironment } = {}) {
    const where: Prisma.DebatePickWhereInput = {
      result: { isNot: null },
      ...(options.dataEnvironment ? { debateRun: { dataEnvironment: options.dataEnvironment } } : {}),
    };
    const picks = await this.db.debatePick.findMany({
      where,
      include: { result: true },
      orderBy: { createdAt: 'asc' },
    });

    const byMarket: Record<string, unknown> = {};
    for (const market of ['MATCH_RESULT', 'OVER_UNDER_25', 'BTTS'] as DebateMarket[]) {
      const rows = picks.filter((p) => p.market === market);
      byMarket[market] = this.scoreBlock(rows);
    }

    const recommended = picks.filter((p) => p.recommendation === 'PICK');
    const roi: RoiSummary = flatStakeRoi(recommended.map((p) => ({ profitUnits: p.result!.profitUnits })));

    const claims = await this.db.debateAgentClaim.groupBy({
      by: ['agent'],
      where: { wasCorrect: { not: null }, ...(options.dataEnvironment ? { debateRun: { dataEnvironment: options.dataEnvironment } } : {}) },
      _count: { _all: true },
    });
    const correct = await this.db.debateAgentClaim.groupBy({
      by: ['agent'],
      where: { wasCorrect: true, ...(options.dataEnvironment ? { debateRun: { dataEnvironment: options.dataEnvironment } } : {}) },
      _count: { _all: true },
    });
    const correctByAgent = new Map(correct.map((c) => [c.agent, c._count._all]));

    return {
      dataEnvironment: options.dataEnvironment ?? 'ALL',
      settledPicks: picks.length,
      overall: this.scoreBlock(picks),
      byMarket,
      byConfidence: this.calibrationBuckets(picks),
      roi,
      agentAccuracy: claims.map((c) => {
        const scored = c._count._all;
        const right = correctByAgent.get(c.agent) ?? 0;
        return {
          agent: c.agent,
          scoredClaims: scored,
          correct: right,
          accuracy: scored === 0 ? null : r4(right / scored),
          trustworthy: scored >= 30,
          note: scored >= 30 ? `${right}/${scored} scored claims were right.` : `Only ${scored} scored claim(s); not yet a measurement.`,
        };
      }),
    };
  }

  private scoreBlock(picks: Array<{ result: { wasCorrect: boolean; brier: number; logLoss: number } | null }>) {
    const rows = picks.filter((p) => p.result !== null);
    const n = rows.length;
    if (n === 0) return { n: 0, accuracy: null, brier: null, logLoss: null, note: 'No settled picks yet.' };
    return {
      n,
      accuracy: r4(rows.filter((p) => p.result!.wasCorrect).length / n),
      brier: r4(rows.reduce((s, p) => s + p.result!.brier, 0) / n),
      logLoss: r4(rows.reduce((s, p) => s + p.result!.logLoss, 0) / n),
      note: n >= 100 ? `${n} settled picks.` : `Only ${n} settled picks: treat these figures as provisional.`,
    };
  }

  private calibrationBuckets(picks: Array<{ confidence: string; probabilities: Prisma.JsonValue; result: { wasCorrect: boolean } | null }>) {
    return (['LOW', 'MEDIUM', 'HIGH'] as const).map((bucket) => {
      const rows = picks.filter((p) => p.confidence === bucket && p.result !== null);
      const n = rows.length;
      if (n === 0) return { bucket, n: 0, predicted: null, observed: null, trustworthy: false, note: 'No settled picks in this bucket.' };
      const predicted = rows.reduce((s, p) => {
        const values = Object.values(p.probabilities as Record<string, number>);
        return s + (values.length === 0 ? 0 : Math.max(...values));
      }, 0) / n;
      const observed = rows.filter((p) => p.result!.wasCorrect).length / n;
      return {
        bucket,
        n,
        predicted: r4(predicted),
        observed: r4(observed),
        trustworthy: n >= 30,
        note: n >= 30 ? `Predicted ${(predicted * 100).toFixed(1)}%, observed ${(observed * 100).toFixed(1)}%.` : `Only ${n} settled pick(s); the hit rate is not yet a measurement.`,
      };
    });
  }
}
