import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ImportService } from '../data/import/import.service.js';
import { ImportRequestSchema, ImportResponseSchema, ImportRunListQuerySchema, ImportRunListResponseSchema } from '../types/api.js';

export function importRoutes(imports: ImportService) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post('/import/football-data', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['import'],
        summary: 'Import an allowlisted dataset (idempotent; historical records are never overwritten)',
        body: ImportRequestSchema,
        response: { 200: ImportResponseSchema },
      },
      handler: async (request) => ({
        runs: await imports.importSeasons(request.body.source, request.body.competition, request.body.seasons),
      }),
    });

    r.get('/import/runs', {
      schema: { tags: ['import'], summary: 'Recent import runs', querystring: ImportRunListQuerySchema, response: { 200: ImportRunListResponseSchema } },
      handler: async (request) => ({
        items: (await imports.listRuns(request.query.limit)).map((run) => ({
          id: run.id,
          source: run.source,
          dataset: run.dataset,
          dataEnvironment: run.dataEnvironment,
          status: run.status,
          counts: run.counts && typeof run.counts === 'object' && !Array.isArray(run.counts) ? (run.counts as Record<string, unknown>) : null,
          warningCount: Array.isArray(run.warnings) ? run.warnings.length : 0,
          errorMessage: run.errorMessage,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
        })),
      }),
    });
  };
}
