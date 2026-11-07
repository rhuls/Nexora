import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { API_FOOTBALL_SOURCE, loadApiFootballConfig } from '../config/api-football.js';
import { ErrorResponseSchema, IdParamsSchema } from '../types/api.js';
import { NotFoundError } from '../utils/errors.js';

const Json = z.record(z.string(), z.unknown());

// Configuration status only: whether a key is present, never any part of it.
export function apiFootballConfigured(): { configured: boolean; dailyBudget: number | null; configurationError: string | null } {
  try {
    const config = loadApiFootballConfig();
    return { configured: config.key !== null, dailyBudget: config.dailyBudget, configurationError: null };
  } catch (error) {
    return { configured: false, dailyBudget: null, configurationError: error instanceof Error ? error.message : String(error) };
  }
}

export async function providerStatus(prisma: PrismaClient, now: Date = new Date()) {
  const source = API_FOOTBALL_SOURCE;
  const day = now.toISOString().slice(0, 10);
  const [usage, coverage, lastRun, lastSuccess, links, conflicts, withDetails] = await Promise.all([
    prisma.providerUsage.findUnique({ where: { source_day: { source, day } } }),
    prisma.providerCoverage.findMany({ where: { source }, orderBy: [{ seasonSourceId: 'asc' }, { dataset: 'asc' }] }),
    prisma.importRun.findFirst({ where: { source }, orderBy: { startedAt: 'desc' } }),
    prisma.importRun.findFirst({ where: { source, status: 'COMPLETED' }, orderBy: { startedAt: 'desc' } }),
    prisma.externalMatchLink.count({ where: { source } }),
    prisma.externalMatchLink.count({ where: { source, conflict: { not: Prisma.DbNull } } }),
    prisma.externalMatchLink.count({ where: { source, detailsFetchedAt: { not: null } } }),
  ]);
  return {
    source,
    role: 'enrichment',
    backbone: 'openfootball',
    ...apiFootballConfigured(),
    usageToday: usage
      ? {
          day,
          requests: usage.requests,
          remainingReportedByProvider: usage.remaining,
          dailyLimitReportedByProvider: usage.dailyLimit,
          errors: usage.errors,
          rateLimited: usage.rateLimited,
          cacheHits: usage.cacheHits,
          cacheMisses: usage.cacheMisses,
          lastRequestAt: usage.lastRequestAt?.toISOString() ?? null,
          lastSuccessAt: usage.lastSuccessAt?.toISOString() ?? null,
          lastError: usage.lastError,
        }
      : { day, requests: 0 },
    coverage: coverage.map((c) => ({ competition: c.competitionSourceId, season: c.seasonSourceId, dataset: c.dataset, available: c.available, reason: c.reason, checkedAt: c.checkedAt.toISOString() })),
    lastRun: lastRun ? { id: lastRun.id, dataset: lastRun.dataset, status: lastRun.status, startedAt: lastRun.startedAt.toISOString(), completedAt: lastRun.completedAt?.toISOString() ?? null, errorMessage: lastRun.errorMessage } : null,
    lastSuccessfulRunAt: lastSuccess?.startedAt.toISOString() ?? null,
    fixtureLinks: { total: links, enriched: withDetails, resultConflicts: conflicts },
  };
}

