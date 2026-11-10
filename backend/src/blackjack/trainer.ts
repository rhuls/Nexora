// Drilling the player, not the solver.
//
// The solver in this folder is exact: it enumerates the dealer's outcomes from the cards actually
// left and picks the highest-value action. There is nothing in basic strategy for a model to
// learn, and outcome feedback cannot improve on an exact answer — a hand is won or lost mostly by
// the shoe, so win/loss says almost nothing about whether the decision was right.
//
// What is genuinely unknown, and therefore worth learning, is which situations a particular person
// misplays. That is what this module tracks and what it deals toward.

import { handTotal } from './solver.js';
import { freshShoe, type Action, type Composition, type Rules } from './types.js';

export type SituationKind = 'hard' | 'soft' | 'pair';

export interface Situation {
  kind: SituationKind;
  /** For a pair this is the rank of one card; otherwise the hand total. */
  value: number;
  upcard: number;
  key: string;
  label: string;
}

const RANK_LABEL = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'];
export const rankLabel = (rank: number): string => RANK_LABEL[rank] ?? String(rank);

/**
 * The situation a two-card hand presents. Hands are grouped the way strategy is decided — a pair of
 * eights is "pair of 8s", never "hard 16" — so that a recorded mistake maps to one decision to fix.
 */
export function situationOf(hand: readonly number[], upcard: number): Situation {
  const [total, soft] = handTotal(hand);
  if (hand.length === 2 && hand[0] === hand[1]) {
    const rank = hand[0];
    return { kind: 'pair', value: rank, upcard, key: `pair:${rank}:${upcard}`, label: `pair of ${rankLabel(rank)}s vs ${rankLabel(upcard)}` };
  }
  const kind: SituationKind = soft ? 'soft' : 'hard';
  return { kind, value: total, upcard, key: `${kind}:${total}:${upcard}`, label: `${kind} ${total} vs ${rankLabel(upcard)}` };
}

export interface HandContext {
  fromSplit: boolean;
  /** How many hands the player is already holding, so a split cannot make a third. */
  handCount: number;
}

/** Only the actions a table would actually let this hand take. */
export function legalActions(cards: readonly number[], rules: Rules, ctx: HandContext): Action[] {
  const [total, soft] = handTotal(cards);
  if (total >= 21) return [];
  const out: Action[] = ['Stand', 'Hit'];
  const twoCards = cards.length === 2;
  if (twoCards && (rules.doubleAnyTwo || (!soft && total >= 9 && total <= 11)) && (!ctx.fromSplit || rules.das)) out.push('Double');
  if (twoCards && cards[0] === cards[1] && !ctx.fromSplit && ctx.handCount < 2) out.push('Split');
  if (rules.surrender && twoCards && !ctx.fromSplit) out.push('Surrender');
  return out;
}

export const isNatural = (cards: readonly number[]): boolean => cards.length === 2 && handTotal(cards)[0] === 21;

/** The dealer has no choices: draw to 17, and on soft 17 do whatever the table says. */
export function dealerPlay(cards: readonly number[], draw: () => number, rules: Rules): number[] {
  const out = [...cards];
  let guard = 0;
  for (;;) {
    const [total, soft] = handTotal(out);
    if (total > 21 || guard >= 21) return out;
    if (total > 17 || (total === 17 && !(soft && rules.hitSoft17))) return out;
    out.push(draw());
    guard += 1;
  }
}

/** A hand the dealer still has to beat: not surrendered and not busted. */
export function isLive(cards: readonly number[], surrendered: boolean): boolean {
  return !surrendered && handTotal(cards)[0] <= 21;
}

export type Outcome = 'win' | 'lose' | 'push' | 'surrender';

export interface Settlement {
  outcome: Outcome;
  /** Signed, in units of the original bet. */
  net: number;
}

export function settleHand(
  playerCards: readonly number[],
  dealerCards: readonly number[],
  stake: number,
  surrendered: boolean,
  rules: Rules,
): Settlement {
  if (surrendered) return { outcome: 'surrender', net: -0.5 };
  const player = handTotal(playerCards)[0];
  if (player > 21) return { outcome: 'lose', net: -stake };

  const dealer = handTotal(dealerCards)[0];
  // A natural is only a natural on the opening two cards, never on a split hand's 21.
  const playerNatural = isNatural(playerCards);
  const dealerNatural = isNatural(dealerCards);
  if (playerNatural || dealerNatural) {
    if (playerNatural && dealerNatural) return { outcome: 'push', net: 0 };
    if (playerNatural) return { outcome: 'win', net: rules.blackjackPays };
    return { outcome: 'lose', net: -stake };
  }

  if (dealer > 21 || player > dealer) return { outcome: 'win', net: stake };
  if (player < dealer) return { outcome: 'lose', net: -stake };
  return { outcome: 'push', net: 0 };
}

// ---- Dealing, and dealing toward what the player keeps getting wrong ----

