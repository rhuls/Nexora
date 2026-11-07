import Fastify from 'fastify';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPrismaClient } from './config/prisma.js';

// Configuration is validated before anything starts, and a bad value throws. On a host that only
// surfaces a crashed process as an opaque invocation failure, that leaves nothing to diagnose
// from the outside. So a configuration failure starts a minimal server that reports which
// variable is wrong instead — the messages name variables, never their values.
async function start(): Promise<void> {
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '0.0.0.0';

  let env, prisma, app;
  try {
    env = loadEnv();
    prisma = createPrismaClient();
    app = await buildApp(env, prisma);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = Fastify({ logger: true });
    fallback.log.error({ err: error }, 'Configuration is invalid; serving the reason instead of starting');
    fallback.all('/*', async (_request, reply) =>
      reply.status(503).send({
        error: 'ConfigurationError',
        message,
        hint: 'Set the missing or invalid variables on this environment and redeploy. Values are never echoed here.',
      }),
    );
    await fallback.listen({ port, host });
    return;
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

await start();
