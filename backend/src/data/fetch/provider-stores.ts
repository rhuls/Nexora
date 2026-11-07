import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { type CachedResponse, MemoryResponseCache, type ResponseCache, type UsageDelta, type UsageSnapshot, type UsageStore } from '../../providers/api-football/stores.js';

type Db = PrismaClient | Prisma.TransactionClient;

// PostgreSQL-backed response cache (ExternalSourceCache) and request accounting (ProviderUsage) for provider clients.

export class PrismaResponseCache implements ResponseCache {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<CachedResponse | null> {
    const row = await this.db.externalSourceCache.findUnique({ where: { url: key }, select: { body: true, fetchedAt: true } });
    return row ?? null;
  }

  async set(key: string, source: string, response: CachedResponse): Promise<void> {
    const record = { source, etag: null, lastModified: null, contentHash: createHash('sha256').update(response.body).digest('hex'), body: response.body, fetchedAt: response.fetchedAt };
    await this.db.externalSourceCache.upsert({ where: { url: key }, create: { url: key, ...record }, update: record });
  }
}

// Dry-run: reads what PostgreSQL already holds, but anything fetched stays in memory.
export class ReadOnlyResponseCache implements ResponseCache {
  private readonly memory = new MemoryResponseCache();
  private readonly persistent: PrismaResponseCache;

  constructor(db: Db) {
    this.persistent = new PrismaResponseCache(db);
  }

  async get(key: string): Promise<CachedResponse | null> {
    return (await this.memory.get(key)) ?? (await this.persistent.get(key));
  }

  async set(key: string, source: string, response: CachedResponse): Promise<void> {
    await this.memory.set(key, source, response);
  }
}

const settable = (delta: UsageDelta) => ({
  ...(delta.remaining !== undefined && delta.remaining !== null ? { remaining: delta.remaining } : {}),
  ...(delta.dailyLimit !== undefined && delta.dailyLimit !== null ? { dailyLimit: delta.dailyLimit } : {}),
  ...(delta.lastRequestAt ? { lastRequestAt: delta.lastRequestAt } : {}),
  ...(delta.lastSuccessAt ? { lastSuccessAt: delta.lastSuccessAt } : {}),
  ...(delta.lastError !== undefined ? { lastError: delta.lastError } : {}),
});

export class PrismaUsageStore implements UsageStore {
  constructor(private readonly db: Db) {}

  async today(source: string, day: string): Promise<UsageSnapshot> {
    const row = await this.db.providerUsage.findUnique({ where: { source_day: { source, day } } });
    return { requests: row?.requests ?? 0, remaining: row?.remaining ?? null, dailyLimit: row?.dailyLimit ?? null };
  }

  async record(source: string, day: string, delta: UsageDelta): Promise<void> {
    await this.db.providerUsage.upsert({
      where: { source_day: { source, day } },
      create: {
        source,
        day,
        requests: delta.requests ?? 0,
        errors: delta.errors ?? 0,
        rateLimited: delta.rateLimited ?? 0,
        cacheHits: delta.cacheHits ?? 0,
        cacheMisses: delta.cacheMisses ?? 0,
        ...settable(delta),
      },
      update: {
        requests: { increment: delta.requests ?? 0 },
        errors: { increment: delta.errors ?? 0 },
        rateLimited: { increment: delta.rateLimited ?? 0 },
        cacheHits: { increment: delta.cacheHits ?? 0 },
        cacheMisses: { increment: delta.cacheMisses ?? 0 },
        ...settable(delta),
      },
    });
  }
}
