import type { Prisma } from '@prisma/client';
import type {
  DatasetRef,
  IDataProvider,
  ProviderAvailability,
  ProviderMatch,
  ProviderMatchTeamStats,
  ProviderPlayer,
  ProviderPlayerMatchStats,
  ProviderTeamRef,
  SourceWarning,
} from '../../providers/types.js';

// How far ahead availability reports are requested; later fixtures rarely have published team news.
const AVAILABILITY_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
// Providers often publish or correct statistics days after the final whistle.
const STATS_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface SupplementaryData {
  players: Array<{ team: ProviderTeamRef; players: ProviderPlayer[] }>;
  matchStats: Array<{ matchSourceId: string; stats: ProviderMatchTeamStats[] }>;
  playerStats: Array<{ matchSourceId: string; stats: ProviderPlayerMatchStats[] }>;
  availability: Array<{ matchSourceId: string; reports: ProviderAvailability[] }>;
}

export interface SupplementaryCounts {
  playersCreated: number;
  playersUpdated: number;
  statsCreated: number;
  statsFilled: number;
  statsUpdated: number;
  playerStatsCreated: number;
  playerStatsFilled: number;
  availabilityReportsCreated: number;
}

export const emptySupplementaryCounts = (): SupplementaryCounts => ({
  playersCreated: 0,
  playersUpdated: 0,
  statsCreated: 0,
  statsFilled: 0,
  statsUpdated: 0,
  playerStatsCreated: 0,
  playerStatsFilled: 0,
  availabilityReportsCreated: 0,
});

const TEAM_STAT_FIELDS = ['goals', 'possession', 'shots', 'shotsOnTarget', 'corners', 'yellowCards', 'redCards', 'fouls', 'offsides'] as const;
const PLAYER_STAT_FIELDS = ['goals', 'assists', 'shots', 'shotsOnTarget', 'passes', 'tackles', 'interceptions'] as const;

// Only asks the provider for what it declares it supplies, and only for matches that still need it.
export async function fetchSupplementary(
  provider: IDataProvider,
  ref: DatasetRef,
  matches: ProviderMatch[],
  matchesWithStats: ReadonlySet<string>,
  now: Date,
  warnings: SourceWarning[],
): Promise<SupplementaryData> {
  const data: SupplementaryData = { players: [], matchStats: [], playerStats: [], availability: [] };
  const caps = provider.capabilities;
  const collect = <T>(result: { available: true; data: T; warnings: SourceWarning[] } | { available: false; reason: string }): T | null => {
    if (!result.available) {
      warnings.push({ code: 'SUPPLEMENTARY_UNAVAILABLE', message: result.reason });
      return null;
    }
    warnings.push(...result.warnings);
    return result.data;
  };

  if (caps.players) {
    const teams = new Map<string, ProviderTeamRef>();
    for (const m of matches) for (const t of [m.homeTeam, m.awayTeam]) teams.set(t.name, t);
    for (const team of teams.values()) {
      const players = collect(await provider.getPlayers(ref, team));
      if (players) data.players.push({ team, players });
    }
  }

  const finishedNeedingStats = matches.filter(
    (m) => m.status === 'FINISHED' && (!matchesWithStats.has(m.sourceId) || now.getTime() - m.kickoff.getTime() <= STATS_REFRESH_WINDOW_MS),
  );
  if (caps.matchStats) {
    for (const m of finishedNeedingStats) {
      const stats = collect(await provider.getMatchStats(ref, m.sourceId));
      if (stats) data.matchStats.push({ matchSourceId: m.sourceId, stats });
    }
  }
  if (caps.playerStats) {
    for (const m of finishedNeedingStats) {
      const stats = collect(await provider.getPlayerStats(ref, m.sourceId));
      if (stats) data.playerStats.push({ matchSourceId: m.sourceId, stats });
    }
  }

  if (caps.availability) {
    const horizon = now.getTime() + AVAILABILITY_LOOKAHEAD_MS;
    for (const m of matches.filter((x) => x.status !== 'FINISHED' && x.kickoff.getTime() <= horizon)) {
      const reports = collect(await provider.getPlayerAvailability(ref, m.sourceId));
      if (reports) data.availability.push({ matchSourceId: m.sourceId, reports });
    }
  }
  return data;
}

interface IngestContext {
  tx: Prisma.TransactionClient;
  source: string;
  now: Date;
  teamIds: Map<string, string>;
  matchBySourceId: Map<string, { id: string; status: string; homeTeamId: string }>;
  warnings: SourceWarning[];
}

// Fill-only merge: NULLs may be filled; differing known values are kept and reported as conflicts.
function mergeKnown<K extends string>(
  existing: Record<K, number | null>,
  incoming: Record<K, number | null>,
  fields: readonly K[],
): { fill: Partial<Record<K, number>>; conflicts: K[] } {
  const fill: Partial<Record<K, number>> = {};
  const conflicts: K[] = [];
  for (const field of fields) {
    const next = incoming[field];
    if (next === null) continue;
    if (existing[field] === null) fill[field] = next;
    else if (existing[field] !== next) conflicts.push(field);
  }
  return { fill, conflicts };
}

