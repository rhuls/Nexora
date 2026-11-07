// Stake sizing and return accounting.
//
// Kelly needs a price. Without recorded odds there is no stake — the functions below return null with a
// reason rather than inventing a number. Every stake is a fraction of the full Kelly bet and is capped, and
// a thin calibration history forces the stake to zero regardless of the edge.

export const STAKING = {
  // Quarter Kelly: full Kelly is optimal only if the probability is exactly right, which it never is.
  fraction: 0.25,
  // Hard ceiling as a percentage of bankroll, applied after the fraction.
  maxStakePct: 2,
  // Below this many settled picks in the confidence bucket, the hit rate is not yet a measurement.
  minCalibrationSamples: 30,
  // Edges thinner than this are inside the model's own noise.
  minEdge: 0.02,
} as const;

export interface KellyInput {
  probability: number;
  decimalOdds: number;
}

// f* = (bp - q) / b, where b is the net price. Negative means no bet, not a bet the other way.
export function kellyFraction({ probability, decimalOdds }: KellyInput): number {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return 0;
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return 0;
  const b = decimalOdds - 1;
  const f = (b * probability - (1 - probability)) / b;
  return Math.max(0, f);
}

export interface StakeInput {
  probability: number | null;
  decimalOdds: number | null;
  edge: number | null;
  calibrationSamples: number;
  recommendation: 'PICK' | 'LEAN' | 'NO_PICK';
}

export interface StakeOutput {
  stakePct: number | null;
  reason: string;
}

export function suggestStake(input: StakeInput): StakeOutput {
  if (input.recommendation === 'NO_PICK') return { stakePct: null, reason: 'No pick: nothing is staked.' };
  if (input.decimalOdds === null || input.probability === null) {
    return { stakePct: null, reason: 'No price was recorded at pick time, so Kelly has nothing to size against.' };
  }
  if (input.recommendation === 'LEAN') return { stakePct: null, reason: 'A lean is an opinion, not a stake.' };
  if (input.edge === null || input.edge < STAKING.minEdge) {
    return { stakePct: null, reason: `Edge ${input.edge === null ? 'unknown' : input.edge.toFixed(3)} is below the ${STAKING.minEdge} minimum.` };
  }
  if (input.calibrationSamples < STAKING.minCalibrationSamples) {
    return {
      stakePct: null,
      reason: `Only ${input.calibrationSamples} settled picks in this confidence bucket (need ${STAKING.minCalibrationSamples}); the hit rate is not yet measurable, so no stake is suggested.`,
    };
  }
  const full = kellyFraction({ probability: input.probability, decimalOdds: input.decimalOdds });
  if (full <= 0) return { stakePct: null, reason: 'Kelly is non-positive at this price: the odds do not pay for the risk.' };
  const pct = Math.min(STAKING.maxStakePct, full * STAKING.fraction * 100);
  return {
    stakePct: Math.round(pct * 100) / 100,
    reason: `${STAKING.fraction} Kelly on a full fraction of ${(full * 100).toFixed(2)}%, capped at ${STAKING.maxStakePct}%.`,
  };
}

// Flat-stake return of one settled pick, in units of one stake. Null when no price was recorded.
export function profitUnits(decimalOdds: number | null, won: boolean): number | null {
  if (decimalOdds === null || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  return won ? decimalOdds - 1 : -1;
}

export interface RoiSummary {
  settled: number;
  priced: number;
  staked: number;
  returned: number;
  roi: number | null;
  significant: boolean;
  note: string;
}

// ROI at flat stakes over picks that carried a price. Unpriced picks are counted and excluded, never
// treated as break-even.
export function flatStakeRoi(results: Array<{ profitUnits: number | null }>): RoiSummary {
  const priced = results.filter((r) => r.profitUnits !== null);
  const settled = results.length;
  if (priced.length === 0) {
    return { settled, priced: 0, staked: 0, returned: 0, roi: null, significant: false, note: 'No settled pick carried a recorded price, so no return can be computed.' };
  }
  const returned = priced.reduce((s, r) => s + r.profitUnits!, 0);
  const roi = returned / priced.length;
  const significant = priced.length >= 100;
  return {
    settled,
    priced: priced.length,
    staked: priced.length,
    returned: Math.round(returned * 1000) / 1000,
    roi: Math.round(roi * 10000) / 10000,
    significant,
    note: significant
      ? `${priced.length} priced picks.`
      : `Only ${priced.length} priced picks: this ROI is not a measurement of edge and should not be projected forward.`,
  };
}
