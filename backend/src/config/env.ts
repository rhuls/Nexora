import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Same-origin deployments (nginx locally, a Vercel rewrite in production) need no cross-origin
  // allowance at all, so an empty value disables CORS rather than failing to boot.
  CORS_ORIGIN: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

// How long one season's import may hold its transaction. Two minutes suits a database on the same
// host; a managed one across a network needs more, because the cost is round-trips rather than work.
const IMPORT_TX_TIMEOUT_DEFAULT_MS = 120_000;

export function importTransactionTimeoutMs(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source.IMPORT_TRANSACTION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return IMPORT_TX_TIMEOUT_DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 10_000 || parsed > 30 * 60_000) {
    throw new Error('IMPORT_TRANSACTION_TIMEOUT_MS must be between 10000 and 1800000 milliseconds');
  }
  return Math.floor(parsed);
}
