import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  CoverageDataset,
  ProviderAvailabilityStatus,
  ProviderEventType,
  ProviderFixturePlayerStats,
  ProviderInjuryReport,
  ProviderLineup,
  ProviderLineupPlayer,
  ProviderMatch,
  ProviderMatchEvent,
  ProviderMatchStatus,
  ProviderMatchTeamStats,
  ProviderPlayer,
  ProviderPosition,
  ProviderSeasonCoverage,
  ProviderTeamRef,
  SourceWarning,
} from '../types.js';

// ---- Response element schemas: only the fields Nexora reads; unknown fields are ignored. ----

const Id = z.number().int();
const NullableInt = z.number().int().nullable().optional();
const TeamSchema = z.object({ id: Id, name: z.string().min(1) });
const Named = z.object({ id: Id.nullable().optional(), name: z.string().nullable().optional() });

const FixtureSchema = z.object({
  fixture: z.object({
    id: Id,
    date: z.string().min(1),
    status: z.object({ short: z.string().min(1) }),
  }),
  league: z.object({ id: Id, season: Id, round: z.string().nullable().optional() }),
  teams: z.object({ home: TeamSchema, away: TeamSchema }),
  goals: z.object({ home: NullableInt, away: NullableInt }),
  score: z.object({ halftime: z.object({ home: NullableInt, away: NullableInt }).optional() }).optional(),
});

const StatisticsSchema = z.object({
  team: TeamSchema,
  statistics: z.array(z.object({ type: z.string(), value: z.union([z.number(), z.string(), z.null()]) })),
});

const EventSchema = z.object({
  time: z.object({ elapsed: z.number().int(), extra: NullableInt }),
  team: TeamSchema,
  player: Named.optional(),
  assist: Named.optional(),
  type: z.string(),
  detail: z.string().nullable().optional(),
  comments: z.string().nullable().optional(),
});

const LineupPlayerSchema = z.object({
  player: z.object({ id: Id.nullable().optional(), name: z.string(), number: NullableInt, pos: z.string().nullable().optional(), grid: z.string().nullable().optional() }),
});
const LineupSchema = z.object({
  team: TeamSchema,
  formation: z.string().nullable().optional(),
  coach: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  startXI: z.array(LineupPlayerSchema),
  substitutes: z.array(LineupPlayerSchema),
});

const Num = z.union([z.number(), z.string(), z.null()]).optional();
const PlayerStatsSchema = z.object({
  team: TeamSchema,
  players: z.array(
    z.object({
      player: z.object({ id: Id, name: z.string() }),
      statistics: z.array(
        z.object({
          games: z.object({ minutes: Num, position: z.string().nullable().optional(), rating: Num, substitute: z.boolean().nullable().optional() }).optional(),
          shots: z.object({ total: Num, on: Num }).nullable().optional(),
          goals: z.object({ total: Num, assists: Num }).nullable().optional(),
          passes: z.object({ total: Num }).nullable().optional(),
          tackles: z.object({ total: Num, interceptions: Num }).nullable().optional(),
          fouls: z.object({ committed: Num }).nullable().optional(),
          cards: z.object({ yellow: Num, red: Num }).nullable().optional(),
        }),
      ),
    }),
  ),
});

const InjurySchema = z.object({
  player: z.object({ id: Id, name: z.string(), type: z.string().nullable().optional(), reason: z.string().nullable().optional() }),
  team: TeamSchema,
  fixture: z.object({ id: Id }),
});

const SquadSchema = z.object({
  team: TeamSchema,
  players: z.array(z.object({ id: Id, name: z.string(), position: z.string().nullable().optional() })),
});

