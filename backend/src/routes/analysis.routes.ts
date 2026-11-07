import type { DataEnvironment, PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { EvaluationEngine } from '../evaluation/evaluation.engine.js';
import { LearningService } from '../learning/learning.service.js';
import { ModelRegistry } from '../learning/model-registry.js';
import { AnalysisService } from '../services/analysis.service.js';
import { DataQualityService } from '../services/data-quality.service.js';
import type { FormService } from '../services/form.service.js';
import { ErrorResponseSchema, IdParamsSchema } from '../types/api.js';
import { DATA_UNAVAILABLE, orUnavailable } from '../utils/data-availability.js';
import { NotFoundError } from '../utils/errors.js';

const Env = z.enum(['SYNTHETIC', 'HISTORICAL', 'LIVE']);
// z.coerce.boolean() would turn the string "false" into true.
const QueryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
// Analysis outputs are large nested documents already validated by their producers; responses are passed through as JSON.
const Json = z.record(z.string(), z.unknown());
const VersionParams = z.object({ version: z.string().min(1).max(40) });

export function analysisRoutes(prisma: PrismaClient, forms: FormService) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const registry = new ModelRegistry(prisma);
    const evaluation = new EvaluationEngine(prisma);

    r.get('/matches/:id/availability', {
      schema: { tags: ['analysis'], summary: 'Unavailable players and their estimated impact, as known now (or before kickoff)', params: IdParamsSchema, response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => forms.matchAvailability(req.params.id),
    });

    r.get('/matches/:id/stats', {
      schema: { tags: ['matches'], summary: 'Team and player statistics as stored (missing values are DATA UNAVAILABLE)', params: IdParamsSchema, response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const match = await prisma.match.findUnique({
          where: { id: req.params.id },
          include: { stats: true, playerStats: { include: { player: { select: { name: true, position: true } } } }, homeTeam: { select: { id: true, name: true } }, awayTeam: { select: { id: true, name: true } } },
        });
        if (!match) throw new NotFoundError('Match', req.params.id);
        const line = (teamId: string) => {
          const s = match.stats.find((x) => x.teamId === teamId);
          if (!s) return DATA_UNAVAILABLE;
          return Object.fromEntries(
            (['goals', 'possession', 'shots', 'shotsOnTarget', 'shotsOffTarget', 'blockedShots', 'corners', 'yellowCards', 'redCards', 'fouls', 'offsides', 'goalkeeperSaves', 'passes', 'passesAccurate', 'passAccuracy'] as const).map((k) => [k, orUnavailable(s[k])]),
          );
        };
        const provenance = (teamId: string) => {
          const s = match.stats.find((x) => x.teamId === teamId);
          return s ? { source: s.source, sourceId: s.sourceId, lastUpdated: s.lastUpdated.toISOString(), dataEnvironment: match.dataEnvironment } : null;
        };
        const players = (teamId: string) =>
          match.playerStats
            .filter((p) => p.teamId === teamId)
            .map((p) => ({ playerId: p.playerId, name: p.player.name, position: p.player.position, started: p.started, minutes: p.minutes, rating: orUnavailable(p.rating), goals: orUnavailable(p.goals), assists: orUnavailable(p.assists), shots: orUnavailable(p.shots), shotsOnTarget: orUnavailable(p.shotsOnTarget), passes: orUnavailable(p.passes), tackles: orUnavailable(p.tackles), interceptions: orUnavailable(p.interceptions), fouls: orUnavailable(p.fouls), yellowCards: orUnavailable(p.yellowCards), redCards: orUnavailable(p.redCards), source: p.source, sourceId: p.sourceId, lastUpdated: p.lastUpdated.toISOString() }));
        return {
          matchId: match.id,
          status: match.status,
          source: match.source,
          dataEnvironment: match.dataEnvironment,
          home: { team: match.homeTeam, stats: match.status === 'FINISHED' ? line(match.homeTeamId) : null, provenance: provenance(match.homeTeamId), players: players(match.homeTeamId) },
          away: { team: match.awayTeam, stats: match.status === 'FINISHED' ? line(match.awayTeamId) : null, provenance: provenance(match.awayTeamId), players: players(match.awayTeamId) },
        };
      },
    });

    r.get('/matches/:id/analysis', {
      schema: { tags: ['analysis'], summary: 'Latest completed analysis (prospective preferred over backtests)', params: IdParamsSchema, response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const run = await new AnalysisService(prisma).latest(req.params.id);
        if (!run) return { matchId: req.params.id, status: 'NOT_ANALYSED' };
        return {
          matchId: req.params.id,
          status: 'ANALYSED',
          analysisRunId: run.id,
          mode: run.isSimulation ? 'BACKTEST' : 'PROSPECTIVE',
          modelVersion: run.modelVersion.version,
          asOf: run.asOf.toISOString(),
          analysis: run.output,
          predictions: run.predictions.map((p) => ({
            target: p.target,
            predictedValue: p.predictedValue,
            predictedLabel: p.predictedLabel,
            probabilities: p.probabilities,
            confidence: p.confidence,
            result: p.result ? { actualValue: p.result.actualValue, actualLabel: p.result.actualLabel, error: p.result.error, absoluteError: p.result.absoluteError, wasCorrect: p.result.wasCorrect } : null,
          })),
        };
      },
    });

    r.post('/analysis/:matchId/run', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['analysis'], summary: 'Run an analysis now: prospective before kickoff, a backtest at the pre-kickoff cutoff afterwards', params: z.object({ matchId: z.string().min(1).max(100) }), response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const result = await prisma.$transaction((tx) => new AnalysisService(tx).run(req.params.matchId), { timeout: 60_000 });
        const { vector: _vector, ...rest } = result;
        return rest;
      },
    });

    r.get('/models', {
      schema: { tags: ['models'], summary: 'All model versions with lineage and weights', querystring: z.object({ dataEnvironment: Env.optional() }), response: { 200: Json } },
      handler: async (req) => {
        const versions = await prisma.modelVersion.findMany({
          where: req.query.dataEnvironment ? { OR: [{ dataEnvironment: req.query.dataEnvironment }, { dataEnvironment: null }] } : undefined,
          include: { featureWeights: true, parent: { select: { version: true } } },
          orderBy: { createdAt: 'asc' },
        });
        const active = Object.fromEntries(await Promise.all((['SYNTHETIC', 'HISTORICAL', 'LIVE'] as DataEnvironment[]).map(async (e) => [e, (await registry.activeFor(e)).version])));
        return {
          activeByEnvironment: active,
          items: versions.map((v) => ({
            version: v.version,
            status: v.status,
            dataEnvironment: v.dataEnvironment,
            parent: v.parent?.version ?? null,
            simulationRunId: v.simulationRunId,
            trainingWindow: v.trainingWindowStart ? { start: v.trainingWindowStart.toISOString(), end: v.trainingWindowEnd?.toISOString() ?? null } : null,
            matchesEvaluated: v.matchesEvaluated,
            notes: v.notes,
            createdAt: v.createdAt.toISOString(),
            activatedAt: v.activatedAt?.toISOString() ?? null,
            retiredAt: v.retiredAt?.toISOString() ?? null,
            weights: v.featureWeights.map((w) => ({ feature: w.feature, weight: w.weight, previousWeight: w.previousWeight, reason: w.reason, confidence: w.confidence })),
          })),
        };
      },
    });

    r.get('/models/:version', {
      schema: { tags: ['models'], params: VersionParams, response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const v = await registry.byVersion(req.params.version);
        const [weights, parent, children, events] = await Promise.all([
          prisma.featureWeight.findMany({ where: { modelVersionId: v.id } }),
          v.parentVersionId ? prisma.modelVersion.findUnique({ where: { id: v.parentVersionId }, select: { version: true } }) : null,
          prisma.modelVersion.findMany({ where: { parentVersionId: v.id }, select: { version: true, status: true } }),
          prisma.learningEvent.findMany({ where: { OR: [{ fromVersionId: v.id }, { toVersionId: v.id }] }, orderBy: { createdAt: 'asc' } }),
        ]);
        return { ...v, parent: parent?.version ?? null, children, weights, learningEvents: events };
      },
    });

    r.get('/models/:version/metrics', {
      schema: { tags: ['models'], params: VersionParams, querystring: z.object({ dataEnvironment: Env.optional(), includeSimulations: QueryBool.default(true) }), response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const v = await registry.byVersion(req.params.version);
        const [stored, live] = await Promise.all([
          prisma.modelMetric.findMany({ where: { modelVersionId: v.id, dataEnvironment: req.query.dataEnvironment }, orderBy: { createdAt: 'asc' } }),
          evaluation.performance({ modelVersionId: v.id, dataEnvironment: req.query.dataEnvironment, includeSimulations: req.query.includeSimulations }),
        ]);
        return { version: v.version, dataEnvironment: v.dataEnvironment, recordedMetrics: stored, forecastPerformance: live };
      },
    });

    r.get('/model/performance', {
      schema: { tags: ['models'], summary: 'Performance of evaluated forecasts, per target, with sample sizes (LIVE defaults to forecasts made before kickoff only)', querystring: z.object({ dataEnvironment: Env.default('HISTORICAL'), includeSimulations: QueryBool.optional(), simulationRunId: z.string().max(40).optional() }), response: { 200: Json } },
      handler: async (req) => {
        const env = req.query.dataEnvironment;
        const includeSimulations = req.query.includeSimulations ?? env !== 'LIVE';
        const perf = await evaluation.performance({ dataEnvironment: env, includeSimulations, simulationRunId: req.query.simulationRunId });
        return { dataEnvironment: env, currentModel: (await registry.activeFor(env)).version, isEvidenceOfRealPerformance: env !== 'SYNTHETIC', includesBacktests: includeSimulations, ...perf };
      },
    });

    r.get('/learning-events', {
      schema: { tags: ['learning'], querystring: z.object({ dataEnvironment: Env.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), response: { 200: Json } },
      handler: async (req) => {
        const events = await prisma.learningEvent.findMany({
          where: { dataEnvironment: req.query.dataEnvironment },
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
          include: { fromVersion: { select: { version: true } }, toVersion: { select: { version: true } } },
        });
        return { items: events.map((e) => ({ ...e, fromVersion: e.fromVersion?.version ?? null, toVersion: e.toVersion?.version ?? null })) };
      },
    });

    r.post('/model/evaluate', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['learning'], summary: 'Compare every pending forecast for a finished match with the actual result', body: z.object({ dataEnvironment: Env.optional() }).default({}), response: { 200: Json } },
      handler: async (req) => evaluation.evaluatePending({ dataEnvironment: req.body.dataEnvironment }),
    });

    r.post('/model/learn', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['learning'], summary: 'Propose and validate a weight change from evaluated non-simulation forecasts (guardrails apply)', body: z.object({ dataEnvironment: Env }), response: { 200: Json } },
      handler: async (req) => prisma.$transaction((tx) => new LearningService(tx).learn(req.body.dataEnvironment), { timeout: 300_000 }),
    });

    r.post('/model/rollback', {
      preHandler: app.auth.require,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['learning'], summary: 'Revert an environment to the previous model version (nothing is deleted)', body: z.object({ dataEnvironment: Env, reason: z.string().min(5).max(500) }), response: { 200: Json, 409: ErrorResponseSchema } },
      handler: async (req) => {
        const { from, to } = await prisma.$transaction((tx) => new ModelRegistry(tx).rollback(req.body.dataEnvironment, req.body.reason));
        return { dataEnvironment: req.body.dataEnvironment, from: from.version, to: to.version };
      },
    });

    r.get('/simulations', {
      schema: { tags: ['learning'], response: { 200: Json } },
      handler: async () => ({ items: await prisma.simulationRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }) }),
    });

    r.get('/data/quality', {
      schema: { tags: ['data'], summary: 'Dataset integrity checks and statistics coverage', response: { 200: Json } },
      handler: async () => new DataQualityService(prisma).report(),
    });

    r.get('/players/:id', {
      schema: { tags: ['teams'], params: IdParamsSchema, response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const player = await prisma.player.findUnique({ where: { id: req.params.id }, include: { team: { select: { id: true, name: true } } } });
        if (!player) throw new NotFoundError('Player', req.params.id);
        const [impacts, recent, availability] = await Promise.all([
          forms.teamPlayerImpacts(player.teamId),
          prisma.playerMatchStats.findMany({ where: { playerId: player.id }, include: { match: { select: { matchDate: true, homeTeamId: true, homeScore: true, awayScore: true } } }, orderBy: { match: { matchDate: 'desc' } }, take: 10 }),
          prisma.playerAvailability.findMany({ where: { playerId: player.id }, orderBy: { reportedAt: 'desc' }, take: 5 }),
        ]);
        return {
          id: player.id,
          name: player.name,
          position: player.position,
          team: player.team,
          source: player.source,
          impact: impacts.players.find((p) => p.player.id === player.id) ?? { status: DATA_UNAVAILABLE, limitations: impacts.limitations },
          recentMatches: recent.map((s) => ({ matchId: s.matchId, matchDate: s.match.matchDate.toISOString(), started: s.started, minutes: s.minutes, goals: orUnavailable(s.goals), assists: orUnavailable(s.assists), shots: orUnavailable(s.shots) })),
          availabilityHistory: availability.map((a) => ({ matchId: a.matchId, status: a.status, reason: a.reason, reportedAt: a.reportedAt.toISOString() })),
        };
      },
    });
  };
}
