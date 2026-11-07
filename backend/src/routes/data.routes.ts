import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import { IMPORTABLE_DATASETS } from '../data/import/catalog.js';
import { openFootballUrl } from '../providers/openfootball/datasets.js';
import { FreshnessResponseSchema } from '../types/api.js';
import { providerStatus } from './enrichment.routes.js';

export function dataRoutes(prisma: PrismaClient) {
  return async (app: FastifyInstance): Promise<void> => {
    app.withTypeProvider<ZodTypeProvider>().get('/data/freshness', {
      schema: { tags: ['data'], summary: 'How current each imported dataset is', response: { 200: FreshnessResponseSchema } },
      handler: async () => {
        const now = new Date();
        const datasets = await Promise.all(
          IMPORTABLE_DATASETS.map(async (d) => {
            const dataset = `${d.competitionSourceId}/${d.seasonSourceId}`;
            const where = { source: d.source, sourceId: { startsWith: `${dataset}/` } };
            const [lastAttempt, lastSuccess, cache, total, finished, scheduled, awaiting, next] = await Promise.all([
              prisma.importRun.findFirst({ where: { source: d.source, dataset }, orderBy: { startedAt: 'desc' } }),
              prisma.importRun.findFirst({ where: { source: d.source, dataset, status: 'COMPLETED' }, orderBy: { startedAt: 'desc' } }),
              prisma.externalSourceCache.findUnique({ where: { url: openFootballUrl(d) }, select: { fetchedAt: true } }),
              prisma.match.count({ where }),
              prisma.match.count({ where: { ...where, status: 'FINISHED' } }),
              prisma.match.count({ where: { ...where, status: 'SCHEDULED' } }),
              prisma.match.count({ where: { ...where, status: { in: ['SCHEDULED', 'LIVE'] }, matchDate: { lt: now } } }),
              prisma.match.findFirst({ where: { ...where, status: 'SCHEDULED', matchDate: { gte: now } }, orderBy: { matchDate: 'asc' }, select: { matchDate: true } }),
            ]);
            return {
              source: d.source,
              dataset,
              dataEnvironment: d.dataEnvironment,
              lastAttempt: lastAttempt ? { status: lastAttempt.status, startedAt: lastAttempt.startedAt.toISOString() } : null,
              lastSuccessfulImportAt: lastSuccess?.startedAt.toISOString() ?? null,
              sourceFetchedAt: cache?.fetchedAt.toISOString() ?? null,
              matches: total,
              finished,
              scheduled,
              awaitingResult: awaiting,
              nextKickoff: next?.matchDate.toISOString() ?? null,
            };
          }),
        );
        return { asOf: now.toISOString(), datasets, providers: [await providerStatus(prisma, now)] };
      },
    });
  };
}
