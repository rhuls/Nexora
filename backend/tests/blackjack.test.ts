import { describe, expect, it } from 'vitest';
import { addCard, dealerDistribution, evaluate, handTotal, probabilitiesOf, standEV } from '../src/blackjack/solver.js';
import { buildChart } from '../src/blackjack/strategy.js';
import { edge, playerEV } from '../src/blackjack/edge.js';
import { simulate } from '../src/blackjack/simulator.js';
import { DEFAULT_RULES, RulesSchema, countCards, freshShoe, type Rules } from '../src/blackjack/types.js';

const RULES: Rules = { ...DEFAULT_RULES };
const C = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, T: 9 } as const;
const without = (decks: number, ...cards: number[]) => {
  const c = freshShoe(decks);
  for (const r of cards) c[r] -= 1;
  return c;
};

describe('hand arithmetic', () => {
  it('counts an ace as 11 until that would bust, then as 1', () => {
    expect(handTotal([C.A, C[6]])).toEqual([17, true]);
    expect(handTotal([C.A, C[6], C[9]])).toEqual([16, false]);
    expect(handTotal([C.T, C[6]])).toEqual([16, false]);
    expect(handTotal([C.A, C[7]])).toEqual([18, true]);
  });

  it('keeps a second ace at 1 and never returns a hard hand to soft', () => {
    expect(handTotal([C.A, C.A])).toEqual([12, true]);
    expect(handTotal([C.A, C.A, C.A])).toEqual([13, true]);
    // soft 20 drawing a 2 becomes hard 12, and can never count 11 again
    const [t, s] = addCard(20, true, C[2]);
    expect([t, s]).toEqual([12, false]);
    expect(addCard(t, s, C.T)).toEqual([22, false]);
  });
});

describe('dealer distribution', () => {
  it('is a probability distribution for every upcard', () => {
    for (let up = 0; up < 10; up += 1) {
      const dist = dealerDistribution(up, without(6, up), RULES);
      const total = Array.from(dist).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 8);
      expect(Array.from(dist).every((p) => p >= 0)).toBe(true);
    }
  });

  it('reproduces published six-deck bust rates', () => {
    const bust = (up: number) => dealerDistribution(up, without(6, up), RULES)[5];
    // A five or six up busts most often; a ten least. Published figures are ~42% and ~23%.
    expect(bust(C[6])).toBeGreaterThan(0.41);
    expect(bust(C[6])).toBeLessThan(0.43);
    expect(bust(C.T)).toBeGreaterThan(0.22);
    expect(bust(C.T)).toBeLessThan(0.24);
    expect(bust(C[5])).toBeGreaterThan(bust(C[9]));
  });

  it('conditions an ace upcard on the dealer not already holding blackjack', () => {
    const withPeek = dealerDistribution(C.A, without(6, C.A), RULES);
    const noPeek = dealerDistribution(C.A, without(6, C.A), { ...RULES, peek: false });
    // Excluding the ten that would make a natural leaves fewer 21s and more busts.
    expect(withPeek[4]).toBeLessThan(noPeek[4]);
    expect(withPeek[5]).toBeGreaterThan(noPeek[5]);
  });

  it('makes the dealer hit soft 17 only when the rule says so', () => {
    const stands = dealerDistribution(C[6], without(6, C[6]), { ...RULES, hitSoft17: false });
    const hits = dealerDistribution(C[6], without(6, C[6]), { ...RULES, hitSoft17: true });
    expect(hits[0]).toBeLessThan(stands[0]); // fewer finishes on 17
    expect(hits[5]).toBeGreaterThan(stands[5]); // and more busts
  });
});

