import type { DataEnvironment, Match, Prisma, PrismaClient } from '@prisma/client';
import type { DatasetRef, IDataProvider, ProviderCompetition, ProviderMatch, ProviderSeason, SourceWarning } from '../../providers/types.js';
import { CURATED_TEAMS, type CuratedTeam } from '../identity/curated-teams.js';
import { TeamIdentityResolver, syncCuratedTeams } from '../identity/team-identity.js';
import { emptySupplementaryCounts, fetchSupplementary, ingestSupplementary, type SupplementaryCounts, type SupplementaryData } from './supplementary.js';

export interface ImportRequest extends DatasetRef {
  dataEnvironment: DataEnvironment;
}

export interface ImportCounts extends SupplementaryCounts {
  sourceMatches: number;
  created: number;
  unchanged: number;
  updated: number;
  resultsReceived: number;
  revisionsRecorded: number;
  metadataFilled: number;
  conflicts: number;
  missingFromSource: number;
  teamsCreated: number;
  aliasesCreated: number;
}

export interface ImportSummary {
  importRunId: string;
  status: 'COMPLETED' | 'FAILED';
  source: string;
  dataset: string;
  dataEnvironment: DataEnvironment;
  counts: ImportCounts | null;
  warningCounts: Record<string, number>;
  unavailableFromSource: string[];
  errorMessage: string | null;
}

const emptyCounts = (): ImportCounts => ({
  sourceMatches: 0,
  created: 0,
  unchanged: 0,
  updated: 0,
  resultsReceived: 0,
  revisionsRecorded: 0,
  metadataFilled: 0,
  conflicts: 0,
  missingFromSource: 0,
  teamsCreated: 0,
  aliasesCreated: 0,
  ...emptySupplementaryCounts(),
});

// Fields that define a historical fact. Once a match is FINISHED these are never rewritten by an import.
const CORE_FIELDS = ['homeTeamId', 'awayTeamId', 'matchDate', 'kickoffTimeKnown', 'sourceMatchDate', 'status', 'homeScore', 'awayScore', 'homeHalfTimeScore', 'awayHalfTimeScore'] as const;

type CoreFields = Pick<Match, (typeof CORE_FIELDS)[number]>;

function coreFrom(m: ProviderMatch, homeTeamId: string, awayTeamId: string): CoreFields {
  return {
    homeTeamId,
    awayTeamId,
    matchDate: m.kickoff,
    kickoffTimeKnown: m.kickoffTimeKnown,
    sourceMatchDate: m.sourceMatchDate,
    status: m.status,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    homeHalfTimeScore: m.homeHalfTimeScore,
    awayHalfTimeScore: m.awayHalfTimeScore,
  };
}

type CoreField = (typeof CORE_FIELDS)[number];

export function coreDifferences(existing: CoreFields, incoming: CoreFields): CoreField[] {
  return CORE_FIELDS.filter((field) => {
    const a = existing[field];
    const b = incoming[field];
    return a instanceof Date && b instanceof Date ? a.getTime() !== b.getTime() : a !== b;
  });
}

function describeChanges(existing: CoreFields & { round: string | null }, incoming: CoreFields & { round: string | null }): Record<string, { from: unknown; to: unknown }> {
  const fields: Array<CoreField | 'round'> = [...coreDifferences(existing, incoming), ...(existing.round !== incoming.round ? ['round' as const] : [])];
  return Object.fromEntries(fields.map((f) => [f, { from: existing[f], to: incoming[f] }]));
}

function countWarnings(warnings: SourceWarning[]): Record<string, number> {
  return warnings.reduce<Record<string, number>>((acc, w) => ({ ...acc, [w.code]: (acc[w.code] ?? 0) + 1 }), {});
}

function unavailableCapabilities(provider: IDataProvider): string[] {
  return Object.entries(provider.capabilities)
    .filter(([, supported]) => !supported)
    .map(([capability]) => capability);
}

export interface PreparedImport {
  source: string;
  request: ImportRequest;
  competition: ProviderCompetition;
  season: ProviderSeason;
  matches: ProviderMatch[];
  supplementary: SupplementaryData;
  preparedAt: Date;
  warnings: SourceWarning[];
}

