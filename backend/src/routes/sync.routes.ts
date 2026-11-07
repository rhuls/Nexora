import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { runSyncPass } from '../data/sync/sync-pass.js';
import { ErrorResponseSchema } from '../types/api.js';

const Json = z.record(z.string(), z.unknown());

export function syncRoutes(prisma: PrismaClient) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // Both methods: a person or a CLI posts, while scheduled triggers on hosts such as Vercel
    // issue a GET. The work is identical and guarded identically.
    r.route({
      method: ['GET', 'POST'],
      url: '/sync/run',
      preHandler: app.auth.require,
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: {
        tags: ['data'],
        summary: 'Run one live sync pass: refresh the backbone, enrich live seasons, evaluate settled forecasts',
        description: 'Replaces the long-running worker on a host that cannot keep a process alive. Runs the same code.',
        response: { 200: Json, 401: ErrorResponseSchema },
      },
      handler: async () => ({ ...(await runSyncPass(prisma)) }),
    });
  };
}
