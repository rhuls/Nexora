import { inspect } from 'node:util';
import { z } from 'zod';

export const API_FOOTBALL_SOURCE = 'api-football';
export const API_FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';
// API-Football's Premier League ID. The only competition Nexora has curated team identities for.
export const API_FOOTBALL_EPL_LEAGUE_ID = '39';

const REDACTED = '[redacted]';

// Holds a credential so that logging, JSON serialisation, string interpolation and util.inspect never reveal it.
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface ApiFootballConfig {
  key: Secret | null;
  // Nexora's own ceiling per UTC day, kept below the plan limit so manual checks remain possible.
  dailyBudget: number;
  // Stop when the provider reports this many or fewer requests left today.
  reserve: number;
  // Minimum spacing between requests, respecting the per-minute limit.
  minIntervalMs: number;
  timeoutMs: number;
  // One `fixtures?ids=` request carries up to 20 fixtures, but the free plan refuses the `ids`
  // parameter outright. Leave this true to try batching and fall back on refusal; set it false
  // to go straight to one request per fixture and save the one probe request per run.
  batchFixtures: boolean;
}

const ConfigSchema = z.object({
  API_FOOTBALL_KEY: z.string().trim().optional(),
  API_FOOTBALL_DAILY_BUDGET: z.coerce.number().int().min(1).max(100_000).default(90),
  API_FOOTBALL_RESERVE: z.coerce.number().int().min(0).max(1000).default(5),
  API_FOOTBALL_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(120_000).default(6500),
  // z.coerce.boolean() cannot be used: Boolean('false') is true.
  API_FOOTBALL_BATCH_FIXTURES: z.enum(['true', 'false']).default('true'),
});

// A missing key is a valid state ("not configured"), never a startup failure.
export function loadApiFootballConfig(source: NodeJS.ProcessEnv = process.env): ApiFootballConfig {
  const parsed = ConfigSchema.safeParse(source);
  if (!parsed.success) {
    // Report only the variable names; values (including the key) never appear in the message.
    throw new Error(`Invalid API-Football configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const key = parsed.data.API_FOOTBALL_KEY;
  return {
    key: key ? new Secret(key) : null,
    dailyBudget: parsed.data.API_FOOTBALL_DAILY_BUDGET,
    reserve: parsed.data.API_FOOTBALL_RESERVE,
    minIntervalMs: parsed.data.API_FOOTBALL_MIN_INTERVAL_MS,
    timeoutMs: 20_000,
    batchFixtures: parsed.data.API_FOOTBALL_BATCH_FIXTURES === 'true',
  };
}
