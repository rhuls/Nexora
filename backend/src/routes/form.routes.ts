import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FormService } from '../services/form.service.js';
import { H2HQuerySchema, H2HResponseSchema, MatchFormResponseSchema, TeamFormQuerySchema, TeamFormResponseSchema, WindowQuerySchema } from '../types/analysis-api.js';
import { ErrorResponseSchema, IdParamsSchema } from '../types/api.js';

export function formRoutes(forms: FormService) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get('/matches/:id/form', {
      schema: {
        tags: ['analysis'],
        summary: 'Last-N form and home/away splits for both teams, using only information known before kickoff',
        params: IdParamsSchema,
        querystring: WindowQuerySchema,
        response: { 200: MatchFormResponseSchema, 404: ErrorResponseSchema },
      },
      handler: async (request) => forms.matchForm(request.params.id, request.query.window),
    });

    r.get('/matches/:id/h2h', {
      schema: {
        tags: ['analysis'],
        summary: 'Time-weighted head-to-head from meetings known before kickoff',
        params: IdParamsSchema,
        querystring: H2HQuerySchema,
        response: { 200: H2HResponseSchema, 404: ErrorResponseSchema },
      },
      handler: async (request) => forms.matchHeadToHead(request.params.id, request.query.limit, request.query.halfLifeDays),
    });

    r.get('/teams/:id/form', {
      schema: {
        tags: ['analysis'],
        summary: "A team's form as of now (or a past instant)",
        params: IdParamsSchema,
        querystring: TeamFormQuerySchema,
        response: { 200: TeamFormResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
      handler: async (request) => forms.teamForm(request.params.id, request.query.window, request.query.asOf),
    });
  };
}
