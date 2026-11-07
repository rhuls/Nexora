import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { MatchController } from '../controllers/match.controller.js';
import {
  ErrorResponseSchema,
  IdParamsSchema,
  KnowledgeQuerySchema,
  KnowledgeResponseSchema,
  MatchDetailSchema,
  MatchListQuerySchema,
  MatchListResponseSchema,
  RevisionListResponseSchema,
  TodayQuerySchema,
  TodayResponseSchema,
  UpcomingQuerySchema,
  UpcomingResponseSchema,
} from '../types/api.js';

export function matchRoutes(controller: MatchController) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get('/matches', {
      schema: { tags: ['matches'], summary: 'List matches', querystring: MatchListQuerySchema, response: { 200: MatchListResponseSchema } },
      handler: controller.list,
    });

    r.get('/matches/:id', {
      schema: {
        tags: ['matches'],
        summary: 'Get a match with team statistics',
        params: IdParamsSchema,
        response: { 200: MatchDetailSchema, 404: ErrorResponseSchema },
      },
      handler: controller.getById,
    });

    r.get('/matches/today', {
      schema: { tags: ['matches'], summary: "Matches on today's local date", querystring: TodayQuerySchema, response: { 200: TodayResponseSchema } },
      handler: controller.today,
    });

    r.get('/matches/upcoming', {
      schema: {
        tags: ['matches'],
        summary: 'Upcoming fixtures, plus past fixtures still awaiting a result',
        querystring: UpcomingQuerySchema,
        response: { 200: UpcomingResponseSchema },
      },
      handler: controller.upcoming,
    });

    r.get('/matches/:id/revisions', {
      schema: {
        tags: ['matches'],
        summary: 'Audit trail of fixture changes made by imports',
        params: IdParamsSchema,
        response: { 200: RevisionListResponseSchema, 404: ErrorResponseSchema },
      },
      handler: controller.revisions,
    });

    r.get('/matches/:id/knowledge', {
      schema: {
        tags: ['matches'],
        summary: 'Reconstruct exactly what was knowable before kickoff (point-in-time audit)',
        params: IdParamsSchema,
        querystring: KnowledgeQuerySchema,
        response: { 200: KnowledgeResponseSchema, 404: ErrorResponseSchema },
      },
      handler: controller.knowledgeBeforeKickoff,
    });
  };
}
