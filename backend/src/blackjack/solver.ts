// Exact blackjack solver.
//
// The dealer's outcome distribution is enumerated without replacement from the cards actually
// remaining. The player's own draws are taken from the composition fixed at the moment of the
// decision, which keeps (total, soft) a sound memo key; that simplification is worth about 0.01%.
// Both are stated on the API response so a caller never has to guess what was approximated.

import { countCards, type Action, type ActionValue, type Composition, type Decision, type Rules } from './types.js';

const softValue = (rank: number): number => (rank === 0 ? 11 : rank === 9 ? 10 : rank + 1);

// Adding a card to (total, soft). An ace enters as 11 and drops to 1 if that would bust; once a
// hand goes hard it can never go soft again, because the drop only happens above a total of 11.
export function addCard(total: number, soft: boolean, rank: number): [number, boolean] {
  let t = total + softValue(rank);
  let s = soft;
  if (rank === 0) {
    if (t > 21) t -= 10;
    else s = true;
  } else if (t > 21 && s) {
    t -= 10;
    s = false;
  }
  return [t, s];
}

export function handTotal(hand: readonly number[]): [number, boolean] {
  let t = 0;
  let s = false;
  for (const r of hand) [t, s] = addCard(t, s, r);
  return [t, s];
}

// Branches below this probability contribute less than rounding noise and are dropped.
const PRUNE = 1e-11;

function playDealer(total: number, soft: boolean, c: Composition, p: number, out: Float64Array, rules: Rules): void {
  if (p < PRUNE) return;
  if (total > 21) {
    out[5] += p;
    return;
  }
  const mustHit = total < 17 || (total === 17 && soft && rules.hitSoft17);
  if (!mustHit) {
    out[total - 17] += p;
    return;
  }
  const n = countCards(c);
  if (n <= 0) {
    if (total >= 17) out[total - 17] += p;
    else out[5] += p;
    return;
  }
  for (let r = 0; r < 10; r += 1) {
    if (c[r] <= 0) continue;
    const pr = (p * c[r]) / n;
    c[r] -= 1;
    const [t2, s2] = addCard(total, soft, r);
    playDealer(t2, s2, c, pr, out, rules);
    c[r] += 1;
  }
}

// Probabilities of the dealer finishing 17, 18, 19, 20, 21 or busting.
export function dealerDistribution(upcard: number, comp: Composition, rules: Rules): Float64Array {
  const c = comp.slice();
  const out = new Float64Array(6);
  // With peek, a natural is already resolved, so the hole card is conditioned on not making one.
  const blocked = (hole: number): boolean => rules.peek && ((upcard === 0 && hole === 9) || (upcard === 9 && hole === 0));
  let allowed = 0;
  for (let h = 0; h < 10; h += 1) if (c[h] > 0 && !blocked(h)) allowed += c[h];
  if (allowed <= 0) return out;
  for (let h = 0; h < 10; h += 1) {
    if (c[h] <= 0 || blocked(h)) continue;
    const p = c[h] / allowed;
    c[h] -= 1;
    let [t, s] = addCard(0, false, upcard);
    [t, s] = addCard(t, s, h);
    playDealer(t, s, c, p, out, rules);
    c[h] += 1;
  }
  return out;
}

export function standEV(total: number, dist: Float64Array): number {
  if (total > 21) return -1;
  let win = dist[5];
  let lose = 0;
  for (let i = 0; i < 5; i += 1) {
    const dealer = 17 + i;
    if (total > dealer) win += dist[i];
    else if (total < dealer) lose += dist[i];
  }
  return win - lose;
}

export type HitMemo = Record<number, number>;

export function hitEV(total: number, soft: boolean, probs: readonly number[], dist: Float64Array, memo: HitMemo): number {
  const key = total * 2 + (soft ? 1 : 0);
  const cached = memo[key];
  if (cached !== undefined) return cached;
  let ev = 0;
  for (let r = 0; r < 10; r += 1) {
    const p = probs[r];
    if (p <= 0) continue;
    const [t2, s2] = addCard(total, soft, r);
    ev += p * (t2 > 21 ? -1 : Math.max(standEV(t2, dist), hitEV(t2, s2, probs, dist, memo)));
  }
  memo[key] = ev;
  return ev;
}

export function doubleEV(total: number, soft: boolean, probs: readonly number[], dist: Float64Array): number {
  let ev = 0;
  for (let r = 0; r < 10; r += 1) {
    const p = probs[r];
    if (p <= 0) continue;
    const [t2] = addCard(total, soft, r);
    ev += p * (t2 > 21 ? -1 : standEV(t2, dist));
  }
  return 2 * ev;
}

// Each split hand is played independently. Resplitting is not modelled, so this is slightly
// pessimistic — real resplitting is worth roughly 0.05% to the player.
export function splitEV(rank: number, probs: readonly number[], dist: Float64Array, rules: Rules, memo: HitMemo): number {
  let ev = 0;
  for (let k = 0; k < 10; k += 1) {
    const p = probs[k];
    if (p <= 0) continue;
    let [t, s] = addCard(0, false, rank);
    [t, s] = addCard(t, s, k);
    let best: number;
    if (rank === 0) {
      best = standEV(t, dist); // split aces take exactly one card each
    } else {
      best = Math.max(standEV(t, dist), hitEV(t, s, probs, dist, memo));
      if (rules.das) best = Math.max(best, doubleEV(t, s, probs, dist));
    }
    ev += p * best;
  }
  return 2 * ev;
}

export const probabilitiesOf = (comp: Composition): number[] => {
  const n = countCards(comp);
  return comp.map((x) => (n > 0 ? x / n : 0));
};

export interface EvaluateOptions {
  // Suppress the split option: used when deriving the hard/soft rows of the chart, so a
  // representative pair never answers a non-pair question.
  noSplit?: boolean;
  afterSplit?: boolean;
}

// Every legal action with its expected value, best first.
export function evaluate(hand: readonly number[], upcard: number, comp: Composition, rules: Rules, options: EvaluateOptions = {}): Decision {
  const dist = dealerDistribution(upcard, comp, rules);
  const probs = probabilitiesOf(comp);
  const memo: HitMemo = {};
  const [total, soft] = handTotal(hand);
  const twoCards = hand.length === 2;

  const actions: ActionValue[] = [
    { action: 'Stand', ev: standEV(total, dist) },
    { action: 'Hit', ev: hitEV(total, soft, probs, dist, memo) },
  ];
  const canDouble = twoCards && (rules.doubleAnyTwo || (total >= 9 && total <= 11 && !soft)) && (!options.afterSplit || rules.das);
  if (canDouble) actions.push({ action: 'Double', ev: doubleEV(total, soft, probs, dist) });
  if (twoCards && hand[0] === hand[1] && !options.afterSplit && !options.noSplit) {
    actions.push({ action: 'Split', ev: splitEV(hand[0], probs, dist, rules, memo) });
  }
  if (twoCards && !options.afterSplit && rules.surrender) actions.push({ action: 'Surrender', ev: -0.5 });

  actions.sort((a, b) => b.ev - a.ev);
  return {
    actions,
    best: actions[0],
    margin: actions.length > 1 ? actions[0].ev - actions[1].ev : Number.POSITIVE_INFINITY,
    total,
    soft,
    dealerDistribution: Array.from(dist),
    unseenCards: countCards(comp),
  };
}

export const ACTION_CODE: Record<Action, string> = { Hit: 'H', Stand: 'S', Double: 'D', Split: 'P', Surrender: 'R' };
