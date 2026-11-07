import type { DataEnvironment } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KnowledgeService } from '../data/knowledge/knowledge.service.js';
import type { MatchService } from '../services/match.service.js';
import type { MatchListQuery } from '../types/api.js';

export class MatchController {
  constructor(
    private readonly matches: MatchService,
    private readonly knowledge: KnowledgeService,
  ) {}

  knowledgeBeforeKickoff = async (request: FastifyRequest<{ Params: { id: string }; Querystring: { formWindow: number; h2hWindow: number } }>, _reply: FastifyReply) =>
    this.knowledge.reconstruct(request.params.id, request.query);

  today = async (request: FastifyRequest<{ Querystring: { timeZone: string; dataEnvironment?: DataEnvironment } }>, _reply: FastifyReply) =>
    this.matches.today(request.query.timeZone, request.query.dataEnvironment);

  upcoming = async (request: FastifyRequest<{ Querystring: { days: number; dataEnvironment?: DataEnvironment } }>, _reply: FastifyReply) =>
    this.matches.upcoming(request.query.days, request.query.dataEnvironment);

  revisions = async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => this.matches.revisions(request.params.id);

  list = async (request: FastifyRequest<{ Querystring: MatchListQuery }>, _reply: FastifyReply) => this.matches.list(request.query);

  getById = async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => this.matches.getById(request.params.id);
}
