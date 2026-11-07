import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPrismaClient } from './config/prisma.js';

const env = loadEnv();
const prisma = createPrismaClient();
const app = await buildApp(env, prisma);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
