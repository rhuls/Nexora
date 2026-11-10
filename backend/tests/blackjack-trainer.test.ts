import { describe, expect, it } from 'vitest';
import {
  cardsForSituation, chooseTarget, deal, dealerPlay, isLive, legalActions,
  remainingComposition, runningCount, settleHand, situationOf, trueCount,
} from '../src/blackjack/trainer.js';
import { handTotal } from '../src/blackjack/solver.js';
import { DEFAULT_RULES, freshShoe, type Rules } from '../src/blackjack/types.js';

const rules: Rules = DEFAULT_RULES;
// Ranks: 0 = ace, 1..8 = two..nine, 9 = any ten-value card.
const seq = (values: number[]): (() => number) => { let i = 0; return () => values[i++ % values.length]; };

describe('situations', () => {
  it('groups a hand the way the decision is actually made', () => {
    expect(situationOf([7, 7], 9).key).toBe('pair:7:9');
    // A pair of eights is a pair, never hard 16: they are different decisions with different answers.
    expect(situationOf([7, 7], 9).kind).toBe('pair');
    expect(situationOf([0, 6], 8).key).toBe('soft:18:8');
    expect(situationOf([9, 5], 9).key).toBe('hard:16:9');
    expect(situationOf([9, 5], 9).label).toBe('hard 16 vs T');
    expect(situationOf([0, 9], 0).label).toBe('soft 21 vs A');
  });

  it('round-trips every situation it can name back into cards that make it', () => {
    for (const upcard of [0, 4, 9]) {
      for (let rank = 0; rank <= 9; rank += 1) {
        const key = `pair:${rank}:${upcard}`;
        const made = cardsForSituation(key)!;
        expect(situationOf(made.player, made.upcard).key).toBe(key);
      }
      for (let total = 13; total <= 21; total += 1) {
        const key = `soft:${total}:${upcard}`;
        const made = cardsForSituation(key)!;
        expect(situationOf(made.player, made.upcard).key).toBe(key);
      }
      for (let total = 5; total <= 20; total += 1) {
        const made = cardsForSituation(`hard:${total}:${upcard}`);
        if (!made) continue;
        expect(situationOf(made.player, made.upcard).key).toBe(`hard:${total}:${upcard}`);
      }
    }
  });

  it('refuses a hard total no two unequal cards can make', () => {
    // Hard 4 is only ever a pair of twos, so asking for it as a hard total has no answer.
    expect(cardsForSituation('hard:4:5')).toBeNull();
    expect(cardsForSituation('soft:12:5')).toBeNull();
    expect(cardsForSituation('nonsense')).toBeNull();
  });
});

describe('legal actions', () => {
  it('offers split only on a matching pair, and only once', () => {
    expect(legalActions([7, 7], rules, { fromSplit: false, handCount: 1 })).toContain('Split');
    expect(legalActions([7, 7], rules, { fromSplit: false, handCount: 2 })).not.toContain('Split');
    expect(legalActions([7, 7], rules, { fromSplit: true, handCount: 1 })).not.toContain('Split');
    expect(legalActions([7, 6], rules, { fromSplit: false, handCount: 1 })).not.toContain('Split');
  });

  it('withdraws double and surrender once a third card is out', () => {
    const three = legalActions([3, 3, 2], rules, { fromSplit: false, handCount: 1 });
    expect(three).not.toContain('Double');
    expect(three).not.toContain('Surrender');
    expect(three).toEqual(['Stand', 'Hit']);
  });

  it('honours the table rules rather than assuming them', () => {
    const noDas: Rules = { ...rules, das: false };
    expect(legalActions([4, 4], noDas, { fromSplit: true, handCount: 2 })).not.toContain('Double');
    const withSurrender: Rules = { ...rules, surrender: true };
    expect(legalActions([9, 6], withSurrender, { fromSplit: false, handCount: 1 })).toContain('Surrender');
    const nineToEleven: Rules = { ...rules, doubleAnyTwo: false };
    expect(legalActions([4, 4], nineToEleven, { fromSplit: false, handCount: 1 })).toContain('Double');
    expect(legalActions([1, 2], nineToEleven, { fromSplit: false, handCount: 1 })).not.toContain('Double');
  });

  it('leaves nothing to do on 21 or a bust', () => {
    expect(legalActions([9, 0], rules, { fromSplit: false, handCount: 1 })).toEqual([]);
    expect(legalActions([9, 8, 9], rules, { fromSplit: false, handCount: 1 })).toEqual([]);
  });
});

describe('the dealer', () => {
  it('stands on hard 17 and draws below it', () => {
    expect(handTotal(dealerPlay([9, 6], seq([0]), rules))[0]).toBe(17);
    expect(handTotal(dealerPlay([9, 5], seq([0]), rules))[0]).toBe(17);
  });

  it('plays soft 17 the way the table says, and no other way', () => {
    // A,6 then a two: standing leaves 17, hitting leaves 19.
    expect(handTotal(dealerPlay([0, 5], seq([1]), { ...rules, hitSoft17: false }))[0]).toBe(17);
    expect(handTotal(dealerPlay([0, 5], seq([1]), { ...rules, hitSoft17: true }))[0]).toBe(19);
  });

  it('stops once it busts instead of drawing for ever', () => {
    const final = dealerPlay([9, 5], seq([9, 9, 9]), rules);
    expect(handTotal(final)[0]).toBeGreaterThan(21);
    expect(final).toHaveLength(3);
  });
});