export function enrichmentRoutes(prisma: PrismaClient) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    const requireMatch = async (id: string) => {
      const match = await prisma.match.findUnique({ where: { id }, select: { id: true, status: true, dataEnvironment: true, homeTeamId: true, awayTeamId: true } });
      if (!match) throw new NotFoundError('Match', id);
      return match;
    };

    r.get('/matches/:id/events', {
      schema: { tags: ['matches'], summary: 'Match events (goals, cards, substitutions) with provenance', params: IdParamsSchema, response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const match = await requireMatch(req.params.id);
        const events = await prisma.matchEvent.findMany({ where: { matchId: match.id }, orderBy: [{ minute: 'asc' }, { extraMinute: 'asc' }, { createdAt: 'asc' }] });
        return {
          matchId: match.id,
          dataEnvironment: match.dataEnvironment,
          status: events.length > 0 ? 'REPORTED' : 'DATA UNAVAILABLE',
          items: events.map((e) => ({
            teamId: e.teamId,
            side: e.teamId === match.homeTeamId ? 'HOME' : e.teamId === match.awayTeamId ? 'AWAY' : null,
            type: e.type,
            detail: e.detail,
            minute: e.minute,
            extraMinute: e.extraMinute,
            player: e.playerName,
            relatedPlayer: e.relatedPlayerName,
            comments: e.comments,
            source: e.source,
            sourceId: e.sourceId,
            lastUpdated: e.lastUpdated.toISOString(),
          })),
        };
      },
    });

    r.get('/matches/:id/lineups', {
      schema: { tags: ['matches'], summary: 'Starting line-ups and substitutes with provenance', params: IdParamsSchema, response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const match = await requireMatch(req.params.id);
        const lineups = await prisma.matchLineup.findMany({ where: { matchId: match.id } });
        const side = (teamId: string) => {
          const l = lineups.find((x) => x.teamId === teamId);
          return l ? { formation: l.formation, coach: l.coachName, startXI: l.startXI, substitutes: l.substitutes, source: l.source, sourceId: l.sourceId, lastUpdated: l.lastUpdated.toISOString() } : 'DATA UNAVAILABLE';
        };
        return { matchId: match.id, dataEnvironment: match.dataEnvironment, home: side(match.homeTeamId), away: side(match.awayTeamId) };
      },
    });

    r.get('/matches/:id/availability/reports', {
      schema: {
        tags: ['matches'],
        summary: 'Every stored availability report (append-only). Players without a report are UNKNOWN, not AVAILABLE.',
        params: IdParamsSchema,
        response: { 200: Json, 404: ErrorResponseSchema },
      },
      handler: async (req) => {
        const match = await requireMatch(req.params.id);
        const rows = await prisma.playerAvailability.findMany({
          where: { matchId: match.id },
          orderBy: [{ reportedAt: 'desc' }, { id: 'asc' }],
          include: { player: { select: { id: true, name: true, teamId: true, position: true } } },
        });
        return {
          matchId: match.id,
          dataEnvironment: match.dataEnvironment,
          note: 'Absence of a report means availability is UNKNOWN. reportedAt is when Nexora learned of the report; only reports before a cutoff inform a forecast.',
          items: rows.map((a) => ({
            player: a.player,
            status: a.status,
            reason: a.reason,
            sourceStatus: a.sourceStatus,
            expectedReturn: a.expectedReturn?.toISOString() ?? null,
            reportedAt: a.reportedAt.toISOString(),
            source: a.source,
            sourceId: a.sourceId,
          })),
        };
      },
    });

    r.get('/matches/:id/sources', {
      schema: { tags: ['matches'], summary: 'Which provider fixtures are linked to this match, how they were matched, and any result conflict', params: IdParamsSchema, response: { 200: Json, 404: ErrorResponseSchema } },
      handler: async (req) => {
        const match = await requireMatch(req.params.id);
        const links = await prisma.externalMatchLink.findMany({ where: { matchId: match.id } });
        return {
          matchId: match.id,
          dataEnvironment: match.dataEnvironment,
          links: links.map((l) => ({
            source: l.source,
            sourceId: l.sourceId,
            matchedBy: l.matchedBy,
            kickoffDeltaMinutes: l.kickoffDeltaMinutes,
            sourceStatus: l.sourceStatus,
            sourceScore: { home: l.sourceHomeScore, away: l.sourceAwayScore },
            conflict: l.conflict,
            detailsFetchedAt: l.detailsFetchedAt?.toISOString() ?? null,
            lastUpdated: l.lastUpdated.toISOString(),
          })),
        };
      },
    });

    r.get('/data/providers', {
      schema: { tags: ['data'], summary: 'Enrichment provider health: configuration, request budget, coverage, last run', response: { 200: Json } },
      handler: async () => ({ asOf: new Date().toISOString(), providers: [await providerStatus(prisma)] }),
    });
  };
}
