// Orchestrates the blackjack solver for the API. Stateless by design: it holds no session and
// touches no database, so nothing here can affect a stored football forecast.

import { edge, type EdgeResult } from '../blackjack/edge.js';
import { evaluate } from '../blackjack/solver.js';
import { buildChart, UPCARD_ORDER, type ChartRow } from '../blackjack/strategy.js';
import { simulate, type SimulationResult } from '../blackjack/simulator.js';
import { countCards, freshShoe, type Composition, type Decision, type Rules } from '../blackjack/types.js';

export class BlackjackService {
  // The cards a player cannot see: the shoe, minus everything dealt face up. A caller that
  // supplies `seen` gets a composition-aware answer; one that does not gets the full shoe.
  private remaining(rules: Rules, seen: readonly number[] = []): Composition {
    const comp = freshShoe(rules.decks);
    for (const rank of seen) {
      if (rank >= 0 && rank < 10 && comp[rank] > 0) comp[rank] -= 1;
    }
    return comp;
  }

  evaluateHand(hand: readonly number[], upcard: number, rules: Rules, seen?: readonly number[], afterSplit = false): Decision {
    // The hand and the upcard are themselves seen cards.
    const comp = this.remaining(rules, [...(seen ?? []), ...hand, upcard]);
    if (countCards(comp) <= 0) throw new Error('No cards remain in the shoe for this configuration');
    return evaluate(hand, upcard, comp, rules, { afterSplit });
  }

  chart(rules: Rules): { upcards: readonly number[]; rows: ChartRow[]; cells: number } {
    const rows = buildChart(rules);
    return { upcards: UPCARD_ORDER, rows, cells: rows.length * UPCARD_ORDER.length };
  }

  edge(rules: Rules, seen?: readonly number[]): EdgeResult {
    return edge(rules, seen && seen.length > 0 ? this.remaining(rules, seen) : undefined);
  }

  simulate(rounds: number, rules: Rules, seed: number, penetration: number): SimulationResult & { computedEV: number; agrees: boolean } {
    const result = simulate({ rounds, rules, seed, penetration });
    const computed = edge(rules).playerEV;
    // The check that matters: does the enumerated figure land inside the dealt one's interval?
    const agrees = computed >= result.interval95[0] && computed <= result.interval95[1];
    return { ...result, computedEV: computed, agrees };
  }
}
