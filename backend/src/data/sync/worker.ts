import { pino } from 'pino';
import { z } from 'zod';
import { createPrismaClient } from '../../config/prisma.js';
import { runSyncPass } from './sync-pass.js';

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
    LIVE_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(24 * 60),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { service: 'nexora-live-sync' } });
const prisma = createPrismaClient();

let stopping = false;
let timer: NodeJS.Timeout | undefined;

async function runOnce(): Promise<void> {
  try {
    const result = await runSyncPass(prisma);
    for (const s of result.imports) {
      if (s.status === 'COMPLETED') log.info(s, 'live sync completed');
      else log.error(s, 'live sync failed');
    }
    for (const e of result.enrichment) {
      if (e.status === 'COMPLETED') log.info(e, 'enrichment completed');
      else if (e.status === 'NOT_CONFIGURED') log.info({ source: e.source }, 'enrichment not configured; skipped');
      else log.error(e, 'enrichment failed');
    }
    if (result.enrichmentError) log.error({ error: result.enrichmentError }, 'enrichment crashed; backbone sync unaffected');
    log.info(result.evaluated, 'live forecasts evaluated');
  } catch (error) {
    log.error({ err: error }, 'live sync crashed');
  }
  if (!stopping) timer = setTimeout(() => void runOnce(), env.LIVE_SYNC_INTERVAL_MINUTES * 60_000);
}

const shutdown = async (signal: string): Promise<void> => {
  stopping = true;
  if (timer) clearTimeout(timer);
  log.info({ signal }, 'stopping live sync');
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log.info({ intervalMinutes: env.LIVE_SYNC_INTERVAL_MINUTES }, 'live sync worker started');
void runOnce();