export async function ingestSupplementary(ctx: IngestContext, data: SupplementaryData): Promise<SupplementaryCounts> {
  const { tx, source, now, warnings } = ctx;
  const counts = emptySupplementaryCounts();

  for (const { team, players } of data.players) {
    const teamId = ctx.teamIds.get(team.name);
    if (!teamId) continue;
    for (const p of players) {
      const existing = await tx.player.findUnique({ where: { source_sourceId: { source, sourceId: p.sourceId } } });
      if (!existing) {
        await tx.player.create({ data: { teamId, name: p.name, position: p.position, source, sourceId: p.sourceId, lastUpdated: now } });
        counts.playersCreated += 1;
      } else if (existing.teamId !== teamId || existing.name !== p.name || existing.position !== p.position) {
        await tx.player.update({ where: { id: existing.id }, data: { teamId, name: p.name, position: p.position, lastUpdated: now } });
        counts.playersUpdated += 1;
      }
    }
  }

  for (const { matchSourceId, stats } of data.matchStats) {
    const match = ctx.matchBySourceId.get(matchSourceId);
    if (!match) continue;
    for (const s of stats) {
      const teamId = ctx.teamIds.get(s.teamName);
      if (!teamId) {
        warnings.push({ code: 'STATS_TEAM_UNRESOLVED', sourceId: matchSourceId, message: `Statistics for unknown team "${s.teamName}" skipped.` });
        continue;
      }
      const values = Object.fromEntries(TEAM_STAT_FIELDS.map((f) => [f, s[f]])) as Pick<ProviderMatchTeamStats, (typeof TEAM_STAT_FIELDS)[number]>;
      const existing = await tx.matchTeamStats.findUnique({ where: { matchId_teamId: { matchId: match.id, teamId } } });
      if (!existing) {
        await tx.matchTeamStats.create({ data: { matchId: match.id, teamId, isHome: teamId === match.homeTeamId, ...values, source, lastUpdated: now } });
        counts.statsCreated += 1;
        continue;
      }
      if (match.status !== 'FINISHED') {
        await tx.matchTeamStats.update({ where: { id: existing.id }, data: { ...values, lastUpdated: now } });
        counts.statsUpdated += 1;
        continue;
      }
      const { fill, conflicts } = mergeKnown(existing, values, TEAM_STAT_FIELDS);
      if (conflicts.length > 0) warnings.push({ code: 'STATS_CONFLICT', sourceId: matchSourceId, message: `Source now differs on ${conflicts.join(', ')}; stored statistics kept.` });
      if (Object.keys(fill).length > 0) {
        await tx.matchTeamStats.update({ where: { id: existing.id }, data: { ...fill, lastUpdated: now } });
        counts.statsFilled += 1;
      }
    }
  }

  const playerIdCache = new Map<string, string | null>();
  const playerId = async (sourceId: string): Promise<string | null> => {
    if (!playerIdCache.has(sourceId)) {
      const row = await tx.player.findUnique({ where: { source_sourceId: { source, sourceId } }, select: { id: true } });
      playerIdCache.set(sourceId, row?.id ?? null);
    }
    return playerIdCache.get(sourceId)!;
  };

  for (const { matchSourceId, stats } of data.playerStats) {
    const match = ctx.matchBySourceId.get(matchSourceId);
    if (!match) continue;
    for (const s of stats) {
      const pid = await playerId(s.playerSourceId);
      if (!pid) {
        warnings.push({ code: 'PLAYER_UNRESOLVED', sourceId: matchSourceId, message: `Player ${s.playerSourceId} unknown; statistics skipped.` });
        continue;
      }
      const player = await tx.player.findUniqueOrThrow({ where: { id: pid }, select: { teamId: true } });
      const values = Object.fromEntries(PLAYER_STAT_FIELDS.map((f) => [f, s[f]])) as Pick<ProviderPlayerMatchStats, (typeof PLAYER_STAT_FIELDS)[number]>;
      const existing = await tx.playerMatchStats.findUnique({ where: { playerId_matchId: { playerId: pid, matchId: match.id } } });
      if (!existing) {
        await tx.playerMatchStats.create({ data: { playerId: pid, matchId: match.id, teamId: player.teamId, started: s.started, minutes: s.minutes, ...values, source, lastUpdated: now } });
        counts.playerStatsCreated += 1;
        continue;
      }
      const { fill, conflicts } = mergeKnown(existing, values, PLAYER_STAT_FIELDS);
      if (conflicts.length > 0) warnings.push({ code: 'PLAYER_STATS_CONFLICT', sourceId: matchSourceId, message: `Player ${s.playerSourceId}: source now differs on ${conflicts.join(', ')}; stored values kept.` });
      if (Object.keys(fill).length > 0) {
        await tx.playerMatchStats.update({ where: { id: existing.id }, data: { ...fill, lastUpdated: now } });
        counts.playerStatsFilled += 1;
      }
    }
  }

  for (const { matchSourceId, reports } of data.availability) {
    const match = ctx.matchBySourceId.get(matchSourceId);
    if (!match) continue;
    const rows: Prisma.PlayerAvailabilityCreateManyInput[] = [];
    for (const r of reports) {
      if (r.reportedAt.getTime() > now.getTime()) {
        warnings.push({ code: 'FUTURE_REPORT', sourceId: matchSourceId, message: `Availability report dated ${r.reportedAt.toISOString()} is after the sync time; skipped.` });
        continue;
      }
      const pid = await playerId(r.playerSourceId);
      if (!pid) {
        warnings.push({ code: 'PLAYER_UNRESOLVED', sourceId: matchSourceId, message: `Player ${r.playerSourceId} unknown; availability report skipped.` });
        continue;
      }
      rows.push({ playerId: pid, matchId: match.id, status: r.status, reason: r.reason, expectedReturn: r.expectedReturn, reportedAt: r.reportedAt, source });
    }
    if (rows.length > 0) {
      const created = await tx.playerAvailability.createMany({ data: rows, skipDuplicates: true });
      counts.availabilityReportsCreated += created.count;
    }
  }

  return counts;
}
