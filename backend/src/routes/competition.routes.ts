import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CompetitionRepository } from '../repositories/competition.repository.js';
import { CompetitionListResponseSchema } from '../types/api.js';

export function competitionRoutes(competitions: CompetitionRepository) {
  return async (app: FastifyInstance): Promise<void> => {
    app.withTypeProvider<ZodTypeProvider>().get('/competitions', {
      schema: { tags: ['competitions'], summary: 'List competitions with their data environment', response: { 200: CompetitionListResponseSchema } },
      handler: async () => {
        const [rows, byEnv] = await Promise.all([competitions.list(), competitions.matchesByEnvironment()]);
        return {
          items: rows.map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            country: c.country,
            dataEnvironment: c.dataEnvironment,
            source: c.source,
            lastUpdated: c.lastUpdated.toISOString(),
            teams: c._count.teams,
            matches: c._count.matches,
            matchesByEnvironment: Object.fromEntries(byEnv.filter((g) => g.competitionId === c.id).map((g) => [g.dataEnvironment, g._count._all])),
          })),
        };
      },
    });
  };
}