// Sixteen decisions every published six-deck chart agrees on. If the solver is subtly wrong,
// the marginal ones here are what expose it.
const LANDMARKS: Array<[string, [number, number], number, string]> = [
  ['hard 16 v 10', [C.T, C[6]], C.T, 'Hit'],
  ['hard 12 v 2', [C.T, C[2]], C[2], 'Hit'],
  ['hard 12 v 4', [C.T, C[2]], C[4], 'Stand'],
  ['hard 13 v 2', [C.T, C[3]], C[2], 'Stand'],
  ['hard 11 v 10', [C[5], C[6]], C.T, 'Double'],
  ['hard 9 v 7', [C[4], C[5]], C[7], 'Hit'],
  ['hard 9 v 3', [C[4], C[5]], C[3], 'Double'],
  ['hard 20 v 6', [C.T, C.T], C[6], 'Stand'],
  ['soft 18 v 10', [C.A, C[7]], C.T, 'Hit'],
  ['soft 18 v 6', [C.A, C[7]], C[6], 'Double'],
  ['soft 13 v 5', [C.A, C[2]], C[5], 'Double'],
  ['8,8 v 10', [C[8], C[8]], C.T, 'Split'],
  ['A,A v 6', [C.A, C.A], C[6], 'Split'],
  ['5,5 v 6', [C[5], C[5]], C[6], 'Double'],
  ['hard 17 v A', [C.T, C[7]], C.A, 'Stand'],
  ['hard 10 v 9', [C[5], C[5]], C[9], 'Double'],
];

describe('decisions against published basic strategy', () => {
  it.each(LANDMARKS)('%s', (_name, hand, upcard, expected) => {
    const comp = without(6, hand[0], hand[1], upcard);
    expect(evaluate(hand, upcard, comp, RULES).best.action).toBe(expected);
  });

  it('reports the known-marginal decisions as marginal', () => {
    // 12 v 4 and soft 13 v 5 are famously close; a solver that called them decisive would be wrong.
    const twelve = evaluate([C.T, C[2]], C[4], without(6, C.T, C[2], C[4]), RULES);
    const soft13 = evaluate([C.A, C[2]], C[5], without(6, C.A, C[2], C[5]), RULES);
    expect(twelve.margin).toBeLessThan(0.01);
    expect(soft13.margin).toBeLessThan(0.01);
    // 20 against a 6 is not close at all.
    expect(evaluate([C.T, C.T], C[6], without(6, C.T, C.T, C[6]), RULES).margin).toBeGreaterThan(0.1);
  });

  it('never offers an illegal action', () => {
    const threeCards = evaluate([C[5], C[4], C[3]], C.T, without(6, C[5], C[4], C[3], C.T), RULES);
    const names = threeCards.actions.map((a) => a.action);
    expect(names).not.toContain('Double');
    expect(names).not.toContain('Split');
    expect(names).not.toContain('Surrender');
    const afterSplit = evaluate([C[8], C[3]], C.T, without(6, C[8], C[3], C.T), RULES, { afterSplit: true });
    expect(afterSplit.actions.map((a) => a.action)).not.toContain('Split');
  });

  it('hits a hard 16 against a ten by a hair, not by a mile', () => {
    const d = evaluate([C.T, C[6]], C.T, without(6, C.T, C[6], C.T), RULES);
    const hit = d.actions.find((a) => a.action === 'Hit')!;
    const stand = d.actions.find((a) => a.action === 'Stand')!;
    expect(hit.ev).toBeGreaterThan(stand.ev);
    expect(hit.ev - stand.ev).toBeLessThan(0.02);
    expect(hit.ev).toBeLessThan(-0.5); // the hand is bad whatever you do
  });
});

