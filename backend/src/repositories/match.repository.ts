import type { Prisma, PrismaClient } from '@prisma/client';
import type { MatchListQuery } from '../types/api.js';

export const matchSummaryInclude = {
  competition: { select: { id: true, name: true } },
  season: { select: { id: true, name: true } },
  homeTeam: { select: { id: true, name: true, shortName: true } },
  awayTeam: { select: { id: true, name: true, shortName: true } },
} satisfies Prisma.MatchInclude;

export type MatchWithRefs = Prisma.MatchGetPayload<{ include: typeof matchSummaryInclude }>;
export type MatchWithStats = Prisma.MatchGetPayload<{ include: typeof matchSummaryInclude & { stats: true } }>;

export class MatchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: MatchListQuery): Promise<{ total: number; items: MatchWithRefs[] }> {
    const where: Prisma.MatchWhereInput = {
      status: query.status,
      dataEnvironment: query.dataEnvironment,
      seasonId: query.seasonId,
      matchDate: query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
      OR: query.teamId ? [{ homeTeamId: query.teamId }, { awayTeamId: query.teamId }] : undefined,
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.match.count({ where }),
      this.prisma.match.findMany({
        where,
        include: matchSummaryInclude,
        orderBy: [{ matchDate: query.order }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
    ]);
    return { total, items };
  }

  findById(id: string): Promise<MatchWithStats | null> {
    return this.prisma.match.findUnique({
      where: { id },
      include: { ...matchSummaryInclude, stats: true },
    });
  }

  between(from: Date, to: Date, where: Prisma.MatchWhereInput = {}): Promise<MatchWithRefs[]> {
    return this.prisma.match.findMany({
      where: { ...where, matchDate: { gte: from, lt: to } },
      include: matchSummaryInclude,
      orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
    });
  }

  awaitingResult(before: Date, where: Prisma.MatchWhereInput = {}): Promise<MatchWithRefs[]> {
    return this.prisma.match.findMany({
      where: { ...where, status: { in: ['SCHEDULED', 'LIVE'] }, matchDate: { lt: before } },
      include: matchSummaryInclude,
      orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
    });
  }

  revisions(matchId: string) {
    return this.prisma.matchRevision.findMany({ where: { matchId }, orderBy: { createdAt: 'asc' } });
  }

  exists(id: string): Promise<boolean> {
    return this.prisma.match.count({ where: { id } }).then((n) => n > 0);
  }
}
