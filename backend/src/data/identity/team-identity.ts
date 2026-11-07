import type { Prisma, PrismaClient } from '@prisma/client';
import { CURATED_SOURCE, type CuratedTeam } from './curated-teams.js';

type Db = PrismaClient | Prisma.TransactionClient;

// Case, whitespace, punctuation and accents only — deterministic, never similarity-based.
export function normalizeTeamName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface UnresolvedTeam {
  source: string;
  name: string;
  normalized: string;
}

export class UnresolvedTeamError extends Error {
  constructor(readonly unresolved: UnresolvedTeam[]) {
    super(
      `No TeamAlias for: ${unresolved.map((u) => `"${u.name}" (${u.source})`).join(', ')}. ` +
        'Add a curated alias after confirming the club; names are never guessed.',
    );
    this.name = 'UnresolvedTeamError';
  }
}

export class TeamIdentityResolver {
  constructor(private readonly db: Db) {}

  // Resolves every name or fails listing all unknown names at once.
  async resolveAll(source: string, names: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(names)];
    const normalized = new Map(unique.map((n) => [n, normalizeTeamName(n)]));
    const aliases = await this.db.teamAlias.findMany({
      where: { source, normalizedAlias: { in: [...new Set(normalized.values())] } },
      select: { normalizedAlias: true, teamId: true },
    });
    const byAlias = new Map(aliases.map((a) => [a.normalizedAlias, a.teamId]));

    const resolved = new Map<string, string>();
    const unresolved: UnresolvedTeam[] = [];
    for (const name of unique) {
      const key = normalized.get(name)!;
      const teamId = byAlias.get(key);
      if (teamId) resolved.set(name, teamId);
      else unresolved.push({ source, name, normalized: key });
    }
    if (unresolved.length > 0) throw new UnresolvedTeamError(unresolved);
    return resolved;
  }
}

export interface CuratedSyncResult {
  teamsCreated: number;
  teamsMoved: number;
  aliasesCreated: number;
}

// Idempotently ensures curated teams and their aliases exist; refuses if an alias already points at a different team.
export async function syncCuratedTeams(db: Db, competitionId: string, teams: readonly CuratedTeam[], now: Date): Promise<CuratedSyncResult> {
  let teamsCreated = 0;
  let teamsMoved = 0;
  let aliasesCreated = 0;
  for (const curated of teams) {
    let team = await db.team.findUnique({ where: { source_sourceId: { source: CURATED_SOURCE, sourceId: curated.key } } });
    if (!team) {
      team = await db.team.create({
        data: {
          name: curated.name,
          shortName: curated.shortName,
          country: curated.country,
          competitionId,
          source: CURATED_SOURCE,
          sourceId: curated.key,
          lastUpdated: now,
        },
      });
      teamsCreated += 1;
    } else if (team.competitionId !== competitionId) {
      // A club previously filed under another competition is moved, so a widened allowlist
      // repairs itself instead of leaving every club under whichever league was imported first.
      team = await db.team.update({ where: { id: team.id }, data: { competitionId, lastUpdated: now } });
      teamsMoved += 1;
    }

    for (const [source, spellings] of Object.entries(curated.aliases)) {
      for (const alias of spellings) {
        const normalizedAlias = normalizeTeamName(alias);
        const existing = await db.teamAlias.findUnique({ where: { source_normalizedAlias: { source, normalizedAlias } } });
        if (existing && existing.teamId !== team.id) {
          throw new Error(`Alias "${alias}" (${source}) already maps to team ${existing.teamId}, not ${curated.key}`);
        }
        if (!existing) {
          await db.teamAlias.create({ data: { teamId: team.id, source, alias, normalizedAlias } });
          aliasesCreated += 1;
        }
      }
    }
  }
  return { teamsCreated, teamsMoved, aliasesCreated };
}
