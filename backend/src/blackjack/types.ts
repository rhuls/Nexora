// Blackjack decision model. Self-contained: nothing here reads football data, Prisma or the
// analysis pipeline, and nothing in those paths reads this. The only thing shared with the rest
// of Nexora is the discipline — compute exactly, state the approximations, verify against a baseline.

import { z } from 'zod';

// Rank 0 is the ace; 1-8 are 2-9; 9 is every ten-value card (10, J, Q, K).
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'] as const;
export type Rank = number;
export const CARDS_PER_DECK: readonly number[] = [4, 4, 4, 4, 4, 4, 4, 4, 4, 16];

export const ACTIONS = ['Stand', 'Hit', 'Double', 'Split', 'Surrender'] as const;
export type Action = (typeof ACTIONS)[number];

// A flag arrives as a real boolean in a JSON body and as a string in a query. z.coerce.boolean()
// cannot be used for the second: Boolean('false') is true, which would silently invert the rule.
const flag = (fallback: boolean) =>
  z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).default(fallback);

export const RulesSchema = z.object({
  decks: z.coerce.number().int().min(1).max(8).default(6),
  hitSoft17: flag(false),
  doubleAnyTwo: flag(true),
  das: flag(true),
  surrender: flag(false),
  blackjackPays: z.coerce.number().min(1).max(2).default(1.5),
  // US rules: the dealer checks for blackjack before the player acts, so an ace or ten
  // upcard is conditioned on the dealer not already holding one.
  peek: flag(true),
});
export type Rules = z.infer<typeof RulesSchema>;

export const DEFAULT_RULES: Rules = {
  decks: 6, hitSoft17: false, doubleAnyTwo: true, das: true,
  surrender: false, blackjackPays: 1.5, peek: true,
};

// A hand is a list of ranks. Its total is carried as (total, soft) where soft means one ace
// is currently counted as 11.
export const HandSchema = z.array(z.number().int().min(0).max(9)).min(1).max(12);

export interface ActionValue {
  action: Action;
  ev: number;
}

export interface Decision {
  actions: ActionValue[];
  best: ActionValue;
  // Gap between the best action and the next one. A small margin means the choice barely matters.
  margin: number;
  total: number;
  soft: boolean;
  // Dealer outcome probabilities: 17, 18, 19, 20, 21, bust.
  dealerDistribution: number[];
  unseenCards: number;
}

export const DEALER_OUTCOMES = ['17', '18', '19', '20', '21', 'bust'] as const;

export type Composition = number[];

export function freshShoe(decks: number): Composition {
  return CARDS_PER_DECK.map((n) => n * decks);
}

export function countCards(comp: Composition): number {
  let total = 0;
  for (let i = 0; i < 10; i += 1) total += comp[i];
  return total;
}
