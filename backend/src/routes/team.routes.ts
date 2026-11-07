import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { TeamController } from '../controllers/team.controller.js';
import { ErrorResponseSchema, IdParamsSchema, TeamDetailSchema, TeamListQuerySchema, TeamListResponseSchema, TeamPlayersResponseSchema } from '../types/api.js';

export function teamRoutes(controller: TeamController) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get('/teams', {
      schema: { tags: ['teams'], summary: 'List teams', querystring: TeamListQuerySchema, response: { 200: TeamListResponseSchema } },
      handler: controller.list,
    });

    r.get('/teams/:id', {
      schema: { tags: ['teams'], summary: 'Get a team', params: IdParamsSchema, response: { 200: TeamDetailSchema, 404: ErrorResponseSchema } },
      handler: controller.getById,
    });

    r.get('/teams/:id/players', {
      schema: {
        tags: ['teams'],
        summary: 'List a team squad',
        params: IdParamsSchema,
        response: { 200: TeamPlayersResponseSchema, 404: ErrorResponseSchema },
      },
      handler: controller.getPlayers,
    });
  };
}
