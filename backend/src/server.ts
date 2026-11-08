import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from './build-app.js';
import { loadEnv } from './config/env.js';
import { createPrismaClient } from './config/prisma.js';

// Configuration is validated before anything starts, and a bad value throws. On a host that only
// surfaces a crashed process as an opaque invocation failure, that leaves nothing to diagnose
// from the outside. So a configuration failure yields a minimal server that reports which
// variable is wrong instead — the messages name variables, never their values.
function configurationErrorApp(error: unknown): FastifyInstance {
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
  return fallback;
}

async function createServer(): Promise<FastifyInstance> {
  let app: FastifyInstance;
  try {
    const env = loadEnv();
    const prisma = createPrismaClient();
    app = await buildApp(env, prisma);

    const shutdown = async (signal: string): Promise<void> => {
      app.log.info({ signal }, 'Shutting down');
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    app = configurationErrorApp(error);
  }
  return app;
}

const app = await createServer();

// Two hosts drive this file differently.
//
// Under Docker this file is the whole process, so it binds a port and stays up.
//
// On Vercel the platform imports this module and calls the exported function once per request.
// It imports with `http.Server.prototype.listen` monkey-patched to capture the server rather
// than bind it, and the patched version returns without ever emitting `listening`. So a
// `listen()` awaited here never resolves, the module never finishes importing, and every
// request hangs until the client gives up — no error, no log, nothing to go on. Awaiting
// `ready()` instead settles the plugin graph, which is all the request path needs.
if (process.env.VERCEL) {
  await app.ready();
} else {
  await app.listen({
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? '0.0.0.0',
  });
}

// Fastify's instance is not itself a request listener, so hand the platform the raw one. This is
// the shape its runtime probes for first, which keeps the dispatch explicit instead of relying on
// it to detect a captured server and proxy to it.
export default function handler(request: IncomingMessage, response: ServerResponse): void {
  app.server.emit('request', request, response);
}
