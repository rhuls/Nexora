import type { DataEnvironment } from '@prisma/client';
import { analyzeAvailability } from '../analysis/availability.analyzer.js';
import { analyzeForm, type FormAnalysis } from '../analysis/form.analyzer.js';
import { analyzePlayerImpacts } from '../analysis/player-impact.analyzer.js';
import { analyzeHeadToHead, type H2HAnalysis } from '../analysis/h2h.analyzer.js';
import { analyzeHomeAway, type HomeAwayAnalysis } from '../analysis/home-away.analyzer.js';
import type { KnowledgeService, PointInTime } from '../data/knowledge/knowledge.service.js';

export interface TeamFormBundle {
  overall: FormAnalysis;
  homeAway: HomeAwayAnalysis;
}

export interface MatchFormResponse {
  matchId: string;
  cutoff: string;
  dataEnvironment: DataEnvironment;
  home: TeamFormBundle;
  away: TeamFormBundle;
}

export class InvalidAsOfError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAsOfError';
  }
}

export class FormService {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async bundle(team: { id: string; name: string }, pit: PointInTime, window: number): Promise<TeamFormBundle> {
    const [all, home, away] = await Promise.all([
      this.knowledge.teamHistory(team.id, pit, window),
      this.knowledge.teamHistory(team.id, pit, window, 'HOME'),
      this.knowledge.teamHistory(team.id, pit, window, 'AWAY'),
    ]);
    const common = { team, window, cutoff: pit.cutoff, environments: pit.environments };
    return {
      overall: analyzeForm({ ...common, scope: 'ALL', results: all.results }),
      homeAway: analyzeHomeAway({ ...common, homeResults: home.results, awayResults: away.results }),
    };
  }

  async matchForm(matchId: string, window: number): Promise<MatchFormResponse> {
    const { match, pit } = await this.knowledge.matchPointInTime(matchId);
    const [home, away] = await Promise.all([this.bundle(match.homeTeam, pit, window), this.bundle(match.awayTeam, pit, window)]);
    return { matchId, cutoff: pit.cutoff.toISOString(), dataEnvironment: match.dataEnvironment, home, away };
  }

  async matchHeadToHead(matchId: string, limit: number, halfLifeDays: number): Promise<H2HAnalysis & { matchId: string }> {
    const { match, pit } = await this.knowledge.matchPointInTime(matchId);
    const history = await this.knowledge.headToHeadHistory(match.headToHeadId, match.homeTeamId, pit, limit);
    return { matchId, ...analyzeHeadToHead({ subjectHome: match.homeTeam, subjectAway: match.awayTeam, meetings: history.results, limit, halfLifeDays, cutoff: pit.cutoff, environments: pit.environments }) };
  }

  async matchAvailability(matchId: string, lookback = 20) {
    const { match, pit } = await this.knowledge.matchPointInTime(matchId, this.now());
    const [reports, homeHistory, awayHistory] = await Promise.all([
      this.knowledge.availabilityAt(match.id, pit.cutoff),
      this.knowledge.playerHistory(match.homeTeamId, pit, lookback),
      this.knowledge.playerHistory(match.awayTeamId, pit, lookback),
    ]);
    const homeImpacts = analyzePlayerImpacts(match.homeTeamId, homeHistory, lookback);
    const awayImpacts = analyzePlayerImpacts(match.awayTeamId, awayHistory, lookback);
    return {
      matchId,
      cutoff: pit.cutoff.toISOString(),
      reportsIgnoredAfterCutoff: reports.ignoredAfterCutoff,
      home: { availability: analyzeAvailability(match.homeTeam, reports.reports, homeImpacts), impacts: homeImpacts },
      away: { availability: analyzeAvailability(match.awayTeam, reports.reports, awayImpacts), impacts: awayImpacts },
    };
  }

  async teamPlayerImpacts(teamId: string, lookback = 20) {
    const { pit } = await this.knowledge.teamPointInTime(teamId, this.now());
    return analyzePlayerImpacts(teamId, await this.knowledge.playerHistory(teamId, pit, lookback), lookback);
  }

  async teamForm(teamId: string, window: number, asOf?: Date): Promise<TeamFormBundle & { teamId: string; asOf: string }> {
    const now = this.now();
    if (asOf && asOf.getTime() > now.getTime()) throw new InvalidAsOfError('asOf cannot be in the future');
    const at = asOf ?? now;
    const { team, pit } = await this.knowledge.teamPointInTime(teamId, at);
    return { teamId, asOf: at.toISOString(), ...(await this.bundle(team, pit, window)) };
  }
}
