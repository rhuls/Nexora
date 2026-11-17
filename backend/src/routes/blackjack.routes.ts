import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BlackjackService } from '../services/blackjack.service.js';
import { BlackjackIntelligenceService, ObservationRejected } from '../services/blackjack-intelligence.service.js';
import { DEFAULT_RULES, HandSchema, RulesSchema } from '../blackjack/types.js';
import { chooseTarget, deal, dealerPlay, isLive, isNatural, legalActions, remainingComposition, runningCount, settleHand, trueCount } from '../blackjack/trainer.js';
import { ErrorResponseSchema } from '../types/api.js';

const Json = z.record(z.string(), z.unknown());
// Simulation is the only endpoint here that costs real compute. An authenticated caller may ask
// for millions of rounds; an anonymous one on a metered host may not.
const PUBLIC_MAX_ROUNDS = 200_000;
const MAX_ROUNDS = 2_000_000;
const Seen = z.array(z.number().int().min(0).max(9)).max(416).optional();
const Upcard = z.number().int().min(0).max(9);

function drawOne(comp: number[]): number {
  const total = comp.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('The shoe is empty');
  let roll = Math.random() * total;
  for (let rank = 0; rank < 10; rank += 1) {
    roll -= comp[rank];
    if (roll <= 0) {
      comp[rank] -= 1;
      return rank;
    }
  }
  for (let rank = 9; rank >= 0; rank -= 1) if (comp[rank] > 0) { comp[rank] -= 1; return rank; }
  throw new Error('The shoe is empty');
}

