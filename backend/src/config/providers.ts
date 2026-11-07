import { OPENFOOTBALL_BASE_URL } from '../providers/openfootball/datasets.js';
import { OpenFootballProvider } from '../providers/openfootball/openfootball.provider.js';
import { MockFootballProvider } from '../providers/mock/mock-football.provider.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { PrismaClient } from '@prisma/client';
import { CachedHttpFetcher } from '../data/fetch/cached-http-fetcher.js';
import { ApiFootballProvider } from '../providers/api-football/api-football.provider.js';
import { ApiFootballClient, type NetworkPolicy } from '../providers/api-football/client.js';
import { MemoryUsageStore } from '../providers/api-football/stores.js';
import { PrismaResponseCache, PrismaUsageStore, ReadOnlyResponseCache } from '../data/fetch/provider-stores.js';
import { type IEnrichmentProvider, type IOddsProvider, isEnrichmentProvider } from '../providers/types.js';
import { API_FOOTBALL_SOURCE, type ApiFootballConfig, loadApiFootballConfig } from './api-football.js';

// dryRun: reads PostgreSQL (cache, today's usage) but never writes to it; detail requests are only planned.
// Invalid API-Football settings disable that provider only; OpenFootball keeps working.
export function createApiFootballProvider(db: PrismaClient, options: { dryRun?: boolean; network?: NetworkPolicy } = {}): ApiFootballProvider {
  let config: ApiFootballConfig;
  try {
    config = loadApiFootballConfig();
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}; API-Football disabled.`);
    config = { ...loadApiFootballConfig({}), key: null };
  }
  const client = options.dryRun
    ? new ApiFootballClient({ config, cache: new ReadOnlyResponseCache(db), usage: new MemoryUsageStore(new PrismaUsageStore(db)), network: options.network ?? 'discovery' })
    : new ApiFootballClient({ config, cache: new PrismaResponseCache(db), usage: new PrismaUsageStore(db), network: options.network ?? 'all' });
  return new ApiFootballProvider(client);
}

export function createProviderRegistry(db: PrismaClient): ProviderRegistry {
  const fetcher = new CachedHttpFetcher(db, {
    allowedUrlPrefixes: [OPENFOOTBALL_BASE_URL],
    timeoutMs: 20_000,
    maxBytes: 5 * 1024 * 1024,
  });
  return new ProviderRegistry([new OpenFootballProvider(fetcher), new MockFootballProvider(), createApiFootballProvider(db)]);
}

export function enrichmentProvider(registry: ProviderRegistry, source: string = API_FOOTBALL_SOURCE): IEnrichmentProvider {
  const provider = registry.get(source);
  if (!isEnrichmentProvider(provider)) throw new Error(`Provider '${source}' does not support enrichment`);
  return provider;
}

// ---- Odds ----
//
// No odds source is wired. Nexora's backbone (OpenFootball) and its enrichment provider (API-Football)
// neither publish prices, so COPYCAT has nothing to de-vig and reports NOT_CONFIGURED, exactly as
// API-Football reports itself when no key is set. Nothing here invents a price.
//
// To activate the market baseline: implement IOddsProvider, return it from this function, and persist its
// quotes as OddsSnapshot rows. The de-vig, edge and Kelly paths behind it are already implemented and
// unit-tested against fixture prices, so wiring a source turns on a tested path rather than a new one.
export function createOddsProvider(_db: PrismaClient): IOddsProvider | null {
  return null;
}
