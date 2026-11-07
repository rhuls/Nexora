import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../../src/config/providers.js';
import type { CuratedTeam } from '../../src/data/identity/curated-teams.js';
import { FootballDataImporter, type ImportCounts } from '../../src/data/import/football-data.importer.js';
import { KnowledgeService } from '../../src/data/knowledge/knowledge.service.js';
import { OPENFOOTBALL_DATASETS } from '../../src/providers/openfootball/datasets.js';
import { parseOpenFootballFile } from '../../src/providers/openfootball/parser.js';
import type {
  DatasetRef,
  IDataProvider,
  ProviderAvailability,
  ProviderMatch,
  ProviderMatchTeamStats,
  ProviderPlayer,
  ProviderPlayerMatchStats,
  ProviderTeamRef,
  SourceResult,
} from '../../src/providers/types.js';
import { localDayBounds } from '../../src/utils/time.js';

const prisma = new PrismaClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SOURCE = 'test-live';
const REF: DatasetRef = { competitionSourceId: 'test.1', seasonSourceId: '2026-27' };

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 120_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

const TEAMS: CuratedTeam[] = [
  { key: 'test-north', competitionSourceId: REF.competitionSourceId, name: 'North Test', shortName: 'TNO', country: 'Testland', aliases: { [SOURCE]: ['North Test FC'] } },
  { key: 'test-south', competitionSourceId: REF.competitionSourceId, name: 'South Test', shortName: 'TSO', country: 'Testland', aliases: { [SOURCE]: ['South Test FC'] } },
  { key: 'test-east', competitionSourceId: REF.competitionSourceId, name: 'East Test', shortName: 'TEA', country: 'Testland', aliases: { [SOURCE]: ['East Test FC'] } },
];
const team = (name: string): ProviderTeamRef => ({ sourceId: null, name });

// A scripted provider whose state each test rewrites between syncs, standing in for a full-featured live feed.
class ScriptedProvider implements IDataProvider {
  readonly source = SOURCE;
  readonly capabilities = { matches: true, matchStats: true, players: true, playerStats: true, availability: true, standings: false };
  matches: ProviderMatch[] = [];
  players: Record<string, ProviderPlayer[]> = {};
  stats: Record<string, ProviderMatchTeamStats[]> = {};
  playerStats: Record<string, ProviderPlayerMatchStats[]> = {};
  availability: Record<string, ProviderAvailability[]> = {};

  private ok<T>(data: T): SourceResult<T> {
    return { available: true, data, warnings: [] };
  }
  async getCompetitions() {
    return this.ok([{ sourceId: REF.competitionSourceId, code: 'TST', name: 'Test Live League', country: 'Testland' }]);
  }
  async getSeason() {
    const t = this.matches.map((m) => m.kickoff.getTime());
    return this.ok({ sourceId: 'test.1/2026-27', competitionSourceId: 'test.1', name: '2026/27', startDate: new Date(Math.min(...t)), endDate: new Date(Math.max(...t)) });
  }
  async getTeams() {
    return this.ok(TEAMS.map((t) => ({ sourceId: null, name: t.aliases[SOURCE]![0]!, shortName: null, country: null })));
  }
  async getPlayers(_ref: DatasetRef, t: ProviderTeamRef) {
    return this.ok(this.players[t.name] ?? []);
  }
  async getMatches() {
    return this.ok(this.matches.map((m) => ({ ...m })));
  }
  async getMatch(_ref: DatasetRef, id: string) {
    return this.ok(this.matches.find((m) => m.sourceId === id) ?? null);
  }
  async getMatchStats(_ref: DatasetRef, id: string) {
    return this.ok(this.stats[id] ?? []);
  }
  async getPlayerStats(_ref: DatasetRef, id: string) {
    return this.ok(this.playerStats[id] ?? []);
  }
  async getPlayerAvailability(_ref: DatasetRef, id: string) {
    return this.ok(this.availability[id] ?? []);
  }
  async getStandings() {
    return { available: false as const, reason: 'not supplied' };
  }
}

function fixture(id: string, home: string, away: string, kickoff: Date, result?: [number, number]): ProviderMatch {
  return {
    sourceId: id,
    competitionSourceId: REF.competitionSourceId,
    seasonSourceId: REF.seasonSourceId,
    round: 'Matchday 1',
    homeTeam: team(home),
    awayTeam: team(away),
    kickoff,
    kickoffTimeKnown: true,
    sourceMatchDate: kickoff.toISOString(),
    status: result ? 'FINISHED' : 'SCHEDULED',
    homeScore: result?.[0] ?? null,
    awayScore: result?.[1] ?? null,
    homeHalfTimeScore: null,
    awayHalfTimeScore: null,
  };
}

