// The player's expected value per unit staked under optimal play, enumerated over every
// starting hand and dealer upcard.
//
// The dealer's deck excludes the player's two cards. Leaving them in is cheaper but overstates
// the house edge by about 0.075 points at six decks; simulation puts the figure computed here
// inside its confidence interval and the cheaper one outside.

import { dealerDistribution, doubleEV, handTotal, hitEV, splitEV, standEV, type HitMemo } from './solver.js';
import { countCards, freshShoe, type Composition, type Rules } from './types.js';

export interface EdgeResult {
  playerEV: number;
  houseEdge: number;
  // Where the figure is reliable. Single deck is the weak spot: removing three known cards from
  // 52 disturbs the deck far more than removing them from 312.
  reliability: 'GOOD' | 'INDICATIVE';
  note: string;
}

export function playerEV(comp: Composition, rules: Rules): number {
  const total = countCards(comp);
  let ev = 0;
  for (let upcard = 0; upcard < 10; upcard += 1) {
    if (comp[upcard] <= 0) continue;
    const pUpcard = comp[upcard] / total;
    const afterUpcard = comp.slice();
    afterUpcard[upcard] -= 1;
    const nAfterUpcard = countCards(afterUpcard);
    for (let i = 0; i < 10; i += 1) {
      if (afterUpcard[i] <= 0) continue;
      for (let j = 0; j < 10; j += 1) {
        const available = afterUpcard[j] - (i === j ? 1 : 0);
        if (available <= 0) continue;
        const pHand = (afterUpcard[i] / nAfterUpcard) * (available / (nAfterUpcard - 1));
        const rest = afterUpcard.slice();
        rest[i] -= 1;
        rest[j] -= 1;
        const nRest = countCards(rest);
        const dist = dealerDistribution(upcard, rest, rules);
        const probs = rest.map((x) => x / nRest);
        const memo: HitMemo = {};
        // With peek the dealer's natural is resolved before the player acts.
        const pDealerNatural = upcard === 0 ? rest[9] / nRest : upcard === 9 ? rest[0] / nRest : 0;
        const playerNatural = (i === 0 && j === 9) || (i === 9 && j === 0);
        let handEV: number;
        if (playerNatural) {
          handEV = (1 - pDealerNatural) * rules.blackjackPays;
        } else {
          const [t, s] = handTotal([i, j]);
          const options = [standEV(t, dist), hitEV(t, s, probs, dist, memo)];
          if (rules.doubleAnyTwo || (t >= 9 && t <= 11 && !s)) options.push(doubleEV(t, s, probs, dist));
          if (i === j) options.push(splitEV(i, probs, dist, rules, memo));
          if (rules.surrender) options.push(-0.5);
          handEV = pDealerNatural * -1 + (1 - pDealerNatural) * Math.max(...options);
        }
        ev += pUpcard * pHand * handEV;
      }
    }
  }
  return ev;
}

export function edge(rules: Rules, comp?: Composition): EdgeResult {
  const ev = playerEV(comp ?? freshShoe(rules.decks), rules);
  const good = rules.decks >= 2;
  return {
    playerEV: ev,
    houseEdge: -ev,
    reliability: good ? 'GOOD' : 'INDICATIVE',
    note: good
      ? 'Six-deck figures agree with simulation to within its confidence interval.'
      : 'Single deck: the fixed-composition simplification bites hardest here, and simulation puts the true figure close to break even. Read this as indicative.',
  };
}
