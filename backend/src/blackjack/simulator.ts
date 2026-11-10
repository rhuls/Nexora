// Monte Carlo over the chart the solver derives. The point is cross-validation: the solver
// enumerates probabilities and the simulator deals cards, so agreement between them is evidence
// neither is wrong in a way the other shares.
//
// Seeded, because a simulation nobody can reproduce is not evidence. The same seed always
// returns the same figures.

import { SeededRandom } from '../data/synthetic/prng.js';
import { addCard, handTotal } from './solver.js';
import { buildRankedStrategy, type RankedStrategy } from './strategy.js';
import { countCards, freshShoe, type Action, type Composition, type Rules } from './types.js';

export interface SimulationResult {
  rounds: number;
  seed: number;
  net: number;
  evPerRound: number;
  standardDeviation: number;
  standardError: number;
  interval95: [number, number];
  settledHands: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  lossRate: number;
  pushRate: number;
  // Of every winning run that started, the share reaching each length, against what independent
  // trials predict at the measured win rate.
  streaks: Array<{ length: number; observed: number; independent: number; ratio: number }>;
  pWinDecided: number;
}

class Shoe {
  private comp: Composition;
  private readonly reshuffleAt: number;

  constructor(private readonly decks: number, penetration: number, private readonly rng: SeededRandom) {
    this.comp = freshShoe(decks);
    this.reshuffleAt = Math.floor(decks * 52 * (1 - penetration));
  }

  draw(): number {
    if (countCards(this.comp) <= this.reshuffleAt) this.comp = freshShoe(this.decks);
    const rank = this.rng.weightedIndex(this.comp);
    const picked = rank >= 0 ? rank : 9;
    this.comp[picked] -= 1;
    return picked;
  }
}

function lookup(strategy: RankedStrategy, hand: number[], upcard: number): Action[] {
  const [total, soft] = handTotal(hand);
  if (total > 21) return ['Stand'];
  if (hand.length === 2 && hand[0] === hand[1]) {
    const pair = strategy.pair[upcard][hand[0]];
    if (pair) return pair;
  }
  const table = soft ? strategy.soft[upcard] : strategy.hard[upcard];
  return table[Math.min(21, Math.max(4, total))] ?? ['Stand'];
}

interface SimHand {
  cards: number[];
  stake: number;
  done: boolean;
  fromSplit: boolean;
  surrendered: boolean;
}

export interface RoundResult {
  net: number;
  outcomes: Array<'win' | 'lose' | 'push' | 'surrender'>;
  split: boolean;
}

// A split makes exactly two hands and never resplits, matching the solver, so the two stay comparable.
export function playRound(shoe: Shoe, strategy: RankedStrategy, rules: Rules): RoundResult {
  const player = [shoe.draw(), shoe.draw()];
  const dealer = [shoe.draw(), shoe.draw()];
  const upcard = dealer[0];
  const playerNatural = handTotal(player)[0] === 21;
  const dealerNatural = handTotal(dealer)[0] === 21;
  if (playerNatural || dealerNatural) {
    if (playerNatural && dealerNatural) return { net: 0, outcomes: ['push'], split: false };
    if (playerNatural) return { net: rules.blackjackPays, outcomes: ['win'], split: false };
    return { net: -1, outcomes: ['lose'], split: false };
  }

  const hands: SimHand[] = [{ cards: player, stake: 1, done: false, fromSplit: false, surrendered: false }];
  for (let i = 0; i < hands.length; i += 1) {
    const hand = hands[i];
    let guard = 0;
    while (!hand.done && guard < 25) {
      guard += 1;
      let acted = false;
      for (const action of lookup(strategy, hand.cards, upcard)) {
        if (action === 'Split') {
          if (hand.cards.length !== 2 || hand.cards[0] !== hand.cards[1] || hand.fromSplit || hands.length >= 2) continue;
          const rank = hand.cards[0];
          const second: SimHand = { cards: [rank, shoe.draw()], stake: 1, done: false, fromSplit: true, surrendered: false };
          hand.cards = [rank, shoe.draw()];
          hand.fromSplit = true;
          hands.push(second);
          if (rank === 0) {
            hand.done = true;
            second.done = true;
          }
          acted = true;
          break;
        }
        if (action === 'Double') {
          if (hand.cards.length !== 2) continue;
          const [t, s] = handTotal(hand.cards);
          if (!rules.doubleAnyTwo && !(t >= 9 && t <= 11 && !s)) continue;
          if (hand.fromSplit && !rules.das) continue;
          hand.stake = 2;
          hand.cards.push(shoe.draw());
          hand.done = true;
          acted = true;
          break;
        }
        if (action === 'Surrender') {
          if (!rules.surrender || hand.cards.length !== 2 || hand.fromSplit) continue;
          hand.done = true;
          hand.surrendered = true;
          acted = true;
          break;
        }
        if (action === 'Hit') {
          hand.cards.push(shoe.draw());
          if (handTotal(hand.cards)[0] >= 21) hand.done = true;
          acted = true;
          break;
        }
        hand.done = true;
        acted = true;
        break;
      }
      if (!acted) hand.done = true;
    }
  }

  let [dealerTotal, dealerSoft] = handTotal(dealer);
  const anyLive = hands.some((h) => !h.surrendered && handTotal(h.cards)[0] <= 21);
  if (anyLive) {
    let guard = 0;
    while ((dealerTotal < 17 || (dealerTotal === 17 && dealerSoft && rules.hitSoft17)) && guard < 25) {
      guard += 1;
      dealer.push(shoe.draw());
      [dealerTotal, dealerSoft] = handTotal(dealer);
    }
  }

  let net = 0;
  const outcomes: RoundResult['outcomes'] = [];
  for (const hand of hands) {
    if (hand.surrendered) {
      net -= 0.5;
      outcomes.push('surrender');
      continue;
    }
    const total = handTotal(hand.cards)[0];
    if (total > 21) {
      net -= hand.stake;
      outcomes.push('lose');
    } else if (dealerTotal > 21 || total > dealerTotal) {
      net += hand.stake;
      outcomes.push('win');
    } else if (total < dealerTotal) {
      net -= hand.stake;
      outcomes.push('lose');
    } else {
      outcomes.push('push');
    }
  }
  return { net, outcomes, split: hands.length > 1 };
}

