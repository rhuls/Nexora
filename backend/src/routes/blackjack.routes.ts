import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BlackjackService } from '../services/blackjack.service.js';
import { DEFAULT_RULES, HandSchema, RulesSchema } from '../blackjack/types.js';
import { ErrorResponseSchema } from '../types/api.js';

const Json = z.record(z.string(), z.unknown());
// Simulation is the only endpoint here that costs real compute. An authenticated caller may ask
// for millions of rounds; an anonymous one on a metered host may not.
const PUBLIC_MAX_ROUNDS = 200_000;
const MAX_ROUNDS = 2_000_000;
const Seen = z.array(z.number().int().min(0).max(9)).max(416).optional();
const Upcard = z.number().int().min(0).max(9);

export function blackjackRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const service = new BlackjackService();

    r.post('/blackjack/evaluate', {
      schema: {
        tags: ['blackjack'],
        summary: 'Expected value of every legal action, solved from the cards not yet seen',
        description: 'Ranks 0-9 are ace, 2-9, then every ten-value card. Pass cards already dealt in `seen` for a composition-aware answer.',
        body: z.object({ hand: HandSchema, upcard: Upcard, seen: Seen, afterSplit: z.boolean().default(false), rules: RulesSchema.default(DEFAULT_RULES) }),
        response: { 200: Json, 400: ErrorResponseSchema },
      },
      handler: async (req) => {
        const d = service.evaluateHand(req.body.hand, req.body.upcard, req.body.rules, req.body.seen, req.body.afterSplit);
        return { ...d, margin: Number.isFinite(d.margin) ? d.margin : null };
      },
    });

    r.get('/blackjack/strategy', {
      schema: {
        tags: ['blackjack'],
        summary: 'The full strategy chart, derived cell by cell rather than looked up',
        querystring: RulesSchema,
        response: { 200: Json },
      },
      handler: async (req) => ({ rules: req.query, ...service.chart(req.query) }),
    });

    r.get('/blackjack/edge', {
      schema: {
        tags: ['blackjack'],
        summary: 'Player expected value per unit staked under optimal play',
        querystring: RulesSchema,
        response: { 200: Json },
      },
      handler: async (req) => ({ rules: req.query, ...service.edge(req.query) }),
    });

    r.post('/blackjack/simulate', {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['blackjack'],
        summary: 'Deal seeded rounds and compare the result with the enumerated figure',
        body: z.object({
          rounds: z.coerce.number().int().min(100).max(MAX_ROUNDS).default(100_000),
          seed: z.coerce.number().int().min(0).max(2 ** 31).default(1),
          penetration: z.coerce.number().min(0.1).max(0.95).default(0.75),
          rules: RulesSchema.default(DEFAULT_RULES),
        }),
        response: { 200: Json, 401: ErrorResponseSchema },
      },
      handler: async (req, reply) => {
        if (req.body.rounds > PUBLIC_MAX_ROUNDS && !app.auth.authenticated(req)) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: `Up to ${PUBLIC_MAX_ROUNDS.toLocaleString()} rounds are open to anyone; more needs the deployment token.`,
          });
        }
        return { rules: req.body.rules, ...service.simulate(req.body.rounds, req.body.rules, req.body.seed, req.body.penetration) };
      },
    });
  };
}
