// Derives the strategy chart from the solver rather than storing one. Every cell is the action
// with the highest expected value for a full shoe under the given rules, so changing a rule
// re-derives the chart instead of invalidating it.

import { evaluate, ACTION_CODE } from './solver.js';
import { freshShoe, RANKS, type Action, type Rules } from './types.js';

export type ChartKind = 'hard' | 'soft' | 'pair';

export interface ChartRow {
  kind: ChartKind;
  label: string;
  // The two cards used to pose the question. For hard rows, never a pair.
  hand: [number, number];
  cells: Array<{ upcard: number; action: Action; code: string; ev: number; margin: number }>;
}

// Dealer upcards in chart order: 2-10 then ace.
export const UPCARD_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

// Two non-ace ranks summing to a total, so a hard row is never also a pair decision.
function twoNonAce(total: number): [number, number] | null {
  const value = (r: number): number => (r === 9 ? 10 : r + 1);
  for (let i = 1; i < 10; i += 1) {
    for (let j = i; j < 10; j += 1) {
      if (value(i) + value(j) === total) return [i, j];
    }
  }
  return null;
}

export function chartRows(): Array<{ kind: ChartKind; label: string; hand: [number, number] }> {
  const rows: Array<{ kind: ChartKind; label: string; hand: [number, number] }> = [];
  for (let total = 20; total >= 5; total -= 1) {
    const hand = twoNonAce(total);
    if (hand) rows.push({ kind: 'hard', label: String(total), hand });
  }
  for (let second = 9; second >= 2; second -= 1) {
    rows.push({ kind: 'soft', label: `A,${second}`, hand: [0, second - 1] });
  }
  for (const rank of [0, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    const name = RANKS[rank] === 'T' ? '10' : RANKS[rank];
    rows.push({ kind: 'pair', label: `${name},${name}`, hand: [rank, rank] });
  }
  return rows;
}

export function buildChart(rules: Rules): ChartRow[] {
  const base = freshShoe(rules.decks);
  return chartRows().map((row) => ({
    ...row,
    cells: UPCARD_ORDER.map((upcard) => {
      const comp = base.slice();
      comp[row.hand[0]] -= 1;
      comp[row.hand[1]] -= 1;
      comp[upcard] -= 1;
      const decision = evaluate(row.hand, upcard, comp, rules, { noSplit: row.kind !== 'pair' });
      return {
        upcard,
        action: decision.best.action,
        code: ACTION_CODE[decision.best.action],
        ev: decision.best.ev,
        margin: Number.isFinite(decision.margin) ? decision.margin : 0,
      };
    }),
  }));
}

// Actions ranked by EV for every state, so a player can follow the first LEGAL one. That is what
// "a chart with fallbacks" means: a chart says Double, but a three-card hand cannot double.
export interface RankedStrategy {
  hard: Record<number, Record<number, Action[]>>;
  soft: Record<number, Record<number, Action[]>>;
  pair: Record<number, Record<number, Action[]>>;
}

export function buildRankedStrategy(rules: Rules): RankedStrategy {
  const base = freshShoe(rules.decks);
  const ranked = (hand: [number, number], upcard: number, noSplit: boolean): Action[] => {
    const comp = base.slice();
    comp[hand[0]] -= 1;
    comp[hand[1]] -= 1;
    comp[upcard] -= 1;
    return evaluate(hand, upcard, comp, rules, { noSplit }).actions.map((a) => a.action);
  };
  const out: RankedStrategy = { hard: {}, soft: {}, pair: {} };
  for (let upcard = 0; upcard < 10; upcard += 1) {
    out.hard[upcard] = {};
    out.soft[upcard] = {};
    out.pair[upcard] = {};
    for (let total = 4; total <= 20; total += 1) {
      const hand = twoNonAce(total);
      out.hard[upcard][total] = hand ? ranked(hand, upcard, true) : ['Stand'];
    }
    out.hard[upcard][21] = ['Stand'];
    for (let total = 12; total <= 20; total += 1) {
      const second = total - 11;
      out.soft[upcard][total] = ranked([0, second === 1 ? 0 : second - 1], upcard, true);
    }
    out.soft[upcard][21] = ['Stand'];
    for (let rank = 0; rank < 10; rank += 1) out.pair[upcard][rank] = ranked([rank, rank], upcard, false);
  }
  return out;
}