export const remainingComposition = (rules: Rules, seen: readonly number[]): Composition => {
  const comp = freshShoe(rules.decks);
  for (const rank of seen) if (rank >= 0 && rank < 10 && comp[rank] > 0) comp[rank] -= 1;
  return comp;
};

export interface WeakSpot {
  key: string;
  /** Total expected value this person has given away in this situation. */
  evLost: number;
}

/**
 * Picks a situation to deal, favouring expensive mistakes. `bias` is the probability of drilling at
 * all rather than dealing freely: a trainer that only ever served weak spots would stop resembling
 * the game, and the point is to play well at the table, not to pass a quiz.
 */
export function chooseTarget(weak: readonly WeakSpot[], random: () => number, bias: number): string | null {
  const live = weak.filter((w) => w.evLost > 0);
  if (live.length === 0 || random() >= bias) return null;
  const total = live.reduce((sum, w) => sum + w.evLost, 0);
  let roll = random() * total;
  for (const w of live) {
    roll -= w.evLost;
    if (roll <= 0) return w.key;
  }
  return live[live.length - 1].key;
}

/** The two ranks that make a given situation, or null when no two cards can. */
export function cardsForSituation(key: string): { player: [number, number]; upcard: number } | null {
  const [kind, rawValue, rawUpcard] = key.split(':');
  const value = Number(rawValue);
  const upcard = Number(rawUpcard);
  if (!Number.isInteger(value) || !Number.isInteger(upcard) || upcard < 0 || upcard > 9) return null;

  if (kind === 'pair') {
    if (value < 0 || value > 9) return null;
    return { player: [value, value], upcard };
  }
  if (kind === 'soft') {
    // An ace plus one other card. Soft 12 is a pair of aces, which is a pair situation.
    const other = value - 12;
    if (other < 1 || other > 9) return null;
    return { player: [0, other], upcard };
  }
  if (kind === 'hard') {
    // Two different non-ace ranks, since equal ranks would be a pair.
    for (let a = 1; a <= 9; a += 1) {
      const b = value - (a + 1) - 1;
      if (b >= 1 && b <= 9 && b !== a) return { player: [a, b], upcard };
    }
    return null;
  }
  return null;
}

export interface Deal {
  player: number[];
  upcard: number;
  hole: number;
  situation: Situation;
  /** True when the hand was chosen to drill a known weakness rather than dealt freely. */
  drilled: boolean;
}

const drawFrom = (comp: Composition, random: () => number): number => {
  const total = comp.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('The shoe is empty');
  let roll = random() * total;
  for (let rank = 0; rank < 10; rank += 1) {
    roll -= comp[rank];
    if (roll <= 0) {
      comp[rank] -= 1;
      return rank;
    }
  }
  for (let rank = 9; rank >= 0; rank -= 1) {
    if (comp[rank] > 0) {
      comp[rank] -= 1;
      return rank;
    }
  }
  throw new Error('The shoe is empty');
};

const take = (comp: Composition, rank: number): boolean => {
  if (comp[rank] <= 0) return false;
  comp[rank] -= 1;
  return true;
};

/**
 * Deals the next hand from what is left of the shoe. A drill target is honoured only if the shoe
 * can still produce it; otherwise the hand is dealt freely, because inventing cards that are no
 * longer there would corrupt the count the player is being taught to keep.
 */
export function deal(comp: Composition, random: () => number, target: string | null): Deal {
  if (target) {
    const wanted = cardsForSituation(target);
    if (wanted) {
      const trial = comp.slice();
      if (take(trial, wanted.player[0]) && take(trial, wanted.player[1]) && take(trial, wanted.upcard)) {
        const hole = drawFrom(trial, random);
        for (let i = 0; i < comp.length; i += 1) comp[i] = trial[i];
        const player = [...wanted.player];
        return { player, upcard: wanted.upcard, hole, situation: situationOf(player, wanted.upcard), drilled: true };
      }
    }
  }
  const player = [drawFrom(comp, random), drawFrom(comp, random)];
  const upcard = drawFrom(comp, random);
  const hole = drawFrom(comp, random);
  return { player, upcard, hole, situation: situationOf(player, upcard), drilled: false };
}

/**
 * The running count in Hi-Lo terms. The solver never needs this — it works from the actual
 * composition — but a person at a table cannot hold 312 cards in their head, so this is the
 * approximation they have to practise, shown next to the exact answer it stands in for.
 */
export function runningCount(seen: readonly number[]): number {
  let count = 0;
  for (const rank of seen) {
    if (rank === 0 || rank === 9) count -= 1;
    else if (rank >= 1 && rank <= 5) count += 1;
  }
  return count;
}

export function trueCount(seen: readonly number[], decks: number): number {
  const remaining = decks * 52 - seen.length;
  const decksLeft = remaining / 52;
  if (decksLeft <= 0.25) return 0;
  return runningCount(seen) / decksLeft;
}
