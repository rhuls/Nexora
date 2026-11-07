import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ApiFootballConfig } from '../../src/config/api-football.js';
import { Secret } from '../../src/config/api-football.js';
import { ApiFootballProvider } from '../../src/providers/api-football/api-football.provider.js';
import { ApiFootballClient, type NetworkPolicy } from '../../src/providers/api-football/client.js';
import { MemoryResponseCache, MemoryUsageStore, type ResponseCache, type UsageStore } from '../../src/providers/api-football/stores.js';

// Deliberately recognisable so tests can prove it never leaks into URLs, errors, logs or the cache.
export const TEST_KEY = 'nexora-test-key-DO-NOT-LEAK-7f3a';

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/api-football/${name}`, import.meta.url)), 'utf8')) as T;
}

export const envelope = (response: unknown[], extra: Record<string, unknown> = {}) => ({ get: 'test', parameters: {}, errors: [], results: response.length, paging: { current: 1, total: 1 }, response, ...extra });

export interface MockReply {
  status?: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  throws?: Error;
}

export interface MockCall {
  url: URL;
  endpoint: string;
  params: Record<string, string>;
  key: string | null;
}

// A deterministic stand-in for https://v3.football.api-sports.io. Handlers are matched by endpoint name.
export class MockApiFootball {
  readonly calls: MockCall[] = [];
  private readonly handlers = new Map<string, (params: Record<string, string>) => MockReply>();

  on(endpoint: string, handler: (params: Record<string, string>) => MockReply): this {
    this.handlers.set(endpoint, handler);
    return this;
  }

  callsTo(endpoint: string): MockCall[] {
    return this.calls.filter((c) => c.endpoint === endpoint);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace(/^\//, '');
    const params = Object.fromEntries(url.searchParams.entries());
    const headers = new Headers(init?.headers);
    this.calls.push({ url, endpoint, params, key: headers.get('x-apisports-key') });
    const handler = this.handlers.get(endpoint);
    const reply = handler ? handler(params) : { status: 404, body: { message: 'not found' } };
    if (reply.throws) throw reply.throws;
    const body = reply.rawBody ?? JSON.stringify(reply.body ?? envelope([]));
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', 'x-ratelimit-requests-limit': '100', 'x-ratelimit-requests-remaining': '80', ...reply.headers },
    });
  };
}

export function testConfig(overrides: Partial<ApiFootballConfig> = {}): ApiFootballConfig {
  return { key: new Secret(TEST_KEY), dailyBudget: 90, reserve: 5, minIntervalMs: 0, timeoutMs: 5_000, batchFixtures: true, ...overrides };
}

export function testProvider(
  api: MockApiFootball,
  options: { config?: Partial<ApiFootballConfig>; cache?: ResponseCache; usage?: UsageStore; network?: NetworkPolicy; now?: () => Date } = {},
) {
  const cache = options.cache ?? new MemoryResponseCache();
  const usage = options.usage ?? new MemoryUsageStore();
  const client = new ApiFootballClient({ config: testConfig(options.config), cache, usage, network: options.network, fetchImpl: api.fetch, now: options.now, sleep: async () => {} });
  return { provider: new ApiFootballProvider(client, options.now), client, cache, usage };
}
