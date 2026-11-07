import type { DataEnvironment, Prisma, PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../utils/errors.js';
import { areStatsKnownBefore, informationCutoff, isResultKnownBefore, resultKnownAt, visibleEnvironments } from './cutoff.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface KnownStatLine {
  possession: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  corners: number | null;
  yellowCards: number | null;
  redCards: number | null;
  fouls: number | null;
  offsides: number | null;
}

export type StatsStatus = 'KNOWN' | 'NOT_RECORDED' | 'PUBLISHED_AFTER_CUTOFF';

export interface KnownResult {
  matchId: string;
  matchDate: string;
  resultKnownAt: string;
  dataEnvironment: DataEnvironment;
  venue: 'HOME' | 'AWAY';
  opponent: { id: string; name: string };
  goalsFor: number;
  goalsAgainst: number;
  outcome: 'W' | 'D' | 'L';
  statsRecorded: boolean;
  stats: { status: StatsStatus; for: KnownStatLine | null; against: KnownStatLine | null };
}

export interface KnowledgeReconstruction {
  matchId: string;
  dataEnvironment: DataEnvironment;
  cutoff: string;
  kickoffTimeKnown: boolean;
  visibleEnvironments: DataEnvironment[];
  latestInputAt: string | null;
  integrity: { allInputsBeforeCutoff: boolean; inputsChecked: number };
  home: { team: { id: string; name: string }; recent: KnownResult[]; excludedNotYetKnown: number };
  away: { team: { id: string; name: string }; recent: KnownResult[]; excludedNotYetKnown: number };
  headToHead: { meetings: KnownResult[]; excludedNotYetKnown: number };
  availability: { status: 'REPORTED' | 'DATA UNAVAILABLE'; reportsBeforeCutoff: number; playersReported: number; reportsIgnoredAfterCutoff: number };
  dataLimitations: string[];
}

export interface ReconstructOptions {
  formWindow?: number;
  h2hWindow?: number;
}

export interface PointInTime {
  cutoff: Date;
  environments: DataEnvironment[];
  excludeMatchId?: string;
}

export interface HistoryResult {
  results: KnownResult[];
  excludedNotYetKnown: number;
}

export interface AvailabilityReport {
  player: { id: string; name: string; position: string; teamId: string };
  status: 'AVAILABLE' | 'INJURED' | 'SUSPENDED' | 'DOUBTFUL' | 'UNKNOWN';
  reason: string | null;
  expectedReturn: string | null;
  reportedAt: string;
}

export interface PlayerStatRow {
  playerId: string;
  matchId: string;
  started: boolean;
  minutes: number;
  goals: number | null;
  assists: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  tackles: number | null;
  interceptions: number | null;
  clearances: number | null;
}

export interface PlayerHistory {
  matches: KnownResult[];
  players: Array<{ id: string; name: string; position: string }>;
  rows: PlayerStatRow[];
}

