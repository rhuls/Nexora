import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BlackjackService } from '../services/blackjack.service.js';
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