const teamStats = (name: string, isHome: boolean, v: Partial<ProviderMatchTeamStats>): ProviderMatchTeamStats => ({
  teamSourceId: null, teamName: name, isHome, goals: null, possession: null, shots: null, shotsOnTarget: null, corners: null, yellowCards: null, redCards: null, fouls: null, offsides: null, ...v,
});

const T0 = new Date();
const today = localDayBounds(T0, 'UTC');
const TODAY_KICKOFF = new Date(Math.max(T0.getTime() + 60_000, Math.min(T0.getTime() + 2 * HOUR, today.end.getTime() - 60_000)));

function scenario() {
  const provider = new ScriptedProvider();
  let clock = T0;
  const importer = new FootballDataImporter(prisma, TEAMS, () => clock);
  const setClock = (d: Date) => (clock = d);
  const sync = async (tx: Prisma.TransactionClient): Promise<{ counts: ImportCounts; codes: string[] }> => {
    const prepared = await importer.prepare(provider, { ...REF, dataEnvironment: 'LIVE' });
    const counts = await importer.apply(tx, prepared);
    return { counts, codes: prepared.warnings.map((w) => w.code) };
  };
  provider.matches = [
    fixture('today', 'North Test FC', 'South Test FC', TODAY_KICKOFF),
    fixture('future', 'South Test FC', 'East Test FC', new Date(T0.getTime() + 5 * DAY)),
    fixture('pending', 'East Test FC', 'North Test FC', new Date(T0.getTime() - 2 * HOUR)),
  ];
  for (const t of TEAMS) {
    const name = t.aliases[SOURCE]![0]!;
    provider.players[name] = [1, 2].map((n) => ({ sourceId: `${t.key}-p${n}`, teamSourceId: null, name: `${t.name} Player ${n}`, position: n === 1 ? 'FORWARD' : 'DEFENDER' }));
  }
  provider.availability.today = [{ playerSourceId: 'test-north-p1', status: 'INJURED', reason: 'Hamstring', expectedReturn: null, reportedAt: new Date(T0.getTime() - DAY) }];
  return { provider, importer, sync, setClock };
}