const statSelect = {
  teamId: true,
  possession: true,
  shots: true,
  shotsOnTarget: true,
  corners: true,
  yellowCards: true,
  redCards: true,
  fouls: true,
  offsides: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MatchTeamStatsSelect;

const matchInclude = {
  homeTeam: { select: { id: true, name: true } },
  awayTeam: { select: { id: true, name: true } },
  stats: { select: statSelect },
} satisfies Prisma.MatchInclude;

type CandidateMatch = Prisma.MatchGetPayload<{ include: typeof matchInclude }>;
type StatRow = CandidateMatch['stats'][number];

const statLine = (row: StatRow | undefined): KnownStatLine | null =>
  row
    ? { possession: row.possession, shots: row.shots, shotsOnTarget: row.shotsOnTarget, corners: row.corners, yellowCards: row.yellowCards, redCards: row.redCards, fouls: row.fouls, offsides: row.offsides }
    : null;

function toKnownResult(m: CandidateMatch, perspectiveTeamId: string, cutoff: Date): KnownResult {
  const home = m.homeTeamId === perspectiveTeamId;
  const goalsFor = (home ? m.homeScore : m.awayScore)!;
  const goalsAgainst = (home ? m.awayScore : m.homeScore)!;
  const opponentId = home ? m.awayTeamId : m.homeTeamId;
  const own = m.stats.find((s) => s.teamId === perspectiveTeamId);
  const opp = m.stats.find((s) => s.teamId === opponentId);
  const recorded = [own, opp].filter((s): s is StatRow => s !== undefined);
  const status: StatsStatus =
    recorded.length === 0 ? 'NOT_RECORDED' : recorded.every((s) => areStatsKnownBefore(s, m.dataEnvironment, cutoff)) ? 'KNOWN' : 'PUBLISHED_AFTER_CUTOFF';
  return {
    matchId: m.id,
    matchDate: m.matchDate.toISOString(),
    resultKnownAt: resultKnownAt(m).toISOString(),
    dataEnvironment: m.dataEnvironment,
    venue: home ? 'HOME' : 'AWAY',
    opponent: home ? m.awayTeam : m.homeTeam,
    goalsFor,
    goalsAgainst,
    outcome: goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D',
    statsRecorded: status === 'KNOWN',
    stats: status === 'KNOWN' ? { status, for: statLine(own), against: statLine(opp) } : { status, for: null, against: null },
  };
}

const involves = (teamId: string): Prisma.MatchWhereInput => ({ OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] });

// Rebuilds exactly what could have been known before a cutoff. This is the only gateway analysis and feature engineering may use.
export class KnowledgeService {
  constructor(private readonly db: Db) {}

  private async knownFinished(where: Prisma.MatchWhereInput, pit: PointInTime, take: number, perspectiveTeamId: string): Promise<HistoryResult> {
    // Over-fetch: a few matches before the cutoff may still be excluded because their result was not yet public.
    const candidates = await this.db.match.findMany({
      where: {
        AND: [where, pit.excludeMatchId ? { id: { not: pit.excludeMatchId } } : {}],
        status: 'FINISHED',
        dataEnvironment: { in: pit.environments },
        matchDate: { lt: pit.cutoff },
      },
      include: matchInclude,
      orderBy: [{ matchDate: 'desc' }, { id: 'asc' }],
      take: take + 10,
    });
    const known = candidates.filter((m) => isResultKnownBefore(m, pit.cutoff));
    return { results: known.slice(0, take).map((m) => toKnownResult(m, perspectiveTeamId, pit.cutoff)), excludedNotYetKnown: candidates.length - known.length };
  }

  teamHistory(teamId: string, pit: PointInTime, limit: number, venue?: 'HOME' | 'AWAY'): Promise<HistoryResult> {
    const where: Prisma.MatchWhereInput = venue === 'HOME' ? { homeTeamId: teamId } : venue === 'AWAY' ? { awayTeamId: teamId } : involves(teamId);
    return this.knownFinished(where, pit, limit, teamId);
  }

  headToHeadHistory(headToHeadId: string, perspectiveTeamId: string, pit: PointInTime, limit: number): Promise<HistoryResult> {
    return this.knownFinished({ headToHeadId }, pit, limit, perspectiveTeamId);
  }

  async matchPointInTime(matchId: string, asOf?: Date) {
    const match = await this.db.match.findUnique({
      where: { id: matchId },
      include: { homeTeam: { select: { id: true, name: true } }, awayTeam: { select: { id: true, name: true } } },
    });
    if (!match) throw new NotFoundError('Match', matchId);
    // A prospective analysis made before kickoff may only use what existed at that moment.
    const kickoffCutoff = informationCutoff(match);
    const cutoff = asOf && asOf.getTime() < kickoffCutoff.getTime() ? asOf : kickoffCutoff;
    const pit: PointInTime = { cutoff, environments: visibleEnvironments(match.dataEnvironment), excludeMatchId: match.id };
    return { match, pit };
  }

