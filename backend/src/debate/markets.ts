// Over/under 2.5 and both-teams-to-score, derived from the Dixon-Coles expectation already stored in the
// feature snapshot. These are READ-ONLY derivations for the debate: they are not PredictionTargets, they are
// never written to Prediction, and they take no part in evaluation or learning. The match-result probability
// is NOT recomputed here — the debate uses the ensemble the existing engine already produced.

import { tau } from '../analysis/ratings.js';

const MAX_GOALS = 10;

function poissonPmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) p *= lambda / i;
  return p;
}

export interface DerivedMarkets {
  overUnder25: { over: number; under: number };
  btts: { yes: number; no: number };
  expectedTotal: number;
}

export interface DixonColesInputs {
  lambdaHome: number;
  lambdaAway: number;
  rho: number;
}

// The same score grid the result model uses, so the derived markets are consistent with it rather than
// a second, differently-shaped opinion about the same match.
export function deriveMarkets({ lambdaHome, lambdaAway, rho }: DixonColesInputs): DerivedMarkets {
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway) || lambdaHome <= 0 || lambdaAway <= 0) {
    throw new Error('Dixon-Coles expectations must be finite and positive');
  }
  let over = 0;
  let bttsYes = 0;
  let total = 0;
  let mass = 0;
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const p = Math.max(0, poissonPmf(lambdaHome, h) * poissonPmf(lambdaAway, a) * tau(h, a, lambdaHome, lambdaAway, rho));
      mass += p;
      total += p * (h + a);
      if (h + a > 2.5) over += p;
      if (h > 0 && a > 0) bttsYes += p;
    }
  }
  // The grid truncates at 10 goals a side; renormalising keeps the probabilities summing to 1.
  const o = over / mass;
  const y = bttsYes / mass;
  return { overUnder25: { over: o, under: 1 - o }, btts: { yes: y, no: 1 - y }, expectedTotal: total / mass };
}
