import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DebateService } from '../services/debate.service.js';
import { DebateSettlementService } from '../services/debate-settlement.service.js';
import { ErrorResponseSchema } from '../types/api.js';
import { NotFoundError } from '../utils/errors.js';

const Env = z.enum(['SYNTHETIC', 'HISTORICAL', 'LIVE']);
const Json = z.record(z.string(), z.unknown());
const MatchParams = z.object({ matchId: z.string().min(1).max(100) });

// The brief's output shape, assembled from the stored pick rows.
const toFixtureJson = (run: {
  matchId: string;
  asOf: Date;
  transcript: unknown;
  picks: Array<{
    market: string;
    probabilities: unknown;
    marketBaseline: unknown;
    edge: number | null;
    confidence: string;
    recommendation: string;
    stakePct: number | null;
    stakeReason: string;
    reasoning: string;
    unresolvedObjections: unknown;
    kickoff: Date;
  }>;
}) => {
  const t = run.transcript as { fixture?: string; rounds?: { one?: { evidence?: { facts?: Array<{ label: string; value: unknown; unavailable: boolean }> } } } } | null;
  const result = run.picks.find((p) => p.market === 'MATCH_RESULT');
  const ou = run.picks.find((p) => p.market === 'OVER_UNDER_25');
  const btts = run.picks.find((p) => p.market === 'BTTS');
  const resultProbs = (result?.probabilities ?? {}) as Record<string, number>;
  const ouProbs = (ou?.probabilities ?? {}) as Record<string, number>;
  const bttsProbs = (btts?.probabilities ?? {}) as Record<string, number>;

  return {
    fixture: t?.fixture ?? run.matchId,
    kickoff: run.picks[0]?.kickoff.toISOString() ?? null,
    probabilities: {
      home: resultProbs.home ?? null,
      draw: resultProbs.draw ?? null,
      away: resultProbs.away ?? null,
      over25: ouProbs.over ?? null,
      btts: bttsProbs.yes ?? null,
    },
    market_baseline: result?.marketBaseline ?? null,
    edge_vs_market: result?.edge ?? null,
    confidence: (result?.confidence ?? 'LOW').toLowerCase(),
    key_evidence: (t?.rounds?.one?.evidence?.facts ?? []).filter((f) => !f.unavailable).slice(0, 8).map((f) => `${f.label}: ${f.value}`),
    skeptic_objections_unresolved: (result?.unresolvedObjections ?? []) as string[],
    recommendation: (result?.recommendation ?? 'NO_PICK').toLowerCase().replace('_', ' '),
    // null, not 0: no stake could be computed is different from a stake of zero.
    suggested_stake_pct: result?.stakePct ?? null,
  };
};

export function debateRoutes(prisma: PrismaClient, oddsConfigured: boolean) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post('/debate/:matchId/run', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['debate'],
        summary: 'Run the four-agent debate for a match (read-only against the forecast pipeline)',
        params: MatchParams,
        response: { 200: Json, 404: ErrorResponseSchema },
      },
      handler: async (req) => {
        const { debateRunId, transcript } = await prisma.$transaction((tx) => new DebateService(tx, undefined, oddsConfigured).run(req.params.matchId), { timeout: 120_000 });
        return { debateRunId, transcript };
      },
    });

    r.get('/debate/:matchId', {
      schema: {
        tags: ['debate'],
        summary: 'Latest completed debate for a match, in the agreed per-fixture JSON shape',
        params: MatchParams,
        querystring: z.object({ full: z.enum(['true', 'false']).default('false') }),
        response: { 200: Json, 404: ErrorResponseSchema },
      },
      handler: async (req) => {
        const run = await new DebateService(prisma, undefined, oddsConfigured).latest(req.params.matchId);
        if (!run) return { matchId: req.params.matchId, status: 'NOT_DEBATED' };
        const summary = toFixtureJson(run);
        return req.query.full === 'true'
          ? { status: 'DEBATED', debateRunId: run.id, asOf: run.asOf.toISOString(), summary, transcript: run.transcript, picks: run.picks }
          : { status: 'DEBATED', debateRunId: run.id, asOf: run.asOf.toISOString(), ...summary };
      },
    });

    r.get('/debate/runs', {
      schema: {
        tags: ['debate'],
        querystring: z.object({ dataEnvironment: Env.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }),
        response: { 200: Json },
      },
      handler: async (req) => {
        const runs = await prisma.debateRun.findMany({
          where: { dataEnvironment: req.query.dataEnvironment },
          orderBy: { startedAt: 'desc' },
          take: req.query.limit,
          include: {
            match: { select: { matchDate: true, status: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } } },
            picks: { select: { market: true, recommendation: true, confidence: true, edge: true, stakePct: true, result: { select: { wasCorrect: true, brier: true } } } },
          },
        });
        return {
          items: runs.map((run) => ({
            id: run.id,
            matchId: run.matchId,
            fixture: `${run.match.homeTeam.name} vs ${run.match.awayTeam.name}`,
            kickoff: run.match.matchDate.toISOString(),
            matchStatus: run.match.status,
            dataEnvironment: run.dataEnvironment,
            status: run.status,
            asOf: run.asOf.toISOString(),
            startedAt: run.startedAt.toISOString(),
            errorMessage: run.errorMessage,
            picks: run.picks,
          })),
        };
      },
    });

    r.get('/debate/bookkeeper', {
      schema: {
        tags: ['debate'],
        summary: 'Running accuracy, calibration by confidence, ROI at flat stake, and per-agent accuracy',
        querystring: z.object({ dataEnvironment: Env.optional() }),
        response: { 200: Json },
      },
      handler: async (req) => new DebateSettlementService(prisma).report({ dataEnvironment: req.query.dataEnvironment }),
    });

    r.post('/debate/settle', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['debate'],
        summary: 'Score every debate pick whose match has finished (append-only; picks are never rewritten)',
        body: z.object({ dataEnvironment: Env.optional() }).default({}),
        response: { 200: Json },
      },
      handler: async (req) => ({ ...(await new DebateSettlementService(prisma).settlePending({ dataEnvironment: req.body.dataEnvironment })) }),
    });

    r.get('/debate/odds/:matchId', {
      schema: {
        tags: ['debate'],
        summary: 'Odds snapshots stored for a match, with the de-vigged probabilities derived from them',
        params: MatchParams,
        response: { 200: Json, 404: ErrorResponseSchema },
      },
      handler: async (req) => {
        if ((await prisma.match.count({ where: { id: req.params.matchId } })) === 0) throw new NotFoundError('Match', req.params.matchId);
        const rows = await prisma.oddsSnapshot.findMany({ where: { matchId: req.params.matchId }, orderBy: { capturedAt: 'desc' } });
        return {
          matchId: req.params.matchId,
          providerConfigured: oddsConfigured,
          note: oddsConfigured ? null : 'No odds provider is configured, so COPYCAT has no market baseline and every edge is reported as null.',
          items: rows.map((o) => ({ id: o.id, market: o.market, source: o.source, bookmaker: o.bookmaker, capturedAt: o.capturedAt.toISOString(), prices: o.prices, overround: o.overround, implied: o.implied, method: o.method })),
        };
      },
    });
  };
}