  // Latest report per player published strictly before the cutoff (the history is append-only).
  async availabilityAt(matchId: string, cutoff: Date): Promise<{ reports: AvailabilityReport[]; ignoredAfterCutoff: number }> {
    const [rows, ignoredAfterCutoff] = await Promise.all([
      this.db.playerAvailability.findMany({
        where: { matchId, reportedAt: { lt: cutoff } },
        orderBy: [{ reportedAt: 'desc' }, { id: 'asc' }],
        include: { player: { select: { id: true, name: true, position: true, teamId: true } } },
      }),
      this.db.playerAvailability.count({ where: { matchId, reportedAt: { gte: cutoff } } }),
    ]);
    const latest = new Map<string, AvailabilityReport>();
    for (const r of rows) {
      if (latest.has(r.playerId)) continue;
      latest.set(r.playerId, { player: r.player, status: r.status, reason: r.reason, expectedReturn: r.expectedReturn?.toISOString() ?? null, reportedAt: r.reportedAt.toISOString() });
    }
    return { reports: [...latest.values()], ignoredAfterCutoff };
  }

  // Player statistics from a team's known matches. LIVE rows count only if created and last changed before the cutoff.
  async playerHistory(teamId: string, pit: PointInTime, lookback: number): Promise<PlayerHistory> {
    const history = await this.teamHistory(teamId, pit, lookback);
    const ids = history.results.map((r) => r.matchId);
    const envById = new Map(history.results.map((r) => [r.matchId, r.dataEnvironment]));
    const [rows, players] = await Promise.all([
      this.db.playerMatchStats.findMany({ where: { teamId, matchId: { in: ids } } }),
      this.db.player.findMany({ where: { teamId }, select: { id: true, name: true, position: true } }),
    ]);
    const known = rows.filter((r) => envById.get(r.matchId) !== 'LIVE' || areStatsKnownBefore({ createdAt: r.createdAt, updatedAt: r.lastUpdated }, 'LIVE', pit.cutoff));
    return {
      matches: history.results,
      players,
      rows: known.map((r) => ({
        playerId: r.playerId,
        matchId: r.matchId,
        started: r.started,
        minutes: r.minutes,
        goals: r.goals,
        assists: r.assists,
        shots: r.shots,
        shotsOnTarget: r.shotsOnTarget,
        tackles: r.tackles,
        interceptions: r.interceptions,
        clearances: r.clearances,
      })),
    };
  }

  // Every result of a competition that was public before the cutoff, oldest first, for rating models (Elo, Dixon-Coles).
  async knownResults(competitionId: string, pit: PointInTime): Promise<Array<{ homeTeamId: string; awayTeamId: string; homeScore: number; awayScore: number; matchDate: Date; resultKnownAt: Date }>> {
    const rows = await this.db.match.findMany({
      where: {
        competitionId,
        status: 'FINISHED',
        dataEnvironment: { in: pit.environments },
        matchDate: { lt: pit.cutoff },
        homeScore: { not: null },
        awayScore: { not: null },
        ...(pit.excludeMatchId ? { id: { not: pit.excludeMatchId } } : {}),
      },
      select: { homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true, matchDate: true, kickoffTimeKnown: true },
      orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
    });
    return rows
      .filter((m) => isResultKnownBefore(m, pit.cutoff))
      .map((m) => ({ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, homeScore: m.homeScore!, awayScore: m.awayScore!, matchDate: m.matchDate, resultKnownAt: resultKnownAt(m) }));
  }

  // Recent known results of a competition, for league-level baselines such as home advantage.
  async competitionHistory(competitionId: string, pit: PointInTime, limit: number): Promise<Array<{ homeScore: number; awayScore: number; resultKnownAt: Date }>> {
    const rows = await this.db.match.findMany({
      where: {
        competitionId,
        status: 'FINISHED',
        dataEnvironment: { in: pit.environments },
        matchDate: { lt: pit.cutoff },
        ...(pit.excludeMatchId ? { id: { not: pit.excludeMatchId } } : {}),
      },
      select: { matchDate: true, kickoffTimeKnown: true, homeScore: true, awayScore: true },
      orderBy: [{ matchDate: 'desc' }, { id: 'asc' }],
      take: limit + 20,
    });
    return rows
      .filter((m) => isResultKnownBefore(m, pit.cutoff))
      .slice(0, limit)
      .map((m) => ({ homeScore: m.homeScore!, awayScore: m.awayScore!, resultKnownAt: resultKnownAt(m) }));
  }