let tables: { liveTeams: number } = { liveTeams: 0 };
beforeAll(async () => {
  tables = { liveTeams: await prisma.team.count({ where: { sourceId: { startsWith: 'test-' } } }) };
  if (tables.liveTeams !== 0) throw new Error('Test teams already exist outside a rolled-back transaction');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('live/current data ingestion (scripted provider, rolled back)', () => {
  it("imports today's and future fixtures as SCHEDULED LIVE data with provenance and no invented statistics", async () => {
    const { sync } = scenario();
    await inRollback(async (tx) => {
      const { counts } = await sync(tx);
      expect(counts).toMatchObject({ created: 3, playersCreated: 6, availabilityReportsCreated: 1, statsCreated: 0, playerStatsCreated: 0 });

      const stored = await tx.match.findMany({ where: { source: SOURCE }, orderBy: { matchDate: 'asc' } });
      expect(stored.map((m) => [m.sourceId, m.status, m.dataEnvironment])).toEqual([
        ['pending', 'SCHEDULED', 'LIVE'],
        ['today', 'SCHEDULED', 'LIVE'],
        ['future', 'SCHEDULED', 'LIVE'],
      ]);
      expect(stored.every((m) => m.homeScore === null && m.awayScore === null && m.lastUpdated && m.source === SOURCE)).toBe(true);

      const todays = await tx.match.findMany({ where: { source: SOURCE, matchDate: { gte: today.start, lt: today.end } } });
      expect(todays.map((m) => m.sourceId)).toContain('today');
      expect(await tx.matchTeamStats.count({ where: { match: { source: SOURCE } } })).toBe(0);
    });
  });

  it('is idempotent across repeated syncs: no duplicate fixtures, players or availability reports', async () => {
    const { sync, setClock } = scenario();
    await inRollback(async (tx) => {
      await sync(tx);
      setClock(new Date(T0.getTime() + 60_000));
      const { counts } = await sync(tx);
      expect(counts).toMatchObject({ created: 0, updated: 0, unchanged: 3, revisionsRecorded: 0, playersCreated: 0, availabilityReportsCreated: 0 });
      expect(await tx.match.count({ where: { source: SOURCE } })).toBe(3);
      expect(await tx.player.count({ where: { source: SOURCE } })).toBe(6);
      expect(await tx.playerAvailability.count({ where: { source: SOURCE } })).toBe(1);
    });
  });

  it('applies fixture changes and results safely, audits them, and keeps missing statistics unavailable', async () => {
    const { provider, sync, setClock } = scenario();
    await inRollback(async (tx) => {
      await sync(tx);
      setClock(new Date(T0.getTime() + 10 * 60_000));
      provider.matches = provider.matches.map((m) =>
        m.sourceId === 'future' ? { ...m, kickoff: new Date(T0.getTime() + 6 * DAY) } : m.sourceId === 'pending' ? { ...m, status: 'FINISHED', homeScore: 2, awayScore: 1 } : m,
      );
      provider.stats.pending = [
        teamStats('East Test FC', true, { goals: 2, possession: 55, shots: 10, shotsOnTarget: 4, yellowCards: 2, redCards: 0 }),
        teamStats('North Test FC', false, { goals: 1, possession: 45, shots: 7, shotsOnTarget: 2, yellowCards: 1, redCards: 0 }),
      ];
      provider.playerStats.pending = [
        { playerSourceId: 'test-east-p1', started: true, minutes: 90, goals: 2, assists: 0, shots: 5, shotsOnTarget: 3, passes: null, tackles: null, interceptions: null },
      ];
      provider.availability.today.push({ playerSourceId: 'test-north-p1', status: 'AVAILABLE', reason: null, expectedReturn: null, reportedAt: new Date(T0.getTime() + 5 * 60_000) });

      const { counts } = await sync(tx);
      expect(counts).toMatchObject({ updated: 2, resultsReceived: 1, revisionsRecorded: 2, statsCreated: 2, playerStatsCreated: 1, availabilityReportsCreated: 1 });

      const future = await tx.match.findUniqueOrThrow({ where: { source_sourceId: { source: SOURCE, sourceId: 'future' } }, include: { revisions: true } });
      expect(future.matchDate.getTime()).toBe(T0.getTime() + 6 * DAY);
      expect(future.revisions).toHaveLength(1);
      expect(Object.keys(future.revisions[0]!.changes as object)).toEqual(['matchDate']);

      const pending = await tx.match.findUniqueOrThrow({ where: { source_sourceId: { source: SOURCE, sourceId: 'pending' } }, include: { stats: true, playerStats: true } });
      expect(pending).toMatchObject({ status: 'FINISHED', homeScore: 2, awayScore: 1, homeHalfTimeScore: null });
      const east = pending.stats.find((s) => s.isHome)!;
      expect(east).toMatchObject({ shots: 10, corners: null, fouls: null, offsides: null, source: SOURCE });
      expect(pending.playerStats[0]).toMatchObject({ goals: 2, passes: null, tackles: null });

      const reports = await tx.playerAvailability.findMany({ where: { source: SOURCE }, orderBy: { reportedAt: 'asc' } });
      expect(reports.map((r) => r.status)).toEqual(['INJURED', 'AVAILABLE']);
    });
  });

  it('never overwrites a finished result, fills only missing statistics, and never deletes vanished fixtures', async () => {
    const { provider, sync, setClock } = scenario();
    await inRollback(async (tx) => {
      await sync(tx);
      provider.matches = provider.matches.map((m) => (m.sourceId === 'pending' ? { ...m, status: 'FINISHED', homeScore: 2, awayScore: 1 } : m));
      provider.stats.pending = [teamStats('East Test FC', true, { goals: 2, shots: 10 }), teamStats('North Test FC', false, { goals: 1, shots: 7 })];
      setClock(new Date(T0.getTime() + 10 * 60_000));
      await sync(tx);

      provider.matches = provider.matches.filter((m) => m.sourceId !== 'future').map((m) => (m.sourceId === 'pending' ? { ...m, homeScore: 3 } : m));
      provider.stats.pending = [teamStats('East Test FC', true, { goals: 2, shots: 12, corners: 5 }), teamStats('North Test FC', false, { goals: 1, shots: 7 })];
      provider.availability.today.push({ playerSourceId: 'test-north-p2', status: 'DOUBTFUL', reason: null, expectedReturn: null, reportedAt: new Date(T0.getTime() + DAY) });
      setClock(new Date(T0.getTime() + 20 * 60_000));
      const { counts, codes } = await sync(tx);

      expect(counts).toMatchObject({ conflicts: 1, missingFromSource: 1, statsFilled: 1 });
      expect(codes).toEqual(expect.arrayContaining(['HISTORICAL_CONFLICT', 'STATS_CONFLICT', 'FIXTURE_MISSING_FROM_SOURCE', 'FUTURE_REPORT']));

      const pending = await tx.match.findUniqueOrThrow({ where: { source_sourceId: { source: SOURCE, sourceId: 'pending' } }, include: { stats: true } });
      expect(pending.homeScore).toBe(2);
      expect(pending.stats.find((s) => s.isHome)).toMatchObject({ shots: 10, corners: 5 });
      expect(await tx.match.count({ where: { source: SOURCE, sourceId: 'future', status: 'SCHEDULED' } })).toBe(1);
      expect(await tx.playerAvailability.count({ where: { source: SOURCE, status: 'DOUBTFUL' } })).toBe(0);
    });
  });

  it('builds pre-kickoff knowledge for a current fixture from the latest information only', async () => {
    const { provider, sync, setClock } = scenario();
    await inRollback(async (tx) => {
      provider.matches = provider.matches.map((m) => (m.sourceId === 'pending' ? { ...m, status: 'FINISHED', homeScore: 2, awayScore: 1 } : m));
      await sync(tx);
      provider.availability.today.push({ playerSourceId: 'test-north-p1', status: 'AVAILABLE', reason: null, expectedReturn: null, reportedAt: new Date(T0.getTime() + 5 * 60_000) });
      setClock(new Date(T0.getTime() + 10 * 60_000));
      await sync(tx);

      const todayMatch = await tx.match.findUniqueOrThrow({ where: { source_sourceId: { source: SOURCE, sourceId: 'today' } } });
      const k = await new KnowledgeService(tx).reconstruct(todayMatch.id);
      expect(k.dataEnvironment).toBe('LIVE');
      expect(k.integrity.allInputsBeforeCutoff).toBe(true);
      const reportTimes = [T0.getTime() - DAY, T0.getTime() + 5 * 60_000];
      const expectedReports = reportTimes.filter((t) => t < todayMatch.matchDate.getTime()).length;
      expect(k.availability).toMatchObject({ status: 'REPORTED', reportsBeforeCutoff: expectedReports, playersReported: 1, reportsIgnoredAfterCutoff: reportTimes.length - expectedReports });
      const pendingKnownAt = T0.getTime() - 2 * HOUR + 3 * HOUR;
      expect(k.home.recent.map((r) => r.opponent.name)).toEqual(pendingKnownAt < todayMatch.matchDate.getTime() ? ['East Test'] : []);
      for (const r of [...k.home.recent, ...k.away.recent]) expect(r.dataEnvironment).not.toBe('SYNTHETIC');
    });
  });

  it('refuses to evaluate a forecast when the match was later moved before the forecast time', async () => {
    const { provider, sync, setClock } = scenario();
    await inRollback(async (tx) => {
      await sync(tx);
      const future = await tx.match.findUniqueOrThrow({ where: { source_sourceId: { source: SOURCE, sourceId: 'future' } } });
      const run = await tx.analysisRun.create({ data: { matchId: future.id, modelVersionId: 'mv_1_0', dataEnvironment: 'LIVE', status: 'COMPLETED', asOf: T0 } });
      const prediction = await tx.prediction.create({
        data: { matchId: future.id, modelVersionId: 'mv_1_0', analysisRunId: run.id, dataEnvironment: 'LIVE', target: 'GOALS', predictedValue: 2.4, confidence: 'LOW', confidenceScore: 0.3, featuresUsed: {}, asOf: T0 },
      });

      provider.matches = provider.matches.map((m) => (m.sourceId === 'future' ? { ...m, kickoff: new Date(T0.getTime() - HOUR), status: 'FINISHED', homeScore: 1, awayScore: 1 } : m));
      setClock(new Date(T0.getTime() + 60_000));
      await sync(tx);

      await expect(
        tx.predictionResult.create({ data: { predictionId: prediction.id, actualValue: 2, error: 0.4, absoluteError: 0.4, squaredError: 0.16 } }),
      ).rejects.toThrow(/cannot be evaluated/);
    });
  });
});

describe('real openfootball data: historical and current seasons stay separated', () => {
  const openfootball = createProviderRegistry(prisma).get('openfootball');
  const importer = new FootballDataImporter(prisma);

  it('stores 2026/27 as LIVE: real results FINISHED, everything else SCHEDULED with no scores', async () => {
    const cached = await prisma.externalSourceCache.findFirstOrThrow({ where: { url: { contains: '/2026-27/en.1.json' } } });
    const raw = (JSON.parse(cached.body) as { matches: Array<{ team1: string; team2: string; score?: unknown }> }).matches;
    const withResult = new Set(raw.filter((m) => m.score !== undefined).map((m) => `en.1/2026-27/${m.team1}~${m.team2}`));

    const live = await prisma.match.findMany({ where: { source: 'openfootball', sourceId: { startsWith: 'en.1/2026-27/' } } });
    expect(live).toHaveLength(raw.length);
    expect(live.every((m) => m.dataEnvironment === 'LIVE')).toBe(true);
    for (const m of live) {
      if (withResult.has(m.sourceId)) expect(m).toMatchObject({ status: 'FINISHED' });
      else expect(m).toMatchObject({ status: 'SCHEDULED', homeScore: null, awayScore: null, homeHalfTimeScore: null });
    }
    expect(live.filter((m) => m.status === 'SCHEDULED' && m.matchDate.getTime() > Date.now()).length).toBeGreaterThan(0);
  });

  it('keeps all three past seasons HISTORICAL and refuses to relabel them as LIVE', async () => {
    expect(await prisma.match.count({ where: { source: 'openfootball', dataEnvironment: 'HISTORICAL' } })).toBe(1140);
    const prepared = await importer.prepare(openfootball, { competitionSourceId: 'en.1', seasonSourceId: '2025-26', dataEnvironment: 'LIVE' });
    await inRollback(async (tx) => {
      const counts = await importer.apply(tx, prepared);
      expect(counts).toMatchObject({ created: 0, updated: 0, conflicts: 380 });
      expect(await tx.match.count({ where: { source: 'openfootball', sourceId: { startsWith: 'en.1/2025-26/' }, dataEnvironment: 'HISTORICAL' } })).toBe(380);
    });
  });

  it('refuses a HISTORICAL import of the unfinished current season', async () => {
    await expect(importer.prepare(openfootball, { competitionSourceId: 'en.1', seasonSourceId: '2026-27', dataEnvironment: 'HISTORICAL' })).rejects.toThrow(/not finished/);
  });

  it('re-syncing the current season is idempotent', async () => {
    const prepared = await importer.prepare(openfootball, { competitionSourceId: 'en.1', seasonSourceId: '2026-27', dataEnvironment: 'LIVE' });
    await inRollback(async (tx) => {
      const counts = await importer.apply(tx, prepared);
      expect(counts).toMatchObject({ created: 0, updated: 0, conflicts: 0, revisionsRecorded: 0, missingFromSource: 0, unchanged: prepared.matches.length });
    });
  });

  it("classifies a real matchday correctly for 'today' at different times of that day", async () => {
    const cached = await prisma.externalSourceCache.findFirstOrThrow({ where: { url: { contains: '/2026-27/en.1.json' } } });
    const dataset = OPENFOOTBALL_DATASETS.find((d) => d.seasonSourceId === '2026-27')!;
    const firstUpcoming = parseOpenFootballFile(cached.body, dataset, new Date())
      .matches.filter((m) => m.status === 'SCHEDULED' && m.kickoff.getTime() > Date.now())
      .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime())[0]!;
    const day = localDayBounds(firstUpcoming.kickoff, 'Europe/London');

    const morning = parseOpenFootballFile(cached.body, dataset, new Date(day.start.getTime() + 8 * HOUR));
    const todays = morning.matches.filter((m) => m.kickoff >= day.start && m.kickoff < day.end);
    expect(todays.length).toBeGreaterThan(0);
    expect(todays.every((m) => m.status === 'SCHEDULED')).toBe(true);
    expect(morning.warnings.filter((w) => w.code === 'RESULT_PENDING' && todays.some((m) => m.sourceId === w.sourceId))).toHaveLength(0);

    const lateEvening = parseOpenFootballFile(cached.body, dataset, new Date(day.end.getTime() - 60_000));
    const pendingToday = lateEvening.warnings.filter((w) => w.code === 'RESULT_PENDING' && todays.some((m) => m.sourceId === w.sourceId));
    expect(pendingToday).toHaveLength(todays.length);
    expect(lateEvening.matches.filter((m) => todays.some((t) => t.sourceId === m.sourceId)).every((m) => m.status === 'SCHEDULED' && m.homeScore === null)).toBe(true);
  });
});
