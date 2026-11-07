import type { PrismaClient } from '@prisma/client';

export class CompetitionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list() {
    return this.prisma.competition.findMany({
      orderBy: [{ dataEnvironment: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { teams: true, matches: true } } },
    });
  }

  matchesByEnvironment() {
    return this.prisma.match.groupBy({ by: ['competitionId', 'dataEnvironment'], _count: { _all: true } });
  }
}