describe('settlement', () => {
  const bj = [0, 9];
  it('pays a natural at the table rate, and only on the first two cards', () => {
    expect(settleHand(bj, [9, 8], 1, false, rules).net).toBe(rules.blackjackPays);
    // The same 21 built from three cards is just 21.
    expect(settleHand([9, 5, 4], [9, 8], 1, false, rules)).toEqual({ outcome: 'win', net: 1 });
  });

  it('pushes two naturals and loses to the dealer’s', () => {
    expect(settleHand(bj, bj, 1, false, rules)).toEqual({ outcome: 'push', net: 0 });
    expect(settleHand([9, 8], bj, 1, false, rules)).toEqual({ outcome: 'lose', net: -1 });
  });

  it('loses a bust before looking at the dealer at all', () => {
    // The dealer also busted; the player still loses, because they busted first.
    expect(settleHand([9, 8, 9], [9, 6, 9], 1, false, rules)).toEqual({ outcome: 'lose', net: -1 });
  });

  it('returns half the bet on a surrender whatever the dealer holds', () => {
    expect(settleHand([9, 6], bj, 1, true, rules)).toEqual({ outcome: 'surrender', net: -0.5 });
  });

  it('settles a doubled hand for twice the stake', () => {
    expect(settleHand([4, 4, 9], [9, 8], 2, false, rules)).toEqual({ outcome: 'win', net: 2 });
    expect(settleHand([4, 4, 1], [9, 8], 2, false, rules)).toEqual({ outcome: 'lose', net: -2 });
  });

  it('knows which hands the dealer still has to beat', () => {
    expect(isLive([9, 5], false)).toBe(true);
    expect(isLive([9, 8, 9], false)).toBe(false);
    expect(isLive([9, 5], true)).toBe(false);
  });
});

describe('drilling what the player gets wrong', () => {
  it('deals the weak spot when the roll says to drill', () => {
    const comp = freshShoe(rules.decks);
    const weak = [{ key: 'hard:16:9', evLost: 5 }];
    // First roll picks "drill", second selects within the weighted list.
    const target = chooseTarget(weak, seq([0.1, 0.1]), 0.5);
    expect(target).toBe('hard:16:9');
    const dealt = deal(comp, seq([0.5]), target);
    expect(dealt.situation.key).toBe('hard:16:9');
    expect(dealt.drilled).toBe(true);
  });

  it('deals freely when the roll says not to drill, so practice still resembles the game', () => {
    expect(chooseTarget([{ key: 'hard:16:9', evLost: 5 }], seq([0.9]), 0.5)).toBeNull();
    expect(chooseTarget([], seq([0.0]), 1)).toBeNull();
    // A situation recorded but never actually misplayed is not a weakness.
    expect(chooseTarget([{ key: 'hard:16:9', evLost: 0 }], seq([0.0]), 1)).toBeNull();
  });

  it('favours the mistakes that cost the most', () => {
    const weak = [{ key: 'cheap', evLost: 1 }, { key: 'expensive', evLost: 99 }];
    const picks = Array.from({ length: 100 }, (_, i) => chooseTarget(weak, seq([0, (i + 0.5) / 100]), 1));
    const expensive = picks.filter((p) => p === 'expensive').length;
    expect(expensive).toBeGreaterThan(90);
  });

  it('never invents a card the shoe has already spent', () => {
    const comp = freshShoe(1);
    // Take every ten-value card out, then ask for a hand that needs one.
    comp[9] = 0;
    const dealt = deal(comp, seq([0.5]), 'pair:9:4');
    expect(dealt.drilled).toBe(false);
    expect(dealt.player).not.toContain(9);
    expect(dealt.upcard).not.toBe(9);
  });

  it('removes exactly the cards it dealt from the shoe', () => {
    const comp = freshShoe(rules.decks);
    const before = comp.reduce((a, b) => a + b, 0);
    const dealt = deal(comp, seq([0.3, 0.7, 0.1, 0.9]), 'hard:16:9');
    expect(comp.reduce((a, b) => a + b, 0)).toBe(before - 4);
    for (const rank of [...dealt.player, dealt.upcard, dealt.hole]) expect(rank).toBeGreaterThanOrEqual(0);
  });
});

describe('the count the player has to keep by hand', () => {
  it('moves one per card in Hi-Lo terms', () => {
    expect(runningCount([1, 2, 3, 4, 5])).toBe(5);
    expect(runningCount([0, 9, 9])).toBe(-3);
    expect(runningCount([6, 7, 8])).toBe(0);
  });

  it('divides by the decks that are left, not the decks there were', () => {
    const sixDecks = 6;
    const seen = Array.from({ length: 104 }, (_, i) => (i < 52 ? 1 : 6)); // +52 over two decks
    expect(runningCount(seen)).toBe(52);
    expect(trueCount(seen, sixDecks)).toBeCloseTo(52 / 4, 6);
  });

  it('stops reporting a count once the shoe is nearly gone', () => {
    const seen = Array.from({ length: 52 - 10 }, () => 1);
    expect(trueCount(seen, 1)).toBe(0);
  });
});

describe('composition', () => {
  it('removes seen cards and never goes below zero', () => {
    const comp = remainingComposition({ ...rules, decks: 1 }, [9, 9, 9, 9, 9, 9]);
    expect(comp[9]).toBe(10);
    expect(comp.every((c) => c >= 0)).toBe(true);
  });
});
