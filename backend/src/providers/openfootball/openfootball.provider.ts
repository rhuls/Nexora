import {
  unavailable,
  type DatasetRef,
  type IDataProvider,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderCompetition,
  type ProviderMatch,
  type ProviderMatchTeamStats,
  type ProviderPlayer,
  type ProviderPlayerMatchStats,
  type ProviderSeason,
  type ProviderStanding,
  type ProviderTeam,
  type SourceFetcher,
  type SourceResult,
} from '../types.js';
import {
  OPENFOOTBALL_COMPETITIONS,
  OPENFOOTBALL_DATASETS,
  OPENFOOTBALL_SOURCE,
  findOpenFootballDataset,
  openFootballUrl,
  seasonDisplayName,
  type OpenFootballDataset,
} from './datasets.js';
import { parseOpenFootballFile, type ParsedDataset } from './parser.js';

// football.json publishes fixtures and scores only.
const CAPABILITIES: ProviderCapabilities = {
  matches: true,
  matchStats: false,
  players: false,
  playerStats: false,
  availability: false,
  standings: false,
};

// The source republishes about once a day; 30 minutes keeps refreshes cheap (ETag revalidation) without going stale.
const LIVE_MAX_AGE_MS = 30 * 60 * 1000;

export class OpenFootballProvider implements IDataProvider {
  readonly source = OPENFOOTBALL_SOURCE;
  readonly capabilities = CAPABILITIES;

  constructor(
    private readonly fetcher: SourceFetcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCompetitions(): Promise<SourceResult<ProviderCompetition[]>> {
    return { available: true, data: Object.values(OPENFOOTBALL_COMPETITIONS).map((c) => ({ ...c })), warnings: [] };
  }

  async getSeason(ref: DatasetRef): Promise<SourceResult<ProviderSeason>> {
    const parsed = await this.load(ref);
    if (parsed.matches.length === 0) return { available: false, reason: `No importable matches in ${ref.seasonSourceId}` };
    const times = parsed.matches.map((m) => m.kickoff.getTime());
    return {
      available: true,
      data: {
        sourceId: `${ref.competitionSourceId}/${ref.seasonSourceId}`,
        competitionSourceId: ref.competitionSourceId,
        name: seasonDisplayName(ref.seasonSourceId),
        startDate: new Date(Math.min(...times)),
        endDate: new Date(Math.max(...times)),
      },
      warnings: [],
    };
  }

  async getTeams(ref: DatasetRef): Promise<SourceResult<ProviderTeam[]>> {
    const parsed = await this.load(ref);
    const names = [...new Set(parsed.matches.flatMap((m) => [m.homeTeam.name, m.awayTeam.name]))].sort();
    return { available: true, data: names.map((name) => ({ sourceId: null, name, shortName: null, country: null })), warnings: [] };
  }

  async getPlayers(): Promise<SourceResult<ProviderPlayer[]>> {
    return unavailable(this.source, 'player data');
  }

  async getMatches(ref: DatasetRef): Promise<SourceResult<ProviderMatch[]>> {
    const parsed = await this.load(ref);
    return { available: true, data: parsed.matches, warnings: parsed.warnings };
  }

  async getMatch(ref: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderMatch | null>> {
    const parsed = await this.load(ref);
    return { available: true, data: parsed.matches.find((m) => m.sourceId === matchSourceId) ?? null, warnings: [] };
  }

  async getMatchStats(): Promise<SourceResult<ProviderMatchTeamStats[]>> {
    return unavailable(this.source, 'match statistics (shots, corners, cards, possession, fouls, offsides)');
  }

  async getPlayerStats(): Promise<SourceResult<ProviderPlayerMatchStats[]>> {
    return unavailable(this.source, 'player match statistics');
  }

  async getPlayerAvailability(): Promise<SourceResult<ProviderAvailability[]>> {
    return unavailable(this.source, 'injury or suspension information');
  }

  async getStandings(): Promise<SourceResult<ProviderStanding[]>> {
    return unavailable(this.source, 'standings');
  }

  datasets(): readonly OpenFootballDataset[] {
    return OPENFOOTBALL_DATASETS;
  }

  private requireDataset(ref: DatasetRef): OpenFootballDataset {
    const dataset = findOpenFootballDataset(ref.competitionSourceId, ref.seasonSourceId);
    if (!dataset) throw new Error(`Dataset ${ref.competitionSourceId} ${ref.seasonSourceId} is not on the openfootball allowlist`);
    return dataset;
  }

  private async load(ref: DatasetRef): Promise<ParsedDataset> {
    const dataset = this.requireDataset(ref);
    const maxAgeMs = dataset.dataEnvironment === 'HISTORICAL' ? Number.POSITIVE_INFINITY : LIVE_MAX_AGE_MS;
    const fetched = await this.fetcher.fetchText(openFootballUrl(dataset), { source: this.source, maxAgeMs });
    return parseOpenFootballFile(fetched.body, dataset, this.now());
  }
}