describe('derived chart', () => {
  it('fills every cell and never invents an action', () => {
    const chart = buildChart(RULES);
    expect(chart).toHaveLength(34);
    for (const row of chart) {
      expect(row.cells).toHaveLength(10);
      for (const cell of row.cells) expect('HSDPR').toContain(cell.code);
    }
  });

  it('offers Split only on the pair rows', () => {
    for (const row of buildChart(RULES)) {
      if (row.kind === 'pair') continue;
      expect(row.cells.every((c) => c.action !== 'Split')).toBe(true);
    }
  });

  it('stands on every hard total of 17 or more', () => {
    const chart = buildChart(RULES);
    for (const label of ['17', '18', '19', '20']) {
      const row = chart.find((r) => r.kind === 'hard' && r.label === label)!;
      expect(row.cells.every((c) => c.action === 'Stand')).toBe(true);
    }
  });

  it('re-derives when a rule changes rather than returning a fixed table', () => {
    const stand = buildChart({ ...RULES, hitSoft17: false });
    const hit = buildChart({ ...RULES, hitSoft17: true });
    const codes = (chart: ReturnType<typeof buildChart>) => chart.flatMap((r) => r.cells.map((c) => c.code)).join('');
    expect(codes(stand)).not.toBe(codes(hit));
  });
});

describe('house edge', () => {
  it('puts six-deck optimal play a few tenths of a percent behind', () => {
    const ev = playerEV(freshShoe(6), RULES);
    expect(ev).toBeLessThan(0);
    expect(ev).toBeGreaterThan(-0.008);
    expect(ev).toBeLessThan(-0.003);
  });

  it('prices rule changes the way the literature does', () => {
    const base = playerEV(freshShoe(6), RULES);
    const h17 = playerEV(freshShoe(6), { ...RULES, hitSoft17: true });
    const shortPay = playerEV(freshShoe(6), { ...RULES, blackjackPays: 1.2 });
    const noDas = playerEV(freshShoe(6), { ...RULES, das: false });
    expect(base - h17).toBeGreaterThan(0.0018); // published ~0.0022
    expect(base - h17).toBeLessThan(0.0026);
    expect(base - shortPay).toBeGreaterThan(0.012); // published ~0.0139
    expect(base - shortPay).toBeLessThan(0.016);
    expect(base - noDas).toBeGreaterThan(0.0008);
    // Every one of these costs the player, none helps.
    for (const delta of [base - h17, base - shortPay, base - noDas]) expect(delta).toBeGreaterThan(0);
  });

  it('flags single deck as indicative and multi-deck as good', () => {
    expect(edge({ ...RULES, decks: 1 }).reliability).toBe('INDICATIVE');
    expect(edge({ ...RULES, decks: 6 }).reliability).toBe('GOOD');
  });
});

describe('simulation', () => {
  it('is reproducible from its seed', () => {
    const a = simulate({ rounds: 20_000, rules: RULES, seed: 42 });
    const b = simulate({ rounds: 20_000, rules: RULES, seed: 42 });
    const c = simulate({ rounds: 20_000, rules: RULES, seed: 43 });
    expect(a.net).toBe(b.net);
    expect(a.winRate).toBe(b.winRate);
    expect(c.net).not.toBe(a.net);
  });

  it('agrees with the enumerated figure, which is the check that matters', () => {
    const run = simulate({ rounds: 300_000, rules: RULES, seed: 7 });
    const computed = playerEV(freshShoe(6), RULES);
    expect(computed).toBeGreaterThanOrEqual(run.interval95[0]);
    expect(computed).toBeLessThanOrEqual(run.interval95[1]);
  });

  it('returns the published outcome split', () => {
    const run = simulate({ rounds: 300_000, rules: RULES, seed: 11 });
    expect(run.winRate).toBeGreaterThan(0.42);
    expect(run.winRate).toBeLessThan(0.45);
    expect(run.pushRate).toBeGreaterThan(0.07);
    expect(run.pushRate).toBeLessThan(0.10);
    expect(run.lossRate).toBeGreaterThan(run.winRate); // losses outnumber wins
    expect(run.winRate + run.lossRate + run.pushRate).toBeCloseTo(1, 10);
    expect(run.standardDeviation).toBeGreaterThan(1.0);
    expect(run.standardDeviation).toBeLessThan(1.3);
  });

  it('produces winning runs close to what independent trials predict', () => {
    const run = simulate({ rounds: 300_000, rules: RULES, seed: 3 });
    for (const s of run.streaks.filter((x) => x.length <= 5)) {
      // Splits put two hands behind one dealer hand, which clusters wins slightly.
      expect(s.ratio).toBeGreaterThan(0.95);
      expect(s.ratio).toBeLessThan(1.15);
    }
  });
});

