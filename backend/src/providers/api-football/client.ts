import { z } from 'zod';
import { API_FOOTBALL_BASE_URL, API_FOOTBALL_SOURCE, type ApiFootballConfig } from '../../config/api-football.js';
import type { RequestStats } from '../types.js';
import type { ResponseCache, UsageStore } from './stores.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 10;

// API-Football answers most failures with HTTP 200 and a non-empty `errors` object, so the envelope is always checked.
const EnvelopeSchema = z.object({
  errors: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
  results: z.number().int().nonnegative().optional(),
  paging: z.object({ current: z.number().int(), total: z.number().int() }).optional(),
  response: z.array(z.unknown()),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export type RequestKind = 'discovery' | 'detail';
// all: normal run · discovery: dry-run that may list fixtures but plans detail requests · none: fully offline.
export type NetworkPolicy = 'all' | 'discovery' | 'none';

export type FailureCode = 'NOT_CONFIGURED' | 'NOT_CACHED' | 'BUDGET' | 'RATE_LIMITED' | 'AUTH' | 'PLAN' | 'API_ERROR' | 'HTTP_ERROR' | 'MALFORMED' | 'NETWORK' | 'STOPPED';

export type ClientResult =
  | { ok: true; envelope: Envelope; fetchedAt: Date; fromCache: boolean }
  | { ok: false; code: FailureCode; message: string };

export interface ClientOptions {
  config: ApiFootballConfig;
  cache: ResponseCache;
  usage: UsageStore;
  network?: NetworkPolicy;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface GetOptions {
  maxAgeMs: number;
  kind: RequestKind;
}

// Credential-free canonical form of a request: sorted parameters, so equal requests share one cache entry.
export function requestKey(endpoint: string, params: Record<string, string>): string {
  const url = new URL(`${API_FOOTBALL_BASE_URL}/${endpoint}`);
  for (const k of Object.keys(params).sort()) url.searchParams.set(k, params[k]!);
  return url.href;
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

function errorMessages(errors: Envelope['errors']): Record<string, string> {
  if (Array.isArray(errors)) return Object.fromEntries(errors.map((e, i) => [String(i), String(e)]));
  return Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, String(v)]));
}

function classify(keys: string[]): FailureCode {
  if (keys.includes('rateLimit')) return 'RATE_LIMITED';
  if (keys.includes('requests')) return 'BUDGET';
  if (keys.includes('token')) return 'AUTH';
  if (keys.includes('plan')) return 'PLAN';
  return 'API_ERROR';
}

// Failures after which no further request in this run can succeed.
const TERMINAL: ReadonlySet<FailureCode> = new Set(['BUDGET', 'RATE_LIMITED', 'AUTH']);

export class ApiFootballClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly network: NetworkPolicy;
  private lastRequestAt = 0;
  private stats: RequestStats = { requests: 0, cacheHits: 0, cacheMisses: 0, errors: 0, rateLimited: 0, planned: [], stoppedReason: null };

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.network = options.network ?? 'all';
  }

  isConfigured(): boolean {
    return this.options.config.key !== null;
  }

  // Whether `fixtures?ids=` batching may be attempted at all. Plans that refuse the parameter
  // can set it false to skip the one probe request per run.
  batchingAllowed(): boolean {
    return this.options.config.batchFixtures;
  }

  requestStats(): RequestStats {
    return { ...this.stats, planned: [...this.stats.planned] };
  }

  // Removes the key from any text that could reach a log, an error or the database.
  private scrub(text: string): string {
    const key = this.options.config.key?.reveal();
    return key ? text.split(key).join('[redacted]') : text;
  }

  async peek(key: string, maxAgeMs: number): Promise<{ envelope: Envelope; fetchedAt: Date } | null> {
    const cached = await this.options.cache.get(key);
    if (!cached || this.now().getTime() - cached.fetchedAt.getTime() >= maxAgeMs) return null;
    const parsed = EnvelopeSchema.safeParse(safeJson(cached.body));
    return parsed.success ? { envelope: parsed.data, fetchedAt: cached.fetchedAt } : null;
  }

  // Stores a response under a derived key (for example one fixture out of a batched request).
  async store(key: string, envelope: Envelope, fetchedAt: Date): Promise<void> {
    await this.options.cache.set(key, API_FOOTBALL_SOURCE, { body: JSON.stringify(envelope), fetchedAt });
  }

  async recordCacheUse(hits: number, misses: number): Promise<void> {
    this.stats.cacheHits += hits;
    this.stats.cacheMisses += misses;
    if (hits + misses > 0) await this.options.usage.record(API_FOOTBALL_SOURCE, utcDay(this.now()), { cacheHits: hits, cacheMisses: misses });
  }

  plan(key: string): void {
    if (!this.stats.planned.includes(key)) this.stats.planned.push(key);
  }

  async get(endpoint: string, params: Record<string, string>, opts: GetOptions): Promise<ClientResult> {
    const key = requestKey(endpoint, params);
    const hit = await this.peek(key, opts.maxAgeMs);
    if (hit) {
      await this.recordCacheUse(1, 0);
      return { ok: true, ...hit, fromCache: true };
    }
    await this.recordCacheUse(0, 1);
    return this.request(endpoint, params, opts.kind, true);
  }

  // For batched requests whose content the caller caches per item under derived keys.
  fetchUncached(endpoint: string, params: Record<string, string>, kind: RequestKind): Promise<ClientResult> {
    return this.request(endpoint, params, kind, false);
  }

  // Follows `paging` until every page is held; stops (without partial data) if any page fails.
  async getAll(endpoint: string, params: Record<string, string>, opts: GetOptions): Promise<ClientResult> {
    const first = await this.get(endpoint, params, opts);
    if (!first.ok) return first;
    const total = Math.min(first.envelope.paging?.total ?? 1, MAX_PAGES);
    if ((first.envelope.paging?.total ?? 1) > MAX_PAGES) {
      return { ok: false, code: 'API_ERROR', message: `${endpoint} has ${first.envelope.paging!.total} pages; refusing to request more than ${MAX_PAGES}` };
    }
    const response = [...first.envelope.response];
    let fetchedAt = first.fetchedAt;
    let fromCache = first.fromCache;
    for (let page = 2; page <= total; page += 1) {
      const next = await this.get(endpoint, { ...params, page: String(page) }, opts);
      if (!next.ok) return next;
      response.push(...next.envelope.response);
      if (next.fetchedAt < fetchedAt) fetchedAt = next.fetchedAt;
      fromCache &&= next.fromCache;
    }
    return { ok: true, envelope: { ...first.envelope, paging: { current: 1, total: 1 }, results: response.length, response }, fetchedAt, fromCache };
  }

  private async request(endpoint: string, params: Record<string, string>, kind: RequestKind, cacheResponse: boolean): Promise<ClientResult> {
    const key = requestKey(endpoint, params);
    const config = this.options.config;
    if (!config.key) return { ok: false, code: 'NOT_CONFIGURED', message: 'API_FOOTBALL_KEY is not configured' };
    if (this.network === 'none' || (this.network === 'discovery' && kind === 'detail')) {
      this.plan(key);
      return { ok: false, code: 'NOT_CACHED', message: 'Not cached; request planned (dry-run)' };
    }
    if (this.stats.stoppedReason) {
      this.plan(key);
      return { ok: false, code: 'STOPPED', message: this.stats.stoppedReason };
    }

    const day = utcDay(this.now());
    const usage = await this.options.usage.today(API_FOOTBALL_SOURCE, day);
    if (usage.requests >= config.dailyBudget) return this.stop(key, 'BUDGET', `Nexora daily budget of ${config.dailyBudget} requests reached`);
    if (usage.remaining !== null && usage.remaining <= config.reserve) {
      return this.stop(key, 'BUDGET', `Provider reports ${usage.remaining} requests left today (reserve ${config.reserve})`);
    }

    const wait = this.lastRequestAt + config.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();

    const at = this.now();
    this.stats.requests += 1;
    let response: Response;
    try {
      response = await this.fetchImpl(key, {
        headers: { 'x-apisports-key': config.key.reveal(), accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const message = this.scrub(`Request to ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
      return this.fail(day, at, 'NETWORK', message);
    }

    const remaining = numberHeader(response, 'x-ratelimit-requests-remaining');
    const dailyLimit = numberHeader(response, 'x-ratelimit-requests-limit');
    await this.options.usage.record(API_FOOTBALL_SOURCE, day, { requests: 1, remaining, dailyLimit, lastRequestAt: at });

    if (response.status === 429) {
      this.stats.rateLimited += 1;
      await this.options.usage.record(API_FOOTBALL_SOURCE, day, { rateLimited: 1 });
      return this.stop(key, 'RATE_LIMITED', `${endpoint}: HTTP 429 rate limited`, day, at);
    }
    // The live API answers an invalid or suspended key with 401/403; no later request in this run can succeed.
    if (response.status === 401 || response.status === 403) return this.stop(key, 'AUTH', `${endpoint}: HTTP ${response.status} (key rejected)`, day, at);
    if (!response.ok) return this.fail(day, at, 'HTTP_ERROR', `${endpoint}: HTTP ${response.status}`);

    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) return this.fail(day, at, 'MALFORMED', `${endpoint}: response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    const parsed = EnvelopeSchema.safeParse(safeJson(body));
    if (!parsed.success) return this.fail(day, at, 'MALFORMED', `${endpoint}: response is not a valid API-Football envelope`);

    const messages = errorMessages(parsed.data.errors);
    const errorKeys = Object.keys(messages);
    if (errorKeys.length > 0) {
      const code = classify(errorKeys);
      const message = this.scrub(`${endpoint}: ${errorKeys.map((k) => `${k}: ${messages[k]}`).join('; ')}`);
      if (code === 'RATE_LIMITED') {
        this.stats.rateLimited += 1;
        await this.options.usage.record(API_FOOTBALL_SOURCE, day, { rateLimited: 1 });
      }
      if (TERMINAL.has(code)) return this.stop(key, code, message, day, at);
      return this.fail(day, at, code, message);
    }

    if (cacheResponse) await this.options.cache.set(key, API_FOOTBALL_SOURCE, { body, fetchedAt: at });
    await this.options.usage.record(API_FOOTBALL_SOURCE, day, { lastSuccessAt: at });
    return { ok: true, envelope: parsed.data, fetchedAt: at, fromCache: false };
  }

  private async fail(day: string, at: Date, code: FailureCode, message: string): Promise<ClientResult> {
    this.stats.errors += 1;
    await this.options.usage.record(API_FOOTBALL_SOURCE, day, { errors: 1, lastError: message.slice(0, 500), lastRequestAt: at });
    return { ok: false, code, message };
  }

  private async stop(key: string, code: FailureCode, message: string, day?: string, at?: Date): Promise<ClientResult> {
    this.stats.stoppedReason = message;
    this.plan(key);
    if (day && at) return this.fail(day, at, code, message);
    return { ok: false, code, message };
  }
}

function numberHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
