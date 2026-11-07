import { describe, expect, it } from 'vitest';
import { ELO, calibrateOutcome, computeElo, dixonColesExpectation, dixonColesResult, eloExpectancy, eloRatingFor, fitDixonColes, tau, type KnownResult } from '../src/analysis/ratings.js';
import { SeededRandom } from '../src/data/synthetic/prng.js';

const DAY = 86_400_000;

function poisson(rng: SeededRandom, lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rng.next();
  while (p > limit) {
    k += 1;
    p *= rng.next();
  }
  return k;
}

// A double round-robin league with known attack/defence strengths, repeated for several seasons.
function simulatedLeague(seasons: number, seed = 7) {
  const rng = new SeededRandom(seed);
  const teams = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, attack: 0.7 + i * 0.07, defence: 1.3 - i * 0.06 }));
  const results: KnownResult[] = [];
  let day = 0;
  for (let s = 0; s < seasons; s += 1) {
    for (const h of teams) {
      for (const a of teams) {
        if (h === a) continue;
        day += 1;
        results.push({ homeTeamId: h.id, awayTeamId: a.id, homeScore: poisson(rng, 1.3 * h.attack * a.defence), awayScore: poisson(rng, a.attack * h.defence), matchDate: new Date(Date.UTC(2020, 0, 1) + day * DAY) });
      }
    }
  }
  return { teams, results, end: new Date(Date.UTC(2020, 0, 1) + (day + 1) * DAY) };
}

describe('Dixon-Coles', () => {
  it('recovers the ordering of true team strengths and a home advantage from simulated results', () => {
    const { teams, results, end } = simulatedLeague(4);
    const fit = fitDixonColes(results, end)!;
    const strength = (id: string) => fit.attack.get(id)! / fit.defence.get(id)!;
    const ranked = [...teams].sort((a, b) => strength(a.id) - strength(b.id)).map((t) => t.id);
    // Adjacent simulated teams differ only slightly, so allow neighbours to swap but not distant teams.
    ranked.forEach((id, i) => expect(Math.abs(Number(id.slice(1)) - i)).toBeLessThanOrEqual(2));
    expect(fit.homeAdvantage).toBeGreaterThan(1.1);
    expect(fit.homeAdvantage).toBeLessThan(1.5);
  });

  it('returns nothing below the minimum sample instead of an unreliable fit', () => {
    expect(fitDixonColes(simulatedLeague(1).results.slice(0, 40), new Date())).toBeNull();
  });

  it('produces valid probabilities and more draws with a negative rho', () => {
    const plain = dixonColesResult(1.2, 1.1, 0);
    const corrected = dixonColesResult(1.2, 1.1, -0.1);
    for (const p of [plain, corrected]) expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
    expect(corrected.draw).toBeGreaterThan(plain.draw);
    expect(tau(2, 3, 1, 1, -0.1)).toBe(1);
  });

  it('gives an unseen (promoted) club the strength of the weakest established sides', () => {
    const { results, end } = simulatedLeague(2);
    const fit = fitDixonColes(results, end)!;
    const vsStrong = dixonColesExpectation(fit, 'promoted', 't9');
    const strongHome = dixonColesExpectation(fit, 't9', 'promoted');
    expect(strongHome.home).toBeGreaterThan(vsStrong.home);
  });
});

describe('Elo', () => {
  it('moves ratings towards the winner by a goal-difference-scaled amount and conserves points', () => {
    const r: KnownResult[] = [{ homeTeamId: 'a', awayTeamId: 'b', homeScore: 3, awayScore: 0, matchDate: new Date(0) }];
    const state = computeElo(r);
    const gain = state.ratings.get('a')! - ELO.initial;
    expect(gain).toBeGreaterThan(0);
    expect(state.ratings.get('a')! + state.ratings.get('b')!).toBeCloseTo(2 * ELO.initial, 9);
    expect(gain).toBeCloseTo(ELO.k * 1.75 * (1 - eloExpectancy(ELO.initial, ELO.initial)), 9);
  });

  it('is unavailable until the ratings have settled', () => {
    const { results } = simulatedLeague(2);
    expect(results.length).toBeGreaterThan(ELO.warmupMatches);
    expect(eloRatingFor(computeElo(results.slice(0, ELO.warmupMatches - 1)), 't0')).toBeNull();
    expect(eloRatingFor(computeElo(results), 't0')).not.toBeNull();
  });

  it('ranks simulated teams by true strength and calibrates outcomes to observed rates', () => {
    const { results } = simulatedLeague(4);
    const state = computeElo(results);
    expect(state.ratings.get('t9')!).toBeGreaterThan(state.ratings.get('t0')!);
    const even = calibrateOutcome(state.history, 0.5)!;
    const lopsided = calibrateOutcome(state.history, 0.85)!;
    for (const p of [even, lopsided]) expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
    expect(lopsided.home).toBeGreaterThan(even.home);
    expect(even.draw).toBeGreaterThan(0.1);
  });
});
