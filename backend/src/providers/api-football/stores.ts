// Storage contracts for provider clients. Persistent (PostgreSQL) implementations live in data/fetch/provider-stores.ts,
// keeping providers free of Prisma; the in-memory versions here serve tests and dry-runs.

export interface CachedResponse {
  body: string;
  fetchedAt: Date;
}

// Keys are credential-free request URLs (the API key travels only in a header).
export interface ResponseCache {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, source: string, response: CachedResponse): Promise<void>;
}

export class MemoryResponseCache implements ResponseCache {
  readonly entries = new Map<string, CachedResponse>();

  async get(key: string): Promise<CachedResponse | null> {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, _source: string, response: CachedResponse): Promise<void> {
    this.entries.set(key, response);
  }
}

export interface UsageSnapshot {
  requests: number;
  remaining: number | null;
  dailyLimit: number | null;
}

export interface UsageDelta {
  requests?: number;
  errors?: number;
  rateLimited?: number;
  cacheHits?: number;
  cacheMisses?: number;
  remaining?: number | null;
  dailyLimit?: number | null;
  lastRequestAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string;
}

export interface UsageStore {
  today(source: string, day: string): Promise<UsageSnapshot>;
  record(source: string, day: string, delta: UsageDelta): Promise<void>;
}

export class MemoryUsageStore implements UsageStore {
  readonly rows = new Map<string, UsageSnapshot & { errors: number; rateLimited: number; cacheHits: number; cacheMisses: number; lastError: string | null }>();

  // A dry-run starts from the day's real usage so it respects the same budget.
  constructor(private readonly seed?: UsageStore) {}

  private async row(source: string, day: string) {
    const key = `${source}:${day}`;
    if (!this.rows.has(key)) {
      const base = this.seed ? await this.seed.today(source, day) : { requests: 0, remaining: null, dailyLimit: null };
      this.rows.set(key, { ...base, errors: 0, rateLimited: 0, cacheHits: 0, cacheMisses: 0, lastError: null });
    }
    return this.rows.get(key)!;
  }

  async today(source: string, day: string): Promise<UsageSnapshot> {
    const r = await this.row(source, day);
    return { requests: r.requests, remaining: r.remaining, dailyLimit: r.dailyLimit };
  }

  async record(source: string, day: string, delta: UsageDelta): Promise<void> {
    const r = await this.row(source, day);
    r.requests += delta.requests ?? 0;
    r.errors += delta.errors ?? 0;
    r.rateLimited += delta.rateLimited ?? 0;
    r.cacheHits += delta.cacheHits ?? 0;
    r.cacheMisses += delta.cacheMisses ?? 0;
    if (delta.remaining !== undefined && delta.remaining !== null) r.remaining = delta.remaining;
    if (delta.dailyLimit !== undefined && delta.dailyLimit !== null) r.dailyLimit = delta.dailyLimit;
    if (delta.lastError !== undefined) r.lastError = delta.lastError;
  }
}