export class FootballDataImporter {
  constructor(
    private readonly db: PrismaClient,
    private readonly curatedTeams: readonly CuratedTeam[] = CURATED_TEAMS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async import(provider: IDataProvider, request: ImportRequest): Promise<ImportSummary> {
    const dataset = `${request.competitionSourceId}/${request.seasonSourceId}`;
    const unavailableFromSource = unavailableCapabilities(provider);
    const run = await this.db.importRun.create({
      data: { source: provider.source, dataset, dataEnvironment: request.dataEnvironment, status: 'RUNNING' },
    });

    let warnings: SourceWarning[] = [];
    try {
      const prepared = await this.prepare(provider, request);
      warnings = prepared.warnings;
      const counts = await this.db.$transaction((tx) => this.apply(tx, prepared, run.id), { timeout: 120_000, maxWait: 10_000 });
      await this.db.importRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          completedAt: this.now(),
          counts: { ...counts, unavailableFromSource } as unknown as Prisma.InputJsonValue,
          warnings: warnings as unknown as Prisma.InputJsonValue,
        },
      });
      return { importRunId: run.id, status: 'COMPLETED', source: provider.source, dataset, dataEnvironment: request.dataEnvironment, counts, warningCounts: countWarnings(warnings), unavailableFromSource, errorMessage: null };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.db.importRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', completedAt: this.now(), errorMessage, warnings: warnings as unknown as Prisma.InputJsonValue },
      });
      return { importRunId: run.id, status: 'FAILED', source: provider.source, dataset, dataEnvironment: request.dataEnvironment, counts: null, warningCounts: countWarnings(warnings), unavailableFromSource, errorMessage };
    }
  }

  // Fetches and validates source data; performs no database writes.
  async prepare(provider: IDataProvider, request: ImportRequest): Promise<PreparedImport> {
    if (request.dataEnvironment === 'SYNTHETIC') {
      throw new Error('SYNTHETIC data is produced by the development seed and is never imported alongside real data');
    }

    const competitions = await provider.getCompetitions();
    if (!competitions.available) throw new Error(competitions.reason);
    const competition = competitions.data.find((c) => c.sourceId === request.competitionSourceId);
    if (!competition) throw new Error(`${provider.source} has no competition ${request.competitionSourceId}`);

    const season = await provider.getSeason(request);
    if (!season.available) throw new Error(season.reason);
    const matches = await provider.getMatches(request);
    if (!matches.available) throw new Error(matches.reason);

    if (request.dataEnvironment === 'HISTORICAL') {
      const unfinished = matches.data.filter((m) => m.status !== 'FINISHED');
      if (unfinished.length > 0) {
        throw new Error(`${unfinished.length} matches are not finished; a HISTORICAL import requires a completed season (use LIVE for current data)`);
      }
    }

    const warnings = [...matches.warnings];
    const preparedAt = this.now();
    const withStats = await this.db.match.findMany({
      where: { source: provider.source, sourceId: { in: matches.data.map((m) => m.sourceId) }, stats: { some: {} } },
      select: { sourceId: true },
    });
    const supplementary = await fetchSupplementary(provider, request, matches.data, new Set(withStats.map((m) => m.sourceId)), preparedAt, warnings);

    return { source: provider.source, request, competition, season: season.data, matches: matches.data, supplementary, preparedAt, warnings };
  }

  // Writes a prepared import inside the caller's transaction. Appends conflict warnings to prepared.warnings.
  async apply(tx: Prisma.TransactionClient, prepared: PreparedImport, importRunId: string | null = null): Promise<ImportCounts> {
    const { source, request, warnings, season, matches } = prepared;
    const counts = emptyCounts();
    counts.sourceMatches = matches.length;
    const now = this.now();

    // Serialises concurrent syncs of the same dataset (API, CLI, worker) for the life of this transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`nexora-import:${source}:${request.competitionSourceId}/${request.seasonSourceId}`}))`;

    let competition = await tx.competition.findUnique({ where: { source_sourceId: { source, sourceId: prepared.competition.sourceId } } });
    competition ??= await tx.competition.create({
      data: { ...prepared.competition, dataEnvironment: request.dataEnvironment, source, lastUpdated: now },
    });

    // Only this competition's clubs: syncing the whole catalogue would file every club in Europe
    // under whichever league happened to be imported.
    const curatedHere = this.curatedTeams.filter((t) => t.competitionSourceId === prepared.competition.sourceId);
    const synced = await syncCuratedTeams(tx, competition.id, curatedHere, now);
    counts.teamsCreated = synced.teamsCreated;
    counts.aliasesCreated = synced.aliasesCreated;

    const seasonData = { name: season.name, startDate: season.startDate, endDate: season.endDate };
    const existingSeason = await tx.season.findUnique({ where: { source_sourceId: { source, sourceId: season.sourceId } } });
    let seasonRow = existingSeason;
    if (!seasonRow) {
      seasonRow = await tx.season.create({ data: { ...seasonData, competitionId: competition.id, source, sourceId: season.sourceId, lastUpdated: now } });
    } else if (seasonRow.startDate.getTime() !== season.startDate.getTime() || seasonRow.endDate.getTime() !== season.endDate.getTime()) {
      seasonRow = await tx.season.update({ where: { id: seasonRow.id }, data: { ...seasonData, lastUpdated: now } });
    }

    const teamIds = await new TeamIdentityResolver(tx).resolveAll(source, matches.flatMap((m) => [m.homeTeam.name, m.awayTeam.name]));
    const existing = new Map(
      (await tx.match.findMany({ where: { source, sourceId: { in: matches.map((m) => m.sourceId) } } })).map((m) => [m.sourceId, m]),
    );

    for (const m of matches) {
      const homeTeamId = teamIds.get(m.homeTeam.name)!;
      const awayTeamId = teamIds.get(m.awayTeam.name)!;
      const incoming = coreFrom(m, homeTeamId, awayTeamId);
      const current = existing.get(m.sourceId);

      if (!current) {
        const [teamAId, teamBId] = homeTeamId < awayTeamId ? [homeTeamId, awayTeamId] : [awayTeamId, homeTeamId];
        const h2h = await tx.headToHead.upsert({ where: { teamAId_teamBId: { teamAId, teamBId } }, create: { teamAId, teamBId }, update: {} });
        await tx.match.create({
          data: {
            ...incoming,
            competitionId: competition.id,
            seasonId: seasonRow.id,
            headToHeadId: h2h.id,
            dataEnvironment: request.dataEnvironment,
            source,
            sourceId: m.sourceId,
            lastUpdated: now,
            round: m.round,
          },
        });
        counts.created += 1;
        continue;
      }

      if (current.dataEnvironment !== request.dataEnvironment) {
        counts.conflicts += 1;
        warnings.push({ code: 'ENVIRONMENT_CONFLICT', sourceId: m.sourceId, message: `Stored as ${current.dataEnvironment}; refusing to relabel as ${request.dataEnvironment}.` });
        continue;
      }

      const differences = coreDifferences(current, incoming);
      if (current.status === 'FINISHED') {
        if (differences.length > 0) {
          counts.conflicts += 1;
          warnings.push({ code: 'HISTORICAL_CONFLICT', sourceId: m.sourceId, message: `Source now differs on ${differences.join(', ')}; stored record kept unchanged.` });
        } else if (current.round === null && m.round !== null) {
          await tx.match.update({ where: { id: current.id }, data: { round: m.round, lastUpdated: now } });
          counts.metadataFilled += 1;
        } else {
          counts.unchanged += 1;
        }
        continue;
      }

      if (differences.length > 0 || current.round !== m.round) {
        await tx.match.update({ where: { id: current.id }, data: { ...incoming, round: m.round, lastUpdated: now } });
        await tx.matchRevision.create({
          data: {
            matchId: current.id,
            importRunId,
            source,
            changes: describeChanges(current, { ...incoming, round: m.round }) as unknown as Prisma.InputJsonValue,
          },
        });
        counts.updated += 1;
        counts.revisionsRecorded += 1;
        if (incoming.status === 'FINISHED') counts.resultsReceived += 1;
      } else {
        counts.unchanged += 1;
      }
    }

    // A fixture that vanished from the source is never deleted or re-dated; it is flagged for review.
    const stillOpen = await tx.match.findMany({
      where: { source, seasonId: seasonRow.id, status: { not: 'FINISHED' }, sourceId: { notIn: matches.map((m) => m.sourceId) } },
      select: { sourceId: true },
    });
    for (const missing of stillOpen) {
      warnings.push({ code: 'FIXTURE_MISSING_FROM_SOURCE', sourceId: missing.sourceId, message: 'Unfinished fixture no longer present in the source; stored record left unchanged.' });
    }
    counts.missingFromSource = stillOpen.length;

    const stored = await tx.match.findMany({
      where: { source, sourceId: { in: matches.map((m) => m.sourceId) } },
      select: { id: true, sourceId: true, status: true, homeTeamId: true },
    });
    const supplementaryCounts = await ingestSupplementary(
      { tx, source, now, teamIds, matchBySourceId: new Map(stored.map((m) => [m.sourceId, m])), warnings },
      prepared.supplementary,
    );
    Object.assign(counts, supplementaryCounts);

    return counts;
  }
}
