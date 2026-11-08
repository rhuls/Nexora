import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { AuthGuard, authStatus, loadAuthConfig, registerAuth } from './config/auth.js';
import type { Env } from './config/env.js';
import { createOddsProvider, createProviderRegistry } from './config/providers.js';
import { MatchController } from './controllers/match.controller.js';
import { TeamController } from './controllers/team.controller.js';
import { ImportService } from './data/import/import.service.js';
import { KnowledgeService } from './data/knowledge/knowledge.service.js';
import { CompetitionRepository } from './repositories/competition.repository.js';
import { MatchRepository } from './repositories/match.repository.js';
import { TeamRepository } from './repositories/team.repository.js';
import { competitionRoutes } from './routes/competition.routes.js';
import { dataRoutes } from './routes/data.routes.js';
import { blackjackRoutes } from './routes/blackjack.routes.js';
import { debateRoutes } from './routes/debate.routes.js';
import { enrichmentRoutes } from './routes/enrichment.routes.js';
import { analysisRoutes } from './routes/analysis.routes.js';
import { formRoutes } from './routes/form.routes.js';
import { FormService } from './services/form.service.js';
import { importRoutes } from './routes/import.routes.js';
import { matchRoutes } from './routes/match.routes.js';
import { syncRoutes } from './routes/sync.routes.js';
import { teamRoutes } from './routes/team.routes.js';
import { MatchService } from './services/match.service.js';
import { TeamService } from './services/team.service.js';
import { errorHandler } from './utils/errors.js';
import { registerMetrics } from './utils/metrics.js';

export async function buildApp(env: Env, prisma: PrismaClient): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  await app.register(helmet, { contentSecurityPolicy: false });
  const origins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter((o) => o.length > 0);
  if (origins.length > 0) await app.register(cors, { origin: origins });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: { info: { title: 'Nexora API', description: 'Understand the game through data.', version: '0.1.0' } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Decorated before any route registers, so every handler can reach it.
  registerAuth(app, new AuthGuard(loadAuthConfig()));

  registerMetrics(app);

  app.get('/health', { schema: { hide: true } }, async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok', ...authStatus(app.auth) };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  const matchController = new MatchController(new MatchService(new MatchRepository(prisma)), new KnowledgeService(prisma));
  const teamController = new TeamController(new TeamService(new TeamRepository(prisma)));
  const importService = new ImportService(prisma, createProviderRegistry(prisma));

  await app.register(
    async (api) => {
      await api.register(competitionRoutes(new CompetitionRepository(prisma)));
      await api.register(dataRoutes(prisma));
      await api.register(enrichmentRoutes(prisma));
      await api.register(matchRoutes(matchController));
      await api.register(teamRoutes(teamController));
      await api.register(importRoutes(importService));
      const formService = new FormService(new KnowledgeService(prisma));
      await api.register(formRoutes(formService));
      await api.register(analysisRoutes(prisma, formService));
      // The debate layer reads the analysis pipeline and writes only its own tables.
      await api.register(debateRoutes(prisma, createOddsProvider(prisma)?.isConfigured() ?? false));
      // Self-contained solver: no database, no football data, no shared state.
      await api.register(blackjackRoutes());
      await api.register(syncRoutes(prisma));
    },
    { prefix: '/api' },
  );

  return app;
}
