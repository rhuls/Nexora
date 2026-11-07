import type { Prisma, PrismaClient } from '@prisma/client';

export type TeamWithCompetition = Prisma.TeamGetPayload<{
  include: { competition: { select: { id: true; name: true } }; _count: { select: { players: true } } };
}>;

export class TeamRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<TeamWithCompetition | null> {
    return this.prisma.team.findUnique({
      where: { id },
      include: { competition: { select: { id: true, name: true } }, _count: { select: { players: true } } },
    });
  }

  exists(id: string): Promise<boolean> {
    return this.prisma.team.count({ where: { id } }).then((n) => n > 0);
  }

  list(competitionId?: string) {
    return this.prisma.team.findMany({
      where: { competitionId },
      select: { id: true, name: true, shortName: true, country: true, competitionId: true, source: true },
      orderBy: { name: 'asc' },
    });
  }

  findPlayers(teamId: string) {
    return this.prisma.player.findMany({
      where: { teamId },
      select: { id: true, name: true, position: true },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }
}
