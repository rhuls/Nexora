import type { DataEnvironment, MatchTeamStats as MatchTeamStatsRow } from '@prisma/client';
import type { MatchRepository, MatchWithRefs } from '../repositories/match.repository.js';
import type { MatchDetail, MatchListQuery, MatchSummary, TeamMatchStats } from '../types/api.js';
import { DATA_UNAVAILABLE, orUnavailable } from '../utils/data-availability.js';
import { NotFoundError } from '../utils/errors.js';
import { DAY_MS, localDayBounds } from '../utils/time.js';

function toSummary(match: MatchWithRefs): MatchSummary {
  return {
    id: match.id,
    matchDate: match.matchDate.toISOString(),
    status: match.status,
    dataEnvironment: match.dataEnvironment,
    round: match.round,
    competition: match.competition,
    season: match.season,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    homeHalfTimeScore: match.homeHalfTimeScore,
    awayHalfTimeScore: match.awayHalfTimeScore,
    provenance: {
      source: match.source,
      sourceId: match.sourceId,
      lastUpdated: match.lastUpdated.toISOString(),
      sourceMatchDate: match.sourceMatchDate,
      kickoffTimeKnown: match.kickoffTimeKnown,
    },
  };
}

function toTeamStats(row: MatchTeamStatsRow): TeamMatchStats {
  return {
    goals: orUnavailable(row.goals),
    possession: orUnavailable(row.possession),
    shots: orUnavailable(row.shots),
    shotsOnTarget: orUnavailable(row.shotsOnTarget),
    corners: orUnavailable(row.corners),
    yellowCards: orUnavailable(row.yellowCards),
    redCards: orUnavailable(row.redCards),
    fouls: orUnavailable(row.fouls),
    offsides: orUnavailable(row.offsides),
    additional: row.additional && typeof row.additional === 'object' && !Array.isArray(row.additional) ? (row.additional as Record<string, unknown>) : null,
  };
}

export class MatchService {
  constructor(
    private readonly matches: MatchRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async today(timeZone: string, dataEnvironment?: DataEnvironment) {
    const { date, start, end } = localDayBounds(this.now(), timeZone);
    const items = await this.matches.between(start, end, { dataEnvironment });
    return { timeZone, date, from: start.toISOString(), to: end.toISOString(), items: items.map(toSummary) };
  }

  async upcoming(days: number, dataEnvironment?: DataEnvironment) {
    const now = this.now();
    const to = new Date(now.getTime() + days * DAY_MS);
    const [upcoming, awaiting] = await Promise.all([
      this.matches.between(now, to, { dataEnvironment, status: { in: ['SCHEDULED', 'LIVE', 'POSTPONED'] } }),
      this.matches.awaitingResult(now, { dataEnvironment }),
    ]);
    return { asOf: now.toISOString(), to: to.toISOString(), upcoming: upcoming.map(toSummary), awaitingResult: awaiting.map(toSummary) };
  }

  async revisions(matchId: string) {
    if (!(await this.matches.exists(matchId))) throw new NotFoundError('Match', matchId);
    const rows = await this.matches.revisions(matchId);
    return {
      matchId,
      items: rows.map((r) => ({
        id: r.id,
        source: r.source,
        importRunId: r.importRunId,
        changes: r.changes as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async list(query: MatchListQuery) {
    const { total, items } = await this.matches.list(query);
    return { total, limit: query.limit, offset: query.offset, items: items.map(toSummary) };
  }

  async getById(id: string): Promise<MatchDetail> {
    const match = await this.matches.findById(id);
    if (!match) throw new NotFoundError('Match', id);

    // Stats only exist once a match is played; a finished match without a stats row is a data gap.
    let stats: MatchDetail['stats'] = null;
    if (match.status === 'FINISHED') {
      const home = match.stats.find((s) => s.teamId === match.homeTeamId);
      const away = match.stats.find((s) => s.teamId === match.awayTeamId);
      stats = {
        home: home ? toTeamStats(home) : DATA_UNAVAILABLE,
        away: away ? toTeamStats(away) : DATA_UNAVAILABLE,
      };
    }
    return { ...toSummary(match), stats };
  }
}
