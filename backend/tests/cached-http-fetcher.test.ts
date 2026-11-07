import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { CachedHttpFetcher } from '../src/data/fetch/cached-http-fetcher.js';

const PREFIX = 'https://raw.githubusercontent.com/openfootball/football.json/master/';
const URL_OK = `${PREFIX}2023-24/en.1.json`;

interface Row {
  url: string;
  source: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  body: string;
  fetchedAt: Date;
}

function fakeDb(initial?: Row) {
  const rows = new Map<string, Row>(initial ? [[initial.url, initial]] : []);
  const db = {
    externalSourceCache: {
      findUnique: vi.fn(async ({ where }: { where: { url: string } }) => rows.get(where.url) ?? null),
      upsert: vi.fn(async ({ where, create }: { where: { url: string }; create: Row }) => {
        rows.set(where.url, create);
        return create;
      }),
      update: vi.fn(async ({ where, data }: { where: { url: string }; data: Partial<Row> }) => {
        const row = { ...rows.get(where.url)!, ...data };
        rows.set(where.url, row);
        return row;
      }),
    },
  };
  return { db: db as unknown as PrismaClient, rows, spies: db.externalSourceCache };
}

const cachedRow = (fetchedAt: Date): Row => ({ url: URL_OK, source: 'openfootball', etag: '"abc"', lastModified: null, contentHash: 'h', body: '{"cached":true}', fetchedAt });
const options = (fetchImpl: typeof fetch) => ({ allowedUrlPrefixes: [PREFIX], timeoutMs: 1000, maxBytes: 100, fetchImpl });

describe('CachedHttpFetcher', () => {
  it('refuses URLs outside the allowlist without touching the network', async () => {
    const fetchImpl = vi.fn();
    const { db } = fakeDb();
    const fetcher = new CachedHttpFetcher(db, options(fetchImpl as unknown as typeof fetch));
    await expect(fetcher.fetchText('https://example.com/data.json', { source: 'x', maxAgeMs: 0 })).rejects.toThrow(/non-allowlisted/);
    await expect(fetcher.fetchText(URL_OK.replace('https:', 'http:'), { source: 'x', maxAgeMs: 0 })).rejects.toThrow(/non-allowlisted/);
    await expect(fetcher.fetchText(`${PREFIX}../../other/secret.json`, { source: 'x', maxAgeMs: 0 })).rejects.toThrow(/non-allowlisted/);
    await expect(fetcher.fetchText('not a url', { source: 'x', maxAgeMs: 0 })).rejects.toThrow(/invalid URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never re-downloads a cached historical file', async () => {
    const fetchImpl = vi.fn();
    const { db } = fakeDb(cachedRow(new Date('2020-01-01T00:00:00Z')));
    const result = await new CachedHttpFetcher(db, options(fetchImpl as unknown as typeof fetch)).fetchText(URL_OK, { source: 'openfootball', maxAgeMs: Number.POSITIVE_INFINITY });
    expect(result).toMatchObject({ body: '{"cached":true}', fromCache: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('downloads once on a cache miss and stores a content hash', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"a":1}', { status: 200, headers: { etag: '"v1"' } }));
    const { db, rows } = fakeDb();
    const result = await new CachedHttpFetcher(db, options(fetchImpl as unknown as typeof fetch)).fetchText(URL_OK, { source: 'openfootball', maxAgeMs: Number.POSITIVE_INFINITY });
    expect(result.fromCache).toBe(false);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows.get(URL_OK)).toMatchObject({ body: '{"a":1}', etag: '"v1"', source: 'openfootball' });
    expect(fetchImpl).toHaveBeenCalledWith(URL_OK, expect.objectContaining({ redirect: 'error' }));
  });

  it('revalidates stale entries with the stored ETag and keeps the cached body on 304', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    const { db } = fakeDb(cachedRow(new Date(Date.now() - 10_000)));
    const result = await new CachedHttpFetcher(db, options(fetchImpl as unknown as typeof fetch)).fetchText(URL_OK, { source: 'openfootball', maxAgeMs: 1000 });
    expect(result).toMatchObject({ body: '{"cached":true}', fromCache: true });
    expect(fetchImpl).toHaveBeenCalledWith(URL_OK, expect.objectContaining({ headers: { 'If-None-Match': '"abc"' } }));
  });

  it('rejects failed and oversized responses without caching them', async () => {
    const { db, rows } = fakeDb();
    const failing = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(new CachedHttpFetcher(db, options(failing as unknown as typeof fetch)).fetchText(URL_OK, { source: 'o', maxAgeMs: 0 })).rejects.toThrow(/HTTP 500/);
    const huge = vi.fn(async () => new Response('x'.repeat(500), { status: 200 }));
    await expect(new CachedHttpFetcher(db, options(huge as unknown as typeof fetch)).fetchText(URL_OK, { source: 'o', maxAgeMs: 0 })).rejects.toThrow(/exceeds/);
    expect(rows.size).toBe(0);
  });
});