const CoverageFlag = z.boolean().nullable().optional();
const LeagueSchema = z.object({
  league: z.object({ id: Id, name: z.string() }),
  country: z.object({ name: z.string() }).optional(),
  seasons: z.array(
    z.object({
      year: Id,
      start: z.string(),
      end: z.string(),
      current: z.boolean(),
      coverage: z
        .object({
          fixtures: z.object({ events: CoverageFlag, lineups: CoverageFlag, statistics_fixtures: CoverageFlag, statistics_players: CoverageFlag }).optional(),
          standings: CoverageFlag,
          players: CoverageFlag,
          injuries: CoverageFlag,
        })
        .optional(),
    }),
  ),
});

export type FixtureElement = z.infer<typeof FixtureSchema> & { events?: unknown; lineups?: unknown; statistics?: unknown; players?: unknown };

// ---- Value parsing. Missing is never zero: null, "" and unparseable values stay null. ----

export function parseStatValue(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const match = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(trimmed);
  return match ? Number(match[1]) : null;
}

function parseCount(value: number | string | null | undefined): number | null {
  const n = parseStatValue(value);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

const STATUS: Record<string, ProviderMatchStatus> = {
  TBD: 'SCHEDULED', NS: 'SCHEDULED',
  '1H': 'LIVE', HT: 'LIVE', '2H': 'LIVE', ET: 'LIVE', BT: 'LIVE', P: 'LIVE', SUSP: 'LIVE', INT: 'LIVE', LIVE: 'LIVE',
  FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED', AWD: 'FINISHED', WO: 'FINISHED',
  PST: 'POSTPONED',
  CANC: 'CANCELLED', ABD: 'CANCELLED',
};

export function mapStatus(short: string): ProviderMatchStatus | null {
  return STATUS[short] ?? null;
}

const POSITION_CODE: Record<string, ProviderPosition> = { G: 'GOALKEEPER', D: 'DEFENDER', M: 'MIDFIELDER', F: 'FORWARD' };
const POSITION_NAME: Record<string, ProviderPosition> = { goalkeeper: 'GOALKEEPER', defender: 'DEFENDER', midfielder: 'MIDFIELDER', attacker: 'FORWARD' };

export function mapPosition(raw: string | null | undefined): ProviderPosition | null {
  if (!raw) return null;
  return POSITION_CODE[raw.trim().toUpperCase()] ?? POSITION_NAME[raw.trim().toLowerCase()] ?? null;
}

const teamRef = (t: { id: number; name: string }): ProviderTeamRef => ({ sourceId: String(t.id), name: t.name });

// ---- Elements ----

export function parseElements<T>(schema: z.ZodType<T>, elements: readonly unknown[], code: string, warnings: SourceWarning[]): T[] {
  const out: T[] = [];
  elements.forEach((element, index) => {
    const parsed = schema.safeParse(element);
    if (parsed.success) out.push(parsed.data);
    else warnings.push({ code, message: `Element ${index} skipped: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` });
  });
  return out;
}

export function parseFixtures(elements: readonly unknown[], warnings: SourceWarning[]): Array<{ match: ProviderMatch; raw: FixtureElement }> {
  const out: Array<{ match: ProviderMatch; raw: FixtureElement }> = [];
  for (const [index, element] of elements.entries()) {
    const parsed = FixtureSchema.safeParse(element);
    if (!parsed.success) {
      warnings.push({ code: 'MALFORMED_FIXTURE', message: `Fixture element ${index} skipped: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` });
      continue;
    }
    const f = parsed.data;
    const sourceId = String(f.fixture.id);
    const kickoff = new Date(f.fixture.date);
    const status = mapStatus(f.fixture.status.short);
    if (Number.isNaN(kickoff.getTime()) || status === null) {
      warnings.push({ code: 'MALFORMED_FIXTURE', sourceId, message: `Unrecognised date "${f.fixture.date}" or status "${f.fixture.status.short}"; fixture skipped.` });
      continue;
    }
    const finished = status === 'FINISHED';
    out.push({
      raw: element as FixtureElement,
      match: {
        sourceId,
        competitionSourceId: String(f.league.id),
        seasonSourceId: String(f.league.season),
        round: f.league.round ?? null,
        homeTeam: teamRef(f.teams.home),
        awayTeam: teamRef(f.teams.away),
        kickoff,
        kickoffTimeKnown: f.fixture.status.short !== 'TBD',
        sourceMatchDate: f.fixture.date,
        status,
        homeScore: finished ? (f.goals.home ?? null) : null,
        awayScore: finished ? (f.goals.away ?? null) : null,
        homeHalfTimeScore: finished ? (f.score?.halftime?.home ?? null) : null,
        awayHalfTimeScore: finished ? (f.score?.halftime?.away ?? null) : null,
      },
    });
  }
  return out;
}

type StatField = 'shots' | 'shotsOnTarget' | 'shotsOffTarget' | 'blockedShots' | 'corners' | 'fouls' | 'offsides' | 'yellowCards' | 'redCards' | 'goalkeeperSaves' | 'passes' | 'passesAccurate';
const COUNT_STATS: Record<string, StatField> = {
  'Total Shots': 'shots',
  'Shots on Goal': 'shotsOnTarget',
  'Shots off Goal': 'shotsOffTarget',
  'Blocked Shots': 'blockedShots',
  'Corner Kicks': 'corners',
  Fouls: 'fouls',
  Offsides: 'offsides',
  'Yellow Cards': 'yellowCards',
  'Red Cards': 'redCards',
  'Goalkeeper Saves': 'goalkeeperSaves',
  'Total passes': 'passes',
  'Passes accurate': 'passesAccurate',
};
const ADDITIONAL_STATS: Record<string, string> = {
  'Shots insidebox': 'shotsInsideBox',
  'Shots outsidebox': 'shotsOutsideBox',
  expected_goals: 'expectedGoals',
  goals_prevented: 'goalsPrevented',
};

// What a null statistic means, per provider statistic type. The official schema could not be consulted (Cloudflare
// blocks automated access) and no real response has been inspected yet, so every type defaults to UNKNOWN: null is
// stored as null. Switch a type to ZERO only with evidence (e.g. the event-log cross-check recorded on import).
export type NullMeaning = 'UNKNOWN' | 'ZERO';
export const STAT_NULL_POLICY_VERSION = 'api-football-null-policy/1 (all UNKNOWN)';
export const STAT_NULL_MEANING: Readonly<Record<string, NullMeaning>> = {};

function normalizeCount(type: string, value: number | string | null, policy: Readonly<Record<string, NullMeaning>>): number | null {
  if (value === null && policy[type] === 'ZERO') return 0;
  return parseCount(value);
}

export function parseStatistics(
  elements: readonly unknown[],
  match: ProviderMatch,
  warnings: SourceWarning[],
  policy: Readonly<Record<string, NullMeaning>> = STAT_NULL_MEANING,
): ProviderMatchTeamStats[] {
  const rows = parseElements(StatisticsSchema, elements, 'MALFORMED_STATISTICS', warnings);
  const unknownTypes = new Set<string>();
  const out: ProviderMatchTeamStats[] = [];
  for (const row of rows) {
    if (row.statistics.length === 0) continue;
    const isHome = String(row.team.id) === match.homeTeam.sourceId;
    if (!isHome && String(row.team.id) !== match.awayTeam.sourceId) {
      warnings.push({ code: 'STATS_TEAM_NOT_IN_FIXTURE', sourceId: match.sourceId, message: `Statistics for team ${row.team.id} do not belong to this fixture; skipped.` });
      continue;
    }
    const counts: Partial<Record<StatField, number | null>> = {};
    const additional: Record<string, number | null> = {};
    const raw: Record<string, number | string | null> = {};
    let possession: number | null = null;
    let passAccuracy: number | null = null;
    for (const { type, value } of row.statistics) {
      raw[type] = value;
      if (type === 'Ball Possession') {
        const p = parseStatValue(value);
        possession = p !== null && p >= 0 && p <= 100 ? p : null;
      } else if (type === 'Passes %') {
        const p = parseStatValue(value);
        passAccuracy = p !== null && p >= 0 && p <= 100 ? p : null;
      } else if (COUNT_STATS[type]) {
        counts[COUNT_STATS[type]] = normalizeCount(type, value, policy);
      } else if (ADDITIONAL_STATS[type]) {
        additional[ADDITIONAL_STATS[type]] = parseStatValue(value);
      } else {
        unknownTypes.add(type);
      }
    }
    const goals = isHome ? match.homeScore : match.awayScore;
    out.push({
      teamSourceId: String(row.team.id),
      teamName: row.team.name,
      isHome,
      goals,
      possession,
      shots: counts.shots ?? null,
      shotsOnTarget: counts.shotsOnTarget ?? null,
      corners: counts.corners ?? null,
      yellowCards: counts.yellowCards ?? null,
      redCards: counts.redCards ?? null,
      fouls: counts.fouls ?? null,
      offsides: counts.offsides ?? null,
      shotsOffTarget: counts.shotsOffTarget ?? null,
      blockedShots: counts.blockedShots ?? null,
      goalkeeperSaves: counts.goalkeeperSaves ?? null,
      passes: counts.passes ?? null,
      passesAccurate: counts.passesAccurate ?? null,
      passAccuracy,
      additional,
      raw,
    });
  }
  if (unknownTypes.size > 0) warnings.push({ code: 'UNKNOWN_STATISTIC', sourceId: match.sourceId, message: `Ignored statistic types: ${[...unknownTypes].join(', ')}` });
  return out;
}

// Card counts from the same fixture's event log, kept beside (never instead of) the statistics endpoint's values.
// Comparing them with null card statistics is how the meaning of null gets established from evidence.
export function attachCardEvidence(stats: ProviderMatchTeamStats[], events: readonly ProviderMatchEvent[] | null, match: ProviderMatch, warnings: SourceWarning[]): void {
  if (!events) return;
  for (const s of stats) {
    const own = events.filter((e) => e.team.sourceId === s.teamSourceId);
    const count = (types: string[]) => own.filter((e) => types.includes(e.type)).length;
    s.derived = { yellowCardEvents: count(['YELLOW_CARD']), secondYellowEvents: count(['SECOND_YELLOW']), redCardEvents: count(['RED_CARD']) };
    const dismissals = s.derived.secondYellowEvents! + s.derived.redCardEvents!;
    if (s.redCards === null) {
      warnings.push(
        dismissals === 0
          ? { code: 'RED_CARDS_NULL_NO_DISMISSAL_EVENTS', sourceId: match.sourceId, message: `${s.teamName}: red-card statistic is null and the event log has no dismissal; stored as unknown.` }
          : { code: 'RED_CARDS_NULL_WITH_DISMISSAL_EVENTS', sourceId: match.sourceId, message: `${s.teamName}: red-card statistic is null but the event log shows ${dismissals} dismissal(s); null here cannot mean zero.` },
      );
    } else if (s.redCards !== dismissals) {
      warnings.push({ code: 'RED_CARDS_EVENT_MISMATCH', sourceId: match.sourceId, message: `${s.teamName}: statistic says ${s.redCards} red card(s), event log shows ${dismissals} dismissal(s).` });
    }
  }
}

function eventType(type: string, detail: string | null | undefined): ProviderEventType {
  const t = type.trim().toLowerCase();
  const d = (detail ?? '').trim().toLowerCase();
  if (t === 'goal') {
    if (d === 'normal goal') return 'GOAL';
    if (d === 'own goal') return 'OWN_GOAL';
    if (d === 'penalty') return 'PENALTY_GOAL';
    if (d === 'missed penalty') return 'MISSED_PENALTY';
    return 'OTHER';
  }
  if (t === 'card') {
    if (d === 'yellow card') return 'YELLOW_CARD';
    if (d === 'second yellow card') return 'SECOND_YELLOW';
    if (d === 'red card') return 'RED_CARD';
    return 'OTHER';
  }
  if (t === 'subst') return 'SUBSTITUTION';
  if (t === 'var') return 'VAR';
  return 'OTHER';
}

// API-Football events carry no ID. Identical tuples in one response (same minute, team, type, detail, players) are
// told apart by their occurrence number, so re-importing the same response always yields the same keys.
export function parseEvents(elements: readonly unknown[], match: ProviderMatch, warnings: SourceWarning[]): ProviderMatchEvent[] {
  const rows = parseElements(EventSchema, elements, 'MALFORMED_EVENT', warnings);
  const seen = new Map<string, number>();
  return rows.map((e) => {
    const person = (p: z.infer<typeof Named> | undefined) => (p?.id != null ? `id:${p.id}` : p?.name ? `name:${p.name}` : '');
    const base = [match.sourceId, e.time.elapsed, e.time.extra ?? '', e.team.id, e.type, e.detail ?? '', person(e.player), person(e.assist)].join('|');
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const digest = createHash('sha256').update(`${base}|${occurrence}`).digest('hex').slice(0, 24);
    return {
      sourceId: `${match.sourceId}:${digest}`,
      team: teamRef(e.team),
      minute: e.time.elapsed,
      extraMinute: e.time.extra ?? null,
      type: eventType(e.type, e.detail),
      detail: e.detail ?? null,
      playerSourceId: e.player?.id != null ? String(e.player.id) : null,
      playerName: e.player?.name ?? null,
      relatedPlayerSourceId: e.assist?.id != null ? String(e.assist.id) : null,
      relatedPlayerName: e.assist?.name ?? null,
      comments: e.comments ?? null,
    };
  });
}

export function parseLineups(elements: readonly unknown[], warnings: SourceWarning[]): ProviderLineup[] {
  const player = (p: z.infer<typeof LineupPlayerSchema>): ProviderLineupPlayer => ({
    sourceId: p.player.id != null ? String(p.player.id) : null,
    name: p.player.name,
    number: p.player.number ?? null,
    position: mapPosition(p.player.pos),
    grid: p.player.grid ?? null,
  });
  return parseElements(LineupSchema, elements, 'MALFORMED_LINEUP', warnings).map((l) => ({
    team: teamRef(l.team),
    formation: l.formation ?? null,
    coachName: l.coach?.name ?? null,
    startXI: l.startXI.map(player),
    substitutes: l.substitutes.map(player),
  }));
}

// A row means the player took part: unused substitutes (no minutes) are omitted, never stored as zeros.
export function parsePlayerStats(
  elements: readonly unknown[],
  match: ProviderMatch,
  lineups: readonly ProviderLineup[] | null,
  warnings: SourceWarning[],
): Array<{ team: ProviderTeamRef; players: ProviderFixturePlayerStats[] }> {
  const starters = new Set((lineups ?? []).flatMap((l) => l.startXI.map((p) => p.sourceId).filter((id): id is string => id !== null)));
  return parseElements(PlayerStatsSchema, elements, 'MALFORMED_PLAYER_STATS', warnings).map((group) => ({
    team: teamRef(group.team),
    players: group.players.flatMap((entry): ProviderFixturePlayerStats[] => {
      const s = entry.statistics[0];
      const minutes = parseCount(s?.games?.minutes);
      if (!s || minutes === null || minutes === 0) return [];
      const id = String(entry.player.id);
      const substitute = s.games?.substitute;
      let started: boolean;
      if (substitute === false || substitute === true) started = !substitute;
      else if (lineups) started = starters.has(id);
      else {
        warnings.push({ code: 'STARTED_UNKNOWN', sourceId: match.sourceId, message: `Player ${id}: starting role not reported; statistics skipped.` });
        return [];
      }
      const rating = parseStatValue(s.games?.rating);
      return [
        {
          playerSourceId: id,
          name: entry.player.name,
          position: mapPosition(s.games?.position),
          started,
          minutes,
          goals: parseCount(s.goals?.total),
          assists: parseCount(s.goals?.assists),
          shots: parseCount(s.shots?.total),
          shotsOnTarget: parseCount(s.shots?.on),
          passes: parseCount(s.passes?.total),
          tackles: parseCount(s.tackles?.total),
          interceptions: parseCount(s.tackles?.interceptions),
          yellowCards: parseCount(s.cards?.yellow),
          redCards: parseCount(s.cards?.red),
          fouls: parseCount(s.fouls?.committed),
          rating: rating !== null && rating >= 0 && rating <= 10 ? rating : null,
        },
      ];
    }),
  }));
}

const SUSPENSION = /suspen|red card|yellow card|ban\b/i;
const INJURY = /injur|knock|strain|sprain|fractur|broken|illness|\bill\b|surgery|muscle|hamstring|knee|ankle|groin|calf|thigh|concussion|achilles|ligament|cruciate|meniscus|tendon|virus|bruise/i;

// "Missing Fixture" is confirmed absence; its reason decides INJURED vs SUSPENDED. Any other absence reason is kept
// as UNKNOWN with the reason preserved, rather than guessed.
export function classifyAvailability(type: string | null | undefined, reason: string | null | undefined): ProviderAvailabilityStatus {
  const t = (type ?? '').trim().toLowerCase();
  if (t === 'questionable') return 'DOUBTFUL';
  if (t !== 'missing fixture') return 'UNKNOWN';
  if (reason && SUSPENSION.test(reason)) return 'SUSPENDED';
  if (reason && INJURY.test(reason)) return 'INJURED';
  return 'UNKNOWN';
}

export function parseInjuries(elements: readonly unknown[], fetchedAt: Date, warnings: SourceWarning[]): ProviderInjuryReport[] {
  return parseElements(InjurySchema, elements, 'MALFORMED_INJURY', warnings).map((i) => ({
    player: { sourceId: String(i.player.id), name: i.player.name },
    team: teamRef(i.team),
    matchSourceId: String(i.fixture.id),
    status: classifyAvailability(i.player.type, i.player.reason),
    reason: i.player.reason ?? null,
    sourceType: i.player.type ?? null,
    expectedReturn: null,
    reportedAt: fetchedAt,
  }));
}

export function parseSquads(elements: readonly unknown[], warnings: SourceWarning[]): ProviderPlayer[] {
  return parseElements(SquadSchema, elements, 'MALFORMED_SQUAD', warnings).flatMap((squad) =>
    squad.players.flatMap((p): ProviderPlayer[] => {
      const position = mapPosition(p.position);
      return position ? [{ sourceId: String(p.id), teamSourceId: String(squad.team.id), name: p.name, position }] : [];
    }),
  );
}

export function seasonName(year: number): string {
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
}

export function parseLeague(elements: readonly unknown[], warnings: SourceWarning[]): { name: string; country: string; seasons: ProviderSeasonCoverage[] } | null {
  const [league] = parseElements(LeagueSchema, elements, 'MALFORMED_LEAGUE', warnings);
  if (!league) return null;
  return {
    name: league.league.name,
    country: league.country?.name ?? '',
    seasons: league.seasons.map((s) => {
      const c = s.coverage;
      const coverage: Record<CoverageDataset, boolean> = {
        fixtures: c?.fixtures !== undefined,
        events: c?.fixtures?.events === true,
        lineups: c?.fixtures?.lineups === true,
        fixtureStatistics: c?.fixtures?.statistics_fixtures === true,
        playerStatistics: c?.fixtures?.statistics_players === true,
        injuries: c?.injuries === true,
        players: c?.players === true,
        standings: c?.standings === true,
      };
      return { seasonSourceId: String(s.year), name: seasonName(s.year), startDate: new Date(`${s.start}T00:00:00Z`), endDate: new Date(`${s.end}T23:59:59Z`), current: s.current, coverage };
    }),
  };
}
