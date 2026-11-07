// Removing the bookmaker margin from decimal odds. Pure arithmetic over prices supplied by the caller:
// nothing here fetches, and an implausible price is rejected rather than silently normalised.

export type Prices = Record<string, number>;
export type Implied = Record<string, number>;

export type DevigMethod = 'multiplicative' | 'shin';

export interface DevigResult {
  probabilities: Implied;
  overround: number;
  method: DevigMethod;
}

// Decimal odds below 1.01 or above 1000 are treated as corrupt rather than de-vigged into nonsense.
const MIN_ODDS = 1.01;
const MAX_ODDS = 1000;

export function validatePrices(prices: Prices): string | null {
  const entries = Object.entries(prices);
  if (entries.length < 2) return 'A market needs at least two priced outcomes';
  for (const [outcome, price] of entries) {
    if (!Number.isFinite(price)) return `Price for '${outcome}' is not a finite number`;
    if (price < MIN_ODDS || price > MAX_ODDS) return `Price for '${outcome}' (${price}) is outside ${MIN_ODDS}–${MAX_ODDS}`;
  }
  return null;
}

// Sum of inverse odds. 1.0 is a fair book; above 1.0 is the bookmaker's margin.
export function overround(prices: Prices): number {
  return Object.values(prices).reduce((s, p) => s + 1 / p, 0);
}

// Proportional scaling. Simple and stable, but it spreads the margin evenly and so understates
// favourites slightly — the favourite-longshot bias is left in.
export function multiplicative(prices: Prices): DevigResult {
  const book = overround(prices);
  const probabilities = Object.fromEntries(Object.entries(prices).map(([k, p]) => [k, 1 / p / book]));
  return { probabilities, overround: book, method: 'multiplicative' };
}

// Shin (1992): models the margin as insider trading, which removes proportionally more from longshots.
// z is the implied insider fraction, solved by bisection; z = 0 degenerates to multiplicative.
export function shin(prices: Prices, tolerance = 1e-10, maxIterations = 200): DevigResult {
  const book = overround(prices);
  const raw = Object.entries(prices).map(([k, p]) => [k, 1 / p] as const);
  if (book <= 1) return multiplicative(prices);

  // For a given z, Shin's implied probabilities sum to 1 at exactly one z in [0, 1).
  const probsAt = (z: number): Implied =>
    Object.fromEntries(
      raw.map(([k, pi]) => {
        const discriminant = z * z + 4 * (1 - z) * (pi * pi) / book;
        return [k, (Math.sqrt(discriminant) - z) / (2 * (1 - z))];
      }),
    );
  const sumAt = (z: number) => Object.values(probsAt(z)).reduce((s, v) => s + v, 0);

  let lo = 0;
  let hi = 0.99;
  // sum is decreasing in z; if even z=0.99 cannot pull the book down to 1, fall back rather than diverge.
  if (sumAt(hi) > 1) return multiplicative(prices);
  for (let i = 0; i < maxIterations; i += 1) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
    if (hi - lo < tolerance) break;
  }
  const z = (lo + hi) / 2;
  const probabilities = probsAt(z);
  // Renormalise away the last bisection residue so the probabilities sum to exactly 1.
  const total = Object.values(probabilities).reduce((s, v) => s + v, 0);
  return { probabilities: Object.fromEntries(Object.entries(probabilities).map(([k, v]) => [k, v / total])), overround: book, method: 'shin' };
}

export function devig(prices: Prices, method: DevigMethod = 'shin'): DevigResult {
  const problem = validatePrices(prices);
  if (problem) throw new Error(problem);
  return method === 'shin' ? shin(prices) : multiplicative(prices);
}
