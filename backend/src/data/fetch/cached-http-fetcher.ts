import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { FetchedSource, SourceFetchPolicy, SourceFetcher } from '../../providers/types.js';

export interface CachedHttpFetcherOptions {
  allowedUrlPrefixes: readonly string[];
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}

// Every external download goes through PostgreSQL, so a historical file is fetched once and re-imports are reproducible.
export class CachedHttpFetcher implements SourceFetcher {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly db: PrismaClient,
    private readonly options: CachedHttpFetcherOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchText(url: string, policy: SourceFetchPolicy): Promise<FetchedSource> {
    let normalized: string;
    try {
      normalized = new URL(url).href;
    } catch {
      throw new Error(`Refusing to fetch invalid URL: ${url}`);
    }
    if (normalized !== url || !this.options.allowedUrlPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(`Refusing to fetch non-allowlisted URL: ${url}`);
    }

    const cached = await this.db.externalSourceCache.findUnique({ where: { url } });
    if (cached && Date.now() - cached.fetchedAt.getTime() < policy.maxAgeMs) {
      return { body: cached.body, contentHash: cached.contentHash, fetchedAt: cached.fetchedAt, fromCache: true };
    }

    const headers: Record<string, string> = {};
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    const response = await this.fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs) });

    const now = new Date();
    if (response.status === 304 && cached) {
      await this.db.externalSourceCache.update({ where: { url }, data: { fetchedAt: now } });
      return { body: cached.body, contentHash: cached.contentHash, fetchedAt: now, fromCache: true };
    }
    if (!response.ok) throw new Error(`Fetching ${url} failed with HTTP ${response.status}`);

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > this.options.maxBytes) throw new Error(`Response from ${url} exceeds ${this.options.maxBytes} bytes`);
    const body = await response.text();
    if (Buffer.byteLength(body) > this.options.maxBytes) throw new Error(`Response from ${url} exceeds ${this.options.maxBytes} bytes`);

    const contentHash = createHash('sha256').update(body).digest('hex');
    const record = {
      source: policy.source,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      contentHash,
      body,
      fetchedAt: now,
    };
    await this.db.externalSourceCache.upsert({ where: { url }, create: { url, ...record }, update: record });
    return { body, contentHash, fetchedAt: now, fromCache: false };
  }
}
