import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeTeamName } from '../data/identity/team-identity.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface QualityCheck {
  check: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  count: number;
  detail: string;
  examples: string[];
}

// Dataset-level integrity checks. FAIL = data that must not exist; WARN = legitimate but noteworthy gaps.
export class DataQualityService {
  constructor(private readonly db: Db) {}

  private async ids(sql: Prisma.Sql): Promise<{ count: number; examples: string[] }> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>(sql);
    return { count: rows.length, examples: rows.slice(0, 5).map((r) => r.id) };
  }

  async report(now = new Date()) {
    const checks: QualityCheck[] = [];
    const add = (check: string, failWhenPresent: boolean, result: { count: number; examples: string[] }, detail: string) =>
      checks.push({ check, status: result.count === 0 ? 'PASS' : failWhenPresent ? 'FAIL' : 'WARN', count: result.count, detail, examples: result.examples });

    add('duplicate matches', true, await this.ids(Prisma.sql`
      SELECT m1.id FROM "Match" m1 JOIN "Match" m2 ON m1.id < m2.id AND m1."homeTeamId" = m2."homeTeamId"
        AND m1."awayTeamId" = m2."awayTeamId" AND m1."seasonId" = m2."seasonId"`), 'Same home and away team stored twice in one season.');
    add('invalid scores', true, await this.ids(Prisma.sql`
      SELECT id FROM "Match" WHERE "homeScore" < 0 OR "awayScore" < 0 OR "homeHalfTimeScore" > "homeScore" OR "awayHalfTimeScore" > "awayScore"
        OR (status = 'FINISHED' AND ("homeScore" IS NULL OR "awayScore" IS NULL))
        OR (status = 'SCHEDULED' AND ("homeScore" IS NOT NULL OR "awayScore" IS NOT NULL))`), 'Negative scores, half-time above full-time, finished without a score, or scheduled with a score.');
    add('future timestamps', true, await this.ids(Prisma.sql`
      SELECT id FROM "Match" WHERE status = 'FINISHED' AND "matchDate" > ${now}
      UNION ALL SELECT id FROM "PlayerAvailability" WHERE "reportedAt" > ${now}`), 'Finished matches or availability reports dated in the future.');
    add('team mismatches', true, await this.ids(Prisma.sql`
      SELECT s.id FROM "MatchTeamStats" s JOIN "Match" m ON m.id = s."matchId"
        WHERE s."teamId" NOT IN (m."homeTeamId", m."awayTeamId") OR s."isHome" <> (s."teamId" = m."homeTeamId")
      UNION ALL SELECT p.id FROM "PlayerMatchStats" p JOIN "Match" m ON m.id = p."matchId" WHERE p."teamId" NOT IN (m."homeTeamId", m."awayTeamId")
      UNION ALL SELECT id FROM "Match" WHERE "homeTeamId" = "awayTeamId"`), 'Statistics for a team that did not play, a wrong home flag, or a team playing itself.');
    add('missing player IDs', true, await this.ids(Prisma.sql`
      SELECT s.id FROM "PlayerMatchStats" s LEFT JOIN "Player" p ON p.id = s."playerId" WHERE p.id IS NULL
      UNION ALL SELECT a.id FROM "PlayerAvailability" a LEFT JOIN "Player" p ON p.id = a."playerId" WHERE p.id IS NULL`), 'Player statistics or availability referencing no known player.');
    add('duplicate players', false, await this.ids(Prisma.sql`
      SELECT p1.id FROM "Player" p1 JOIN "Player" p2 ON p1.id < p2.id AND p1."teamId" = p2."teamId" AND lower(p1.name) = lower(p2.name)`), 'Two players with the same name in one squad (may be legitimate; review).');
    add('environment mismatches', true, await this.ids(Prisma.sql`
      SELECT m.id FROM "Match" m JOIN "Competition" c ON c.id = m."competitionId" WHERE (c."dataEnvironment" = 'SYNTHETIC') <> (m."dataEnvironment" = 'SYNTHETIC')`), 'Synthetic and real data mixed within one competition.');
    add('forecasts made after kickoff', true, await this.ids(Prisma.sql`
      SELECT p.id FROM "Prediction" p JOIN "Match" m ON m.id = p."matchId" WHERE p."asOf" > m."matchDate"`), 'Forecasts whose information cutoff is after the (possibly rescheduled) kickoff; they are never evaluated.');
    add('snapshots with future inputs', true, await this.ids(Prisma.sql`
      SELECT id FROM "FeatureSnapshot" WHERE "latestInputAt" >= "asOf"`), 'Feature snapshots containing information not available at their cutoff.');
    add('availability reported after kickoff', false, await this.ids(Prisma.sql`
      SELECT a.id FROM "PlayerAvailability" a JOIN "Match" m ON m.id = a."matchId" WHERE a."reportedAt" >= m."matchDate"`), 'Stored for audit but ignored by analysis (only reports before the cutoff are used).');

    const teams = await this.db.team.findMany({ select: { id: true, name: true } });
    const byName = new Map<string, string[]>();
    for (const t of teams) {
      const key = normalizeTeamName(t.name);
      byName.set(key, [...(byName.get(key) ?? []), t.id]);
    }
    const clashes = [...byName.values()].filter((ids) => ids.length > 1).flat();
    add('inconsistent team names', false, { count: clashes.length, examples: clashes.slice(0, 5) }, 'Distinct team records whose names normalise to the same text (possible duplicate identity).');

    const coverageRows = await this.db.$queryRaw<Array<{ env: string; finished: bigint; without_stats: bigint; missing_corners: bigint; missing_possession: bigint; missing_cards: bigint }>>(Prisma.sql`
      SELECT m."dataEnvironment"::text AS env, count(*) AS finished,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "MatchTeamStats" s WHERE s."matchId" = m.id)) AS without_stats,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "MatchTeamStats" s WHERE s."matchId" = m.id AND s.corners IS NULL)) AS missing_corners,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "MatchTeamStats" s WHERE s."matchId" = m.id AND s.possession IS NULL)) AS missing_possession,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "MatchTeamStats" s WHERE s."matchId" = m.id AND (s."yellowCards" IS NULL OR s."redCards" IS NULL))) AS missing_cards
      FROM "Match" m WHERE m.status = 'FINISHED' GROUP BY 1 ORDER BY 1`);
    const coverage = coverageRows.map((c) => ({
      dataEnvironment: c.env,
      finishedMatches: Number(c.finished),
      withoutAnyStatistics: Number(c.without_stats),
      missingCorners: Number(c.missing_corners),
      missingPossession: Number(c.missing_possession),
      missingCards: Number(c.missing_cards),
    }));
    for (const c of coverage) {
      const gaps = c.withoutAnyStatistics + c.missingCorners + c.missingPossession + c.missingCards;
      checks.push({
        check: `missing statistics (${c.dataEnvironment})`,
        status: gaps === 0 ? 'PASS' : 'WARN',
        count: c.withoutAnyStatistics,
        detail: `${c.withoutAnyStatistics} of ${c.finishedMatches} finished matches have no statistics; ${c.missingCorners} missing corners, ${c.missingPossession} missing possession, ${c.missingCards} missing cards. Missing values stay unavailable, never zero.`,
        examples: [],
      });
    }

    const status = checks.some((c) => c.status === 'FAIL') ? 'ERRORS' : checks.some((c) => c.status === 'WARN') ? 'WARNINGS' : 'GOOD';
    return { asOf: now.toISOString(), status, checks, coverage };
  }
}