describe('composition awareness', () => {
  it('changes the answer once the shoe is depleted', () => {
    const rules: Rules = { ...RULES, decks: 1 };
    const fresh = without(1, C.T, C[6], C.T);
    const base = evaluate([C.T, C[6]], C.T, fresh, rules);
    // Strip the small cards that keep a 16 alive; hitting should get worse.
    const stripped = fresh.slice();
    for (const r of [C[2], C[3], C[4], C[5]]) stripped[r] = 0;
    const depleted = evaluate([C.T, C[6]], C.T, stripped, rules);
    const hitOf = (d: typeof base) => d.actions.find((a) => a.action === 'Hit')!.ev;
    expect(hitOf(depleted)).toBeLessThan(hitOf(base));
    expect(depleted.best.action).toBe('Stand');
  });

  it('counts only the cards it has actually been shown', () => {
    const comp = without(6, C.A);
    expect(countCards(comp)).toBe(6 * 52 - 1);
    expect(probabilitiesOf(comp).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe('standing value', () => {
  it('is -1 on a busted hand whatever the dealer holds', () => {
    const dist = dealerDistribution(C[6], without(6, C[6]), RULES);
    expect(standEV(22, dist)).toBe(-1);
    expect(standEV(30, dist)).toBe(-1);
  });

  it('is identical for every stiff total, because only a dealer bust saves any of them', () => {
    const dist = dealerDistribution(C[7], without(6, C[7]), RULES);
    // Standing on 12 and standing on 16 win in exactly the same cases: the dealer busting.
    const stiff = standEV(12, dist);
    for (let t = 4; t <= 16; t += 1) expect(standEV(t, dist)).toBeCloseTo(stiff, 12);
    expect(stiff).toBeCloseTo(dist[5] - (1 - dist[5]), 12);
  });

  it('rises strictly once the total can beat a dealer 17, and never falls', () => {
    const dist = dealerDistribution(C[7], without(6, C[7]), RULES);
    for (let t = 17; t < 21; t += 1) expect(standEV(t + 1, dist)).toBeGreaterThan(standEV(t, dist));
    for (let t = 4; t < 21; t += 1) expect(standEV(t + 1, dist)).toBeGreaterThanOrEqual(standEV(t, dist) - 1e-12);
  });
});

describe('rules parsing', () => {
  it('reads a flag that arrives as the string "false" as false', () => {
    // Boolean('false') is true, so a coercing parser would silently invert every rule sent
    // on a query string. These are the exact values Fastify hands the route.
    const fromQuery = RulesSchema.parse({ decks: '6', hitSoft17: 'false', das: 'false', doubleAnyTwo: 'true', blackjackPays: '1.5' });
    expect(fromQuery.hitSoft17).toBe(false);
    expect(fromQuery.das).toBe(false);
    expect(fromQuery.doubleAnyTwo).toBe(true);
    expect(fromQuery.decks).toBe(6);
  });

  it('still accepts real booleans from a JSON body, and fills its own defaults', () => {
    expect(RulesSchema.parse({ hitSoft17: true }).hitSoft17).toBe(true);
    expect(RulesSchema.parse({})).toEqual(DEFAULT_RULES);
  });

  it('rejects a deck count the solver cannot honour', () => {
    expect(RulesSchema.safeParse({ decks: 0 }).success).toBe(false);
    expect(RulesSchema.safeParse({ decks: 99 }).success).toBe(false);
  });
});
