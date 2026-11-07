import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamService } from '../services/team.service.js';

export class TeamController {
  constructor(private readonly teams: TeamService) {}

  list = async (request: FastifyRequest<{ Querystring: { competitionId?: string } }>, _reply: FastifyReply) => this.teams.list(request.query.competitionId);

  getById = async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => this.teams.getById(request.params.id);

  getPlayers = async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => this.teams.getPlayers(request.params.id);
}
