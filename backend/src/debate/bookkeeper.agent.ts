// BOOKKEEPER — scores and sizes. It is the last word: it compares the proposed pick with how picks at this
// confidence have actually settled, and it refuses to suggest a stake when the history is too thin to mean
// anything. It never argues about the football.

import type { BookkeeperInput, CalibrationCheck, IBookkeeper } from './types.js';
import { STAKING, suggestStake } from './staking.js';

export class Bookkeeper implements IBookkeeper {
  readonly id = 'BOOKKEEPER' as const;

  check(input: BookkeeperInput): { stake: ReturnType<typeof suggestStake>; calibration: CalibrationCheck } {
    const calibration = this.annotate(input.history);

    // The leading outcome is what a stake would back, and its price is what Kelly needs.
    const entries = Object.entries(input.probabilities);
    const leading = entries.length === 0 ? null : entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
    const probability = leading ? leading[1] : null;
    const price = leading && input.prices ? input.prices[leading[0]] ?? null : null;
    const baseline = leading && input.baseline ? input.baseline[leading[0]] ?? null : null;
    const edge = probability !== null && baseline !== null ? probability - baseline : null;

    const stake = suggestStake({
      probability,
      decimalOdds: price,
      edge,
      calibrationSamples: calibration.sampleSize,
      recommendation: input.recommendation,
    });

    return { stake, calibration };
  }

  private annotate(history: CalibrationCheck): CalibrationCheck {
    if (history.sampleSize < STAKING.minCalibrationSamples) {
      return {
        ...history,
        trustworthy: false,
        note: `${history.sampleSize} settled pick(s) at ${history.bucket} confidence — below the ${STAKING.minCalibrationSamples} needed before a hit rate means anything.`,
      };
    }
    if (history.observed === null || history.expected === null) {
      return { ...history, trustworthy: false, note: `No settled probability history at ${history.bucket} confidence.` };
    }
    const drift = history.observed - history.expected;
    return {
      ...history,
      trustworthy: true,
      note:
        Math.abs(drift) < 0.05
          ? `Calibrated at ${history.bucket}: predicted ${(history.expected * 100).toFixed(1)}%, observed ${(history.observed * 100).toFixed(1)}% over ${history.sampleSize} picks.`
          : `${drift > 0 ? 'Under' : 'Over'}confident at ${history.bucket}: predicted ${(history.expected * 100).toFixed(1)}%, observed ${(history.observed * 100).toFixed(1)}% over ${history.sampleSize} picks.`,
    };
  }
}
