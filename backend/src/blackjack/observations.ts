// Turning a hand into an observation: what the model said beforehand, and what then happened.
//
// The forecast scored here is the dealer's final total, because it is the one prediction the solver
// makes that is settled by the cards alone. Whether the player won is a different question, and a
// worse one to learn from: it mixes the forecast with the decision taken and the stake at risk.

import { SeededRandom } from '../data/synthetic/prng.js';
import { evaluate, handTotal } from './solver.js';
import { buildRankedStrategy, type RankedStrategy } from './strategy.js';
import { dealerPlay, isNatural, settleHand, type Outcome } from './trainer.js';
import { countCards, freshShoe, type Action, type Composition, type Rules } from './types.js';

/** 17, 18, 19, 20, 21, bust — the categories the dealer distribution is over. */
export const DEALER_OUTCOMES = ['17', '18', '19', '20', '21', 'bust'] as const;
export const DEALER_OUTCOME_COUNT = DEALER_OUTCOMES.length;

export function dealerOutcomeIndex(cards: readonly number[]): number {
  const total = handTotal(cards)[0];
  return total > 21 ? 5 : total < 17 ? -1 : total - 17;
}

export type ObservationSource = 'PLAYED' | 'SIMULATED';

export interface Observation {
  modelVersion: string;
  predictedAt: Date;
  rules: Rules;
  playerCards: number[];
  dealerUpcard: number;
  /** The shoe as the forecast saw it: everything not yet face up, including the hole card. */
  remaining: number[];
  unseenCards: number;
  /** The forecast: probability of each entry in DEALER_OUTCOMES. */
  dealerDistribution: number[];
  actionEvs: Array<{ action: Action; ev: number }>;
  bestAction: Action;
  bestActionEv: number;
  dealerFinalCards: number[];
  /** Which entry of DEALER_OUTCOMES actually happened. */
  dealerOutcome: number;
  playerFinalCards: number[];
  playerTotal: number;
  settled: Outcome;
  net: number;
  /**
   * Cards taken out of the shoe between the forecast and the dealer playing it out. The forecast
   * marginalises over a shoe those cards were still in, so a hand where this is above zero scores
   * the model as it is used rather than the distribution as it is defined.
   */
  cardsDrawnAfterForecast: number;
  source: ObservationSource;
  /** Present for a hand someone played: the choices made and what the solver valued them at. */
  decisions?: unknown;
}

class Shoe {
  private comp: Composition;
  constructor(private readonly decks: number, private readonly reshuffleAt: number, private readonly rng: SeededRandom) {
    this.comp = freshShoe(decks);
  }
  get composition(): Composition {
    return this.comp.slice();
  }
  get remaining(): number {
    return countCards(this.comp);
  }
  reshuffleIfLow(): boolean {
    if (this.remaining > this.reshuffleAt) return false;
    this.comp = freshShoe(this.decks);
    return true;
  }
  draw(): number {
    const total = countCards(this.comp);
    if (total <= 0) throw new Error('The shoe is empty');
    let roll = this.rng.next() * total;
    for (let rank = 0; rank < 10; rank += 1) {
      roll -= this.comp[rank];
      if (roll <= 0) {
        this.comp[rank] -= 1;
        return rank;
      }
    }
    for (let rank = 9; rank >= 0; rank -= 1) if (this.comp[rank] > 0) { this.comp[rank] -= 1; return rank; }
    throw new Error('The shoe is empty');
  }
}

export type Policy = 'stand' | 'solver';

export interface SimulateObservationsOptions {
  rounds: number;
  rules: Rules;
  seed?: number;
  penetration?: number;
  /**
   * `stand` takes no cards after the forecast, which measures the dealer distribution itself.
   * `solver` plays the solver's own choice, which measures the forecast as it is actually used and
   * leaves the shoe different from the one the forecast assumed.
   */
  policy?: Policy;
  modelVersion?: string;
  now?: Date;
}

const lookup = (strategy: RankedStrategy, cards: readonly number[], upcard: number): Action[] => {
  const [total, soft] = handTotal(cards);
  if (cards.length === 2 && cards[0] === cards[1]) return strategy.pair[upcard][cards[0]] ?? ['Stand'];
  const table = soft ? strategy.soft : strategy.hard;
  return table[upcard][Math.min(Math.max(total, soft ? 12 : 4), 21)] ?? ['Stand'];
};

/**
 * Deals hands and records what the model said before each one resolved.
 *
 * Hands the peek rule settles before anyone acts are skipped rather than recorded: the dealer
 * distribution is conditioned on the dealer not holding a natural, so a hand where the dealer did
 * hold one is not an instance of the thing being forecast.
 */
export function simulateObservations({
  rounds, rules, seed = 1, penetration = 0.75, policy = 'stand', modelVersion = 'solver-1.0', now = new Date(0),
}: SimulateObservationsOptions): Observation[] {
  const rng = new SeededRandom(seed);
  const shoe = new Shoe(rules.decks, rules.decks * 52 * (1 - penetration), rng);
  const strategy = policy === 'solver' ? buildRankedStrategy(rules) : null;
  const out: Observation[] = [];

  for (let round = 0; round < rounds; round += 1) {
    shoe.reshuffleIfLow();
    if (shoe.remaining < 20) shoe.reshuffleIfLow();
    const player = [shoe.draw(), shoe.draw()];
    const upcard = shoe.draw();

    // The forecast is made here, before the hole card is drawn: the shoe it sees still contains it.
    const remaining = shoe.composition;
    const hole = shoe.draw();

    if (rules.peek && isNatural([upcard, hole])) continue;
    if (isNatural(player)) continue;

    const decision = evaluate(player, upcard, remaining, rules, {});
    const forecast = Array.from(decision.dealerDistribution);

    const before = shoe.remaining;
    const cards = [...player];
    let stake = 1;
    let surrendered = false;
    if (strategy) {
      let guard = 0;
      for (;;) {
        guard += 1;
        if (guard > 20 || handTotal(cards)[0] >= 21) break;
        const [action] = lookup(strategy, cards, upcard).filter((a) => a === 'Hit' || a === 'Stand' || (a === 'Double' && cards.length === 2));
        if (action === 'Double' && cards.length === 2) { stake = 2; cards.push(shoe.draw()); break; }
        if (action !== 'Hit') break;
        cards.push(shoe.draw());
      }
    }

    const dealerFinal = dealerPlay([upcard, hole], () => shoe.draw(), rules);
    const outcomeIndex = dealerOutcomeIndex(dealerFinal);
    const settlement = settleHand(cards, dealerFinal, stake, surrendered, rules);

    out.push({
      modelVersion,
      predictedAt: now,
      rules,
      playerCards: player,
      dealerUpcard: upcard,
      remaining,
      unseenCards: countCards(remaining),
      dealerDistribution: forecast,
      actionEvs: decision.actions.map((a) => ({ action: a.action, ev: a.ev })),
      bestAction: decision.best.action,
      bestActionEv: decision.best.ev,
      dealerFinalCards: dealerFinal,
      dealerOutcome: outcomeIndex,
      playerFinalCards: cards,
      playerTotal: handTotal(cards)[0],
      settled: settlement.outcome,
      net: settlement.net,
      // The dealer's own draws come out of the same shoe the forecast marginalised over, so only
      // the player's draws count as having changed it.
      cardsDrawnAfterForecast: before - shoe.remaining - (dealerFinal.length - 2),
      source: 'SIMULATED',
    });
  }
  return out;
}
