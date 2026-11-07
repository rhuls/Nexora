// COPYCAT — the market baseline. It states what the odds already imply, so any deviation has something
// to justify itself against.
//
// Copycat does not fetch. It is handed the odds that were captured before the cutoff and de-vigs them.
// With no odds it says so; it never substitutes the model's own numbers for the market's, which would
// make every edge zero and the comparison meaningless.

import { devig, validatePrices } from './devig.js';
import type { CopycatInput, ICopycat, MarketBaseline, MarketProbabilities, StoredOdds } from './types.js';

// Prices older than this before kickoff no longer describe the market that will settle the match.
const STALE_AFTER_HOURS = 72;
const HOUR_MS = 3_600_000;

const EMPTY: MarketProbabilities = { MATCH_RESULT: null, OVER_UNDER_25: null, BTTS: null };

const none = (status: MarketBaseline['status'], reason: string): MarketBaseline => ({
  status,
  reason,
  probabilities: { ...EMPTY },
  bookmaker: null,
  capturedAt: null,
  overround: {},
  method: null,
  oddsSnapshotIds: [],
  prices: {},
});

export class Copycat implements ICopycat {
  readonly id = 'COPYCAT' as const;

  baseline({ odds, asOf, providerConfigured }: CopycatInput): MarketBaseline {
    if (!providerConfigured && odds.length === 0) {
      return none('NOT_CONFIGURED', 'No odds provider is configured, so there is no market baseline to compare against.');
    }
    const usable = odds.filter((o) => o.capturedAt.getTime() <= asOf.getTime());
    if (usable.length === 0) {
      return none('NO_ODDS_BEFORE_CUTOFF', `No odds were captured before the cutoff (${asOf.toISOString()}); a price published later cannot inform this forecast.`);
    }

    // Latest capture per market, so a re-priced market supersedes its own earlier quote.
    const latest = new Map<string, StoredOdds>();
    for (const o of usable) {
      const held = latest.get(o.market);
      if (!held || o.capturedAt.getTime() > held.capturedAt.getTime()) latest.set(o.market, o);
    }

    const probabilities: MarketProbabilities = { ...EMPTY };
    const overroundByMarket: Record<string, number> = {};
    const pricesByMarket: Record<string, Record<string, number>> = {};
    const ids: string[] = [];
    const rejected: string[] = [];
    let newest: StoredOdds | null = null;
    let method: string | null = null;

    for (const [market, snapshot] of latest) {
      const problem = validatePrices(snapshot.prices);
      if (problem) {
        rejected.push(`${market}: ${problem}`);
        continue;
      }
      const result = devig(snapshot.prices);
      overroundByMarket[market] = Math.round(result.overround * 10000) / 10000;
      pricesByMarket[market] = snapshot.prices;
      ids.push(snapshot.id);
      method = result.method;
      if (!newest || snapshot.capturedAt.getTime() > newest.capturedAt.getTime()) newest = snapshot;

      const p = result.probabilities;
      if (market === 'MATCH_RESULT' && p.home !== undefined && p.draw !== undefined && p.away !== undefined) {
        probabilities.MATCH_RESULT = { home: p.home, draw: p.draw, away: p.away };
      } else if (market === 'OVER_UNDER_25' && p.over !== undefined && p.under !== undefined) {
        probabilities.OVER_UNDER_25 = { over: p.over, under: p.under };
      } else if (market === 'BTTS' && p.yes !== undefined && p.no !== undefined) {
        probabilities.BTTS = { yes: p.yes, no: p.no };
      } else {
        rejected.push(`${market}: priced outcomes do not match the expected shape`);
      }
    }

    if (ids.length === 0 || newest === null) {
      return none('NO_ODDS_BEFORE_CUTOFF', `Odds existed but none could be used: ${rejected.join('; ')}`);
    }

    const ageHours = (asOf.getTime() - newest.capturedAt.getTime()) / HOUR_MS;
    const stale = ageHours > STALE_AFTER_HOURS;
    const notes = rejected.length > 0 ? ` Rejected: ${rejected.join('; ')}.` : '';

    return {
      status: stale ? 'STALE' : 'AVAILABLE',
      reason: stale
        ? `Newest usable price is ${Math.round(ageHours)}h old (limit ${STALE_AFTER_HOURS}h); treat the baseline as indicative only.${notes}`
        : `De-vigged ${ids.length} market(s) from ${newest.bookmaker}, captured ${newest.capturedAt.toISOString()}.${notes}`,
      probabilities,
      bookmaker: newest.bookmaker,
      capturedAt: newest.capturedAt.toISOString(),
      overround: overroundByMarket,
      method,
      oddsSnapshotIds: ids,
      prices: pricesByMarket,
    };
  }
}