export function blackjackRoutes(prisma?: import('@prisma/client').PrismaClient) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const service = new BlackjackService();
    const intelligence = prisma ? new BlackjackIntelligenceService(prisma) : null;

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
        querystring: RulesSchema.extend({ seen: z.string().max(1200).optional() }),
        response: { 200: Json },
      },
      handler: async (req) => {
        // `seen` arrives as a compact rank string so a long shoe fits in a query: "09123".
        const { seen: rawSeen, ...rules } = req.query;
        const seen = rawSeen ? [...rawSeen].map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 9) : [];
        return { rules, seenCards: seen.length, ...service.edge(rules, seen) };
      },
    });

    // ---- Trainer ----
    // Every rule of play lives here rather than in the browser, so the page cannot drift from the
    // solver it is being graded against. The shoe is not held server-side: the caller sends the
    // cards already seen and gets the next ones back, which keeps the endpoints stateless.

    r.post('/blackjack/trainer/deal', {
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: {
        tags: ['blackjack'],
        summary: 'Deal the next practice hand, favouring situations this player keeps misplaying',
        description: 'Send the weaknesses recorded so far and the hand is more likely to be one of them. The hole card comes back with the deal so that dealer blackjack resolves exactly as it would at a table.',
        body: z.object({
          rules: RulesSchema.default(DEFAULT_RULES),
          seen: Seen,
          weak: z.array(z.object({ key: z.string().min(1).max(40), evLost: z.number().min(0).max(1000) })).max(200).default([]),
          drillBias: z.number().min(0).max(1).default(0.5),
        }),
        response: { 200: Json, 400: ErrorResponseSchema },
      },
      handler: async (req) => {
        const { rules, seen = [], weak, drillBias } = req.body;
        const comp = remainingComposition(rules, seen);
        // Deal and settle together need five cards at most; reshuffle rather than run the shoe dry.
        const exhausted = comp.reduce((a, b) => a + b, 0) < 20;
        const live = exhausted ? remainingComposition(rules, []) : comp;
        const random = () => Math.random();
        const dealt = deal(live, random, chooseTarget(weak, random, drillBias));
        const revealed = [...dealt.player, dealt.upcard];
        const base = exhausted ? [] : seen;

        // At a table that peeks, a dealer natural ends the hand before anyone acts — which matters,
        // because otherwise the player could be offered a double or a split against a hand that has
        // already won. A player natural is settled on the spot for the same reason.
        const dealerNatural = rules.peek && isNatural([dealt.upcard, dealt.hole]);
        const playerNatural = isNatural(dealt.player);
        const over = dealerNatural || playerNatural;

        return {
          ...dealt,
          reshuffled: exhausted,
          dealerNatural,
          playerNatural,
          // What the player may do first, and the count as it stands before they act.
          legalActions: over ? [] : legalActions(dealt.player, rules, { fromSplit: false, handCount: 1 }),
          count: { running: runningCount([...base, ...revealed]), true: trueCount([...base, ...revealed], rules.decks) },
        };
      },
    });

    r.post('/blackjack/trainer/draw', {
      config: { rateLimit: { max: 480, timeWindow: '1 minute' } },
      schema: {
        tags: ['blackjack'],
        summary: 'Draw cards from what is left of the shoe',
        body: z.object({ rules: RulesSchema.default(DEFAULT_RULES), seen: Seen, count: z.number().int().min(1).max(4).default(1) }),
        response: { 200: Json, 400: ErrorResponseSchema },
      },
      handler: async (req) => {
        const { rules, seen = [], count } = req.body;
        const comp = remainingComposition(rules, seen);
        const cards = Array.from({ length: count }, () => drawOne(comp));
        return { cards, count: { running: runningCount([...seen, ...cards]), true: trueCount([...seen, ...cards], rules.decks) } };
      },
    });

    r.post('/blackjack/trainer/settle', {
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: {
        tags: ['blackjack'],
        summary: 'Play the dealer out and settle every hand',
        body: z.object({
          rules: RulesSchema.default(DEFAULT_RULES),
          seen: Seen,
          dealer: z.array(z.number().int().min(0).max(9)).min(2).max(12),
          hands: z.array(z.object({ cards: HandSchema, stake: z.number().min(0).max(4).default(1), surrendered: z.boolean().default(false) })).min(1).max(4),
        }),
        response: { 200: Json, 400: ErrorResponseSchema },
      },
      handler: async (req) => {
        const { rules, seen = [], dealer, hands } = req.body;
        const comp = remainingComposition(rules, [...seen, ...dealer]);
        // With every hand already busted or surrendered the dealer has nothing to beat and does
        // not draw, exactly as at a table: the cards that would have come out stay in the shoe.
        const anyLive = hands.some((h) => isLive(h.cards, h.surrendered));
        const final = anyLive ? dealerPlay(dealer, () => drawOne(comp), rules) : [...dealer];
        const settled = hands.map((h) => ({ cards: h.cards, ...settleHand(h.cards, final, h.stake, h.surrendered, rules) }));
        return {
          dealer: final,
          drawn: final.slice(dealer.length),
          hands: settled,
          net: settled.reduce((sum, h) => sum + h.net, 0),
        };
      },
    });

    // ---- Model intelligence ----
    // Observations are append-only and the solver is never edited. A correction, if one is ever
    // warranted, is stored as a separate version and has to beat the baseline on held-out hands.

    r.post('/blackjack/observations', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: {
        tags: ['blackjack'],
        summary: 'Record a hand that was actually played, with the forecast recomputed here',
        description: 'Send what was seen, not what the model said. The forecast is recomputed from these inputs so that every stored row can be reproduced from the row itself.',
        body: z.object({
          rules: RulesSchema.default(DEFAULT_RULES),
          seen: z.array(z.number().int().min(0).max(9)).max(416).default([]),
          playerCards: HandSchema,
          dealerUpcard: Upcard,
          dealerFinalCards: z.array(z.number().int().min(0).max(9)).min(2).max(12),
          playerFinalCards: HandSchema,
          stake: z.number().min(0).max(4).default(1),
          surrendered: z.boolean().default(false),
          predictedAt: z.coerce.date().optional(),
        }),
        response: { 200: Json, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
      handler: async (req, reply) => {
        if (!intelligence) return reply.status(503).send({ error: 'Unavailable', message: 'No database is configured for this deployment.' });
        let result;
        try {
          result = await intelligence.recordPlayed({ ...req.body, predictedAt: req.body.predictedAt ?? new Date() });
        } catch (error) {
          if (error instanceof ObservationRejected) return reply.status(400).send({ error: 'ObservationRejected', message: error.message });
          throw error;
        }
        const { recorded, observation } = result;
        return {
          recorded,
          dealerOutcome: observation.dealerOutcome,
          dealerDistribution: observation.dealerDistribution,
          settled: observation.settled,
          net: observation.net,
        };
      },
    });

    r.post('/blackjack/observations/simulate', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['blackjack'],
        summary: 'Deal hands and record what the model forecast before each one resolved',
        description: 'Honestly dealt, but from the model\u2019s own assumptions: this tests whether the arithmetic is right, not whether the assumptions match a real table. Recorded as SIMULATED so the two are never confused.',
        body: z.object({
          rounds: z.coerce.number().int().min(100).max(200_000).default(20_000),
          seed: z.coerce.number().int().min(0).max(2 ** 31).optional(),
          policy: z.enum(['stand', 'solver']).default('stand'),
          rules: RulesSchema.default(DEFAULT_RULES),
        }),
        response: { 200: Json, 401: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
      handler: async (req, reply) => {
        if (!intelligence) return reply.status(503).send({ error: 'Unavailable', message: 'No database is configured for this deployment.' });
        return intelligence.simulate(req.body);
      },
    });

    r.post('/blackjack/model/evaluate', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['blackjack'],
        summary: 'Score the record, look for weaknesses, and put a fitted correction on trial',
        body: z.object({
          rules: RulesSchema.default(DEFAULT_RULES),
          source: z.enum(['ALL', 'PLAYED', 'SIMULATED']).default('ALL'),
          limit: z.coerce.number().int().min(100).max(400_000).default(200_000),
        }),
        response: { 200: Json, 401: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
      handler: async (req, reply) => {
        if (!intelligence) return reply.status(503).send({ error: 'Unavailable', message: 'No database is configured for this deployment.' });
        return intelligence.runEvaluation(req.body);
      },
    });

    r.get('/blackjack/model/intelligence', {
      schema: {
        tags: ['blackjack'],
        summary: 'The latest evaluation, the record it was computed from, and every earlier verdict',
        querystring: RulesSchema,
        response: { 200: Json, 503: ErrorResponseSchema },
      },
      handler: async (req, reply) => {
        if (!intelligence) return reply.status(503).send({ error: 'Unavailable', message: 'No database is configured for this deployment.' });
        try {
          const [counts, history] = await Promise.all([intelligence.counts(req.query), intelligence.history(req.query)]);
          const latest = history[0] ? await prisma!.blackjackEvaluationRun.findUnique({ where: { id: history[0].id }, select: { summary: true } }) : null;
          return { rules: req.query, counts, history, latest: latest?.summary ?? null };
        } catch (error) {
          // A deployment whose database has not had the migration applied yet should say so rather
          // than return an error with nothing actionable in it.
          if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2021') {
            return reply.status(503).send({
              error: 'MigrationPending',
              message: 'The blackjack observation tables do not exist on this database yet. Run `prisma migrate deploy` against it.',
            });
          }
          throw error;
        }
      },
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
