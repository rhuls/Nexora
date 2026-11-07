import { generateDataset, type SeedDataset } from '../../data/synthetic/generator.js';
import { COMPETITION } from '../../data/synthetic/reference.js';
import type {
  DatasetRef,
  IDataProvider,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderCompetition,
  ProviderMatch,
  ProviderMatchTeamStats,
  ProviderPlayer,
  ProviderPlayerMatchStats,
  ProviderSeason,
  ProviderStanding,
  ProviderTeam,
  ProviderTeamRef,
  SourceResult,
} from '../types.js';

export const MOCK_SOURCE = 'nexora-seed';

const CAPABILITIES: ProviderCapabilities = {
  matches: true,
  matchStats: true,
  players: true,
  playerStats: true,
  availability: true,
  standings: false,
};

// Serves the deterministic synthetic development league. Everything it returns is SYNTHETIC by definition.
export class MockFootballProvider implements IDataProvider {
  readonly source = MOCK_SOURCE;
  readonly capabilities = CAPABILITIES;
  private dataset: SeedDataset | null = null;

  private data(): SeedDataset {
    this.dataset ??= generateDataset();
    return this.dataset;
  }

  private ok<T>(data: T): SourceResult<T> {
    return { available: true, data, warnings: [] };
  }

  private teamRef(teamId: string): { sourceId: string; name: string } {
    const team = this.data().teams.find((t) => t.id === teamId);
    if (!team) throw new Error(`Unknown synthetic team ${teamId}`);
    return { sourceId: team.id, name: team.name };
  }

  async getCompetitions(): Promise<SourceResult<ProviderCompetition[]>> {
    return this.ok([{ sourceId: COMPETITION.id, code: COMPETITION.code, name: COMPETITION.name, country: COMPETITION.country }]);
  }

  async getSeason(ref: DatasetRef): Promise<SourceResult<ProviderSeason>> {
    const season = this.data().seasons.find((s) => s.id === ref.seasonSourceId);
    if (!season) return { available: false, reason: `Unknown synthetic season ${ref.seasonSourceId}` };
    return this.ok({ sourceId: season.id, competitionSourceId: season.competitionId, name: season.name, startDate: season.startDate, endDate: season.endDate });
  }

  async getTeams(): Promise<SourceResult<ProviderTeam[]>> {
    return this.ok(this.data().teams.map((t) => ({ sourceId: t.id, name: t.name, shortName: t.shortName, country: t.country })));
  }

  async getPlayers(_ref: DatasetRef, team: ProviderTeamRef): Promise<SourceResult<ProviderPlayer[]>> {
    return this.ok(
      this.data()
        .players.filter((p) => p.teamId === team.sourceId)
        .map((p) => ({ sourceId: p.id, teamSourceId: p.teamId, name: p.name, position: p.position })),
    );
  }

  async getMatches(ref: DatasetRef): Promise<SourceResult<ProviderMatch[]>> {
    return this.ok(
      this.data()
        .matches.filter((m) => m.competitionId === ref.competitionSourceId && m.seasonId === ref.seasonSourceId)
        .map((m) => ({
          sourceId: m.id,
          competitionSourceId: m.competitionId,
          seasonSourceId: m.seasonId,
          round: m.round,
          homeTeam: this.teamRef(m.homeTeamId),
          awayTeam: this.teamRef(m.awayTeamId),
          kickoff: m.matchDate,
          kickoffTimeKnown: true,
          sourceMatchDate: m.matchDate.toISOString(),
          status: m.status,
          homeScore: m.homeScore,
          awayScore: m.awayScore,
          homeHalfTimeScore: null,
          awayHalfTimeScore: null,
        })),
    );
  }

  async getMatch(ref: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderMatch | null>> {
    const all = await this.getMatches(ref);
    if (!all.available) return all;
    return this.ok(all.data.find((m) => m.sourceId === matchSourceId) ?? null);
  }

  async getMatchStats(_ref: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderMatchTeamStats[]>> {
    return this.ok(
      this.data()
        .matchStats.filter((s) => s.matchId === matchSourceId)
        .map((s) => ({ ...s, teamSourceId: s.teamId, teamName: this.teamRef(s.teamId).name })),
    );
  }

  async getPlayerStats(_ref: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderPlayerMatchStats[]>> {
    return this.ok(
      this.data()
        .playerMatchStats.filter((p) => p.matchId === matchSourceId)
        .map((p) => ({
          playerSourceId: p.playerId,
          started: p.started,
          minutes: p.minutes,
          goals: p.goals,
          assists: p.assists,
          shots: p.shots,
          shotsOnTarget: p.shotsOnTarget,
          passes: null,
          tackles: p.tackles,
          interceptions: p.interceptions,
        })),
    );
  }

  async getPlayerAvailability(_ref: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderAvailability[]>> {
    return this.ok(
      this.data()
        .availability.filter((a) => a.matchId === matchSourceId)
        .map((a) => ({ playerSourceId: a.playerId, status: a.status, reason: a.reason, expectedReturn: a.expectedReturn, reportedAt: a.reportedAt })),
    );
  }

  async getStandings(): Promise<SourceResult<ProviderStanding[]>> {
    return { available: false, reason: `${this.source} does not publish standings` };
  }
}