export interface SimulateOptions {
  rounds: number;
  rules: Rules;
  seed?: number;
  penetration?: number;
  // Defaults to the solver's own play. Supplying one measures how a different way of playing
  // actually performs, on the same shoe and the same seed, rather than by assertion.
  strategy?: RankedStrategy;
}

export function simulate({ rounds, rules, seed = 1, penetration = 0.75, strategy: supplied }: SimulateOptions): SimulationResult {
  const strategy = supplied ?? buildRankedStrategy(rules);
  const rng = new SeededRandom(seed);
  const shoe = new Shoe(rules.decks, penetration, rng);

  let net = 0;
  let sumSquares = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let settled = 0;
  let run = 0;
  const runs: Record<number, number> = {};

  for (let i = 0; i < rounds; i += 1) {
    const result = playRound(shoe, strategy, rules);
    net += result.net;
    sumSquares += result.net * result.net;
    for (const outcome of result.outcomes) {
      settled += 1;
      if (outcome === 'push') {
        pushes += 1;
        continue; // a push neither extends nor breaks a run
      }
      if (outcome === 'win') {
        wins += 1;
        run = run > 0 ? run + 1 : 1;
      } else {
        losses += 1;
        if (run > 0) runs[run] = (runs[run] ?? 0) + 1;
        run = run < 0 ? run - 1 : -1;
      }
    }
  }

  const mean = net / rounds;
  const variance = Math.max(0, sumSquares / rounds - mean * mean);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(rounds);
  const pWinDecided = wins + losses > 0 ? wins / (wins + losses) : 0;
  const totalRuns = Object.values(runs).reduce((a, b) => a + b, 0);

  const streaks = [2, 3, 4, 5, 6, 8, 10].map((length) => {
    const atLeast = Object.entries(runs)
      .filter(([k]) => Number(k) >= length)
      .reduce((a, [, count]) => a + count, 0);
    const observed = totalRuns > 0 ? atLeast / totalRuns : 0;
    const independent = pWinDecided ** (length - 1);
    return { length, observed, independent, ratio: independent > 0 ? observed / independent : 0 };
  });

  return {
    rounds,
    seed,
    net,
    evPerRound: mean,
    standardDeviation: sd,
    standardError: se,
    interval95: [mean - 1.96 * se, mean + 1.96 * se],
    settledHands: settled,
    wins,
    losses,
    pushes,
    winRate: settled > 0 ? wins / settled : 0,
    lossRate: settled > 0 ? losses / settled : 0,
    pushRate: settled > 0 ? pushes / settled : 0,
    streaks,
    pWinDecided,
  };
}
