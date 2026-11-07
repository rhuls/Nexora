import type { TeamRepository } from '../repositories/team.repository.js';
import type { TeamDetail, TeamPlayersResponse } from '../types/api.js';
import { NotFoundError } from '../utils/errors.js';

export class TeamService {
  constructor(private readonly teams: TeamRepository) {}

  async list(competitionId?: string) {
    return { items: await this.teams.list(competitionId) };
  }

  async getById(id: string): Promise<TeamDetail> {
    const team = await this.teams.findById(id);
    if (!team) throw new NotFoundError('Team', id);
    return {
      id: team.id,
      name: team.name,
      shortName: team.shortName,
      country: team.country,
      competition: team.competition,
      squadSize: team._count.players,
    };
  }

  async getPlayers(teamId: string): Promise<TeamPlayersResponse> {
    if (!(await this.teams.exists(teamId))) throw new NotFoundError('Team', teamId);
    return { teamId, players: await this.teams.findPlayers(teamId) };
  }
}