  // A team's view "as of" an instant (default now). Synthetic teams only ever see synthetic history.
  async teamPointInTime(teamId: string, asOf: Date) {
    const team = await this.db.team.findUnique({ where: { id: teamId }, include: { competition: { select: { dataEnvironment: true } } } });
    if (!team) throw new NotFoundError('Team', teamId);
    const pit: PointInTime = { cutoff: asOf, environments: visibleEnvironments(team.competition.dataEnvironment) };
    return { team: { id: team.id, name: team.name }, pit };
  }

  async reconstruct(matchId: string, options: ReconstructOptions = {}): Promise<KnowledgeReconstruction> {
    const formWindow = options.formWindow ?? 5;
    const h2hWindow = options.h2hWindow ?? 5;
    const { match, pit } = await this.matchPointInTime(matchId);
    const { cutoff, environments: envs } = pit;

    const [home, away, h2h, reportsBefore, reportsAfter] = await Promise.all([
      this.teamHistory(match.homeTeamId, pit, formWindow),
      this.teamHistory(match.awayTeamId, pit, formWindow),
      this.headToHeadHistory(match.headToHeadId, match.homeTeamId, pit, h2hWindow),
      this.db.playerAvailability.findMany({ where: { matchId, reportedAt: { lt: cutoff } }, select: { reportedAt: true, playerId: true } }),
      this.db.playerAvailability.count({ where: { matchId, reportedAt: { gte: cutoff } } }),
    ]);

    const inputTimes = [
      ...[...home.results, ...away.results, ...h2h.results].map((r) => new Date(r.resultKnownAt).getTime()),
      ...reportsBefore.map((r) => r.reportedAt.getTime()),
    ];
    const latest = inputTimes.length > 0 ? Math.max(...inputTimes) : null;

    const limitations: string[] = [];
    for (const [side, data] of [['home', home], ['away', away]] as const) {
      const team = side === 'home' ? match.homeTeam : match.awayTeam;
      if (data.results.length < formWindow) limitations.push(`Only ${data.results.length} completed matches were known for ${team.name} before kickoff (window ${formWindow}).`);
      const withoutStats = data.results.filter((r) => !r.statsRecorded).length;
      if (withoutStats > 0) limitations.push(`Match statistics unavailable for ${withoutStats} of ${data.results.length} known ${team.name} matches.`);
    }
    if (h2h.results.length < h2hWindow) limitations.push(`Only ${h2h.results.length} previous meetings were known before kickoff (window ${h2hWindow}).`);
    if (reportsBefore.length === 0) limitations.push('No player availability report was published before kickoff.');
    if (!match.kickoffTimeKnown) limitations.push('Kickoff time unknown; cutoff set to the start of the match day.');

    return {
      matchId: match.id,
      dataEnvironment: match.dataEnvironment,
      cutoff: cutoff.toISOString(),
      kickoffTimeKnown: match.kickoffTimeKnown,
      visibleEnvironments: envs,
      latestInputAt: latest === null ? null : new Date(latest).toISOString(),
      integrity: { allInputsBeforeCutoff: inputTimes.every((t) => t < cutoff.getTime()), inputsChecked: inputTimes.length },
      home: { team: match.homeTeam, recent: home.results, excludedNotYetKnown: home.excludedNotYetKnown },
      away: { team: match.awayTeam, recent: away.results, excludedNotYetKnown: away.excludedNotYetKnown },
      headToHead: { meetings: h2h.results, excludedNotYetKnown: h2h.excludedNotYetKnown },
      availability: {
        status: reportsBefore.length > 0 ? 'REPORTED' : 'DATA UNAVAILABLE',
        reportsBeforeCutoff: reportsBefore.length,
        playersReported: new Set(reportsBefore.map((r) => r.playerId)).size,
        reportsIgnoredAfterCutoff: reportsAfter,
      },
      dataLimitations: limitations,
    };
  }
}
