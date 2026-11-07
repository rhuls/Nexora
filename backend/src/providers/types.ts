// Provider contract. Deliberately independent of Prisma and of the analysis engine:
// providers only describe what a source says; the importer decides what enters PostgreSQL.

export type ProviderDataEnvironment = 'SYNTHETIC' | 'HISTORICAL' | 'LIVE';
export type ProviderMatchStatus = 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'POSTPONED' | 'CANCELLED';
export type ProviderPosition = 'GOALKEEPER' | 'DEFENDER' | 'MIDFIELDER' | 'FORWARD';
export type ProviderAvailabilityStatus = 'AVAILABLE' | 'INJURED' | 'SUSPENDED' | 'DOUBTFUL' | 'UNKNOWN';

export interface SourceWarning {
  code: string;
  message: string;
  sourceId?: string;
}

// `available: false` means the source does not supply this information at all — never an empty dataset.
export type SourceResult<T> =
  | { available: true; data: T; warnings: SourceWarning[] }
  | { available: false; reason: string };

export interface ProviderCapabilities {
  matches: boolean;
  matchStats: boolean;
  players: boolean;
  playerStats: boolean;
  availability: boolean;
  standings: boolean;
}

export interface DatasetRef {
  competitionSourceId: string;
  seasonSourceId: string;
}

export interface ProviderCompetition {
  sourceId: string;
  code: string;
  name: string;
  country: string;
}

export interface ProviderSeason {
  sourceId: string;
  competitionSourceId: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

// Sources without stable team IDs identify teams by the name they print; identity is resolved later via TeamAlias.
export interface ProviderTeamRef {
  sourceId: string | null;
  name: string;
}

export interface ProviderTeam extends ProviderTeamRef {
  shortName: string | null;
  country: string | null;
}

export interface ProviderMatch {
  sourceId: string;
  competitionSourceId: string;
  seasonSourceId: string;
  round: string | null;
  homeTeam: ProviderTeamRef;
  awayTeam: ProviderTeamRef;
  kickoff: Date;
  kickoffTimeKnown: boolean;
  sourceMatchDate: string;
  status: ProviderMatchStatus;
  homeScore: number | null;
  awayScore: number | null;
  homeHalfTimeScore: number | null;
  awayHalfTimeScore: number | null;
}

export interface ProviderMatchTeamStats {
  teamSourceId: string | null;
  teamName: string;
  isHome: boolean;
  goals: number | null;
  possession: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  corners: number | null;
  yellowCards: number | null;
  redCards: number | null;
  fouls: number | null;
  offsides: number | null;
  // Richer sources only; omitted means the source never supplies the field.
  shotsOffTarget?: number | null;
  blockedShots?: number | null;
  goalkeeperSaves?: number | null;
  passes?: number | null;
  passesAccurate?: number | null;
  passAccuracy?: number | null;
  additional?: Record<string, number | null>;
  // The provider's statistics exactly as sent (type label -> raw value), for audit and null-semantics review.
  raw?: Record<string, number | string | null>;
  // Counts derived from the same fixture's event log; evidence only, never substituted for the statistics above.
  derived?: Record<string, number>;
}

export interface ProviderPlayer {
  sourceId: string;
  teamSourceId: string | null;
  name: string;
  position: ProviderPosition;
}

export interface ProviderPlayerMatchStats {
  playerSourceId: string;
  started: boolean;
  minutes: number;
  goals: number | null;
  assists: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  passes: number | null;
  tackles: number | null;
  interceptions: number | null;
  yellowCards?: number | null;
  redCards?: number | null;
  rating?: number | null;
  fouls?: number | null;
}

export interface ProviderAvailability {
  playerSourceId: string;
  status: ProviderAvailabilityStatus;
  reason: string | null;
  expectedReturn: Date | null;
  reportedAt: Date;
}

export interface ProviderStanding {
  team: ProviderTeamRef;
  position: number;
  played: number;
  points: number;
}

export interface IDataProvider {
  readonly source: string;
  readonly capabilities: ProviderCapabilities;
  getCompetitions(): Promise<SourceResult<ProviderCompetition[]>>;
  getSeason(dataset: DatasetRef): Promise<SourceResult<ProviderSeason>>;
  getTeams(dataset: DatasetRef): Promise<SourceResult<ProviderTeam[]>>;
  getPlayers(dataset: DatasetRef, team: ProviderTeamRef): Promise<SourceResult<ProviderPlayer[]>>;
  getMatches(dataset: DatasetRef): Promise<SourceResult<ProviderMatch[]>>;
  getMatch(dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderMatch | null>>;
  getMatchStats(dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderMatchTeamStats[]>>;
  getPlayerStats(dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderPlayerMatchStats[]>>;
  getPlayerAvailability(dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderAvailability[]>>;
  getStandings(dataset: DatasetRef): Promise<SourceResult<ProviderStanding[]>>;
}

export interface FetchedSource {
  body: string;
  contentHash: string;
  fetchedAt: Date;
  fromCache: boolean;
}

export interface SourceFetchPolicy {
  source: string;
  // Infinity for closed historical files: once cached they are never downloaded again.
  maxAgeMs: number;
}

export interface SourceFetcher {
  fetchText(url: string, policy: SourceFetchPolicy): Promise<FetchedSource>;
}

export function unavailable(source: string, what: string): { available: false; reason: string } {
  return { available: false, reason: `${source} does not supply ${what}` };
}

// ---- Enrichment: sources that add detail to fixtures owned by another (backbone) source. ----

export const COVERAGE_DATASETS = ['fixtures', 'events', 'lineups', 'fixtureStatistics', 'playerStatistics', 'injuries', 'players', 'standings'] as const;
export type CoverageDataset = (typeof COVERAGE_DATASETS)[number];

export interface ProviderSeasonCoverage {
  seasonSourceId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  current: boolean;
  coverage: Record<CoverageDataset, boolean>;
}

export type ProviderEventType = 'GOAL' | 'OWN_GOAL' | 'PENALTY_GOAL' | 'MISSED_PENALTY' | 'YELLOW_CARD' | 'SECOND_YELLOW' | 'RED_CARD' | 'SUBSTITUTION' | 'VAR' | 'OTHER';

export interface ProviderMatchEvent {
  // Provider event ID, or a deterministic key when the provider has none.
  sourceId: string;
  team: ProviderTeamRef;
  minute: number;
  extraMinute: number | null;
  type: ProviderEventType;
  detail: string | null;
  playerSourceId: string | null;
  playerName: string | null;
  // For substitutions the provider's second player; for goals the assist. Stored as supplied, not reinterpreted.
  relatedPlayerSourceId: string | null;
  relatedPlayerName: string | null;
  comments: string | null;
}

export interface ProviderLineupPlayer {
  sourceId: string | null;
  name: string;
  number: number | null;
  position: ProviderPosition | null;
  grid: string | null;
}

export interface ProviderLineup {
  team: ProviderTeamRef;
  formation: string | null;
  coachName: string | null;
  startXI: ProviderLineupPlayer[];
  substitutes: ProviderLineupPlayer[];
}

export interface ProviderFixturePlayerStats extends ProviderPlayerMatchStats {
  name: string;
  position: ProviderPosition | null;
}

// Everything a source reported about one fixture. A null section means the source returned nothing for it.
export interface ProviderMatchDetails {
  match: ProviderMatch;
  fetchedAt: Date;
  stats: ProviderMatchTeamStats[] | null;
  events: ProviderMatchEvent[] | null;
  lineups: ProviderLineup[] | null;
  players: Array<{ team: ProviderTeamRef; players: ProviderFixturePlayerStats[] }> | null;
  warnings: SourceWarning[];
}

export interface ProviderInjuryReport {
  player: { sourceId: string; name: string };
  team: ProviderTeamRef;
  matchSourceId: string;
  status: ProviderAvailabilityStatus;
  reason: string | null;
  sourceType: string | null;
  expectedReturn: Date | null;
  // When Nexora learned of the report. Sources without a publication date are never back-dated.
  reportedAt: Date;
}

export interface DetailsResult {
  details: ProviderMatchDetails[];
  // Requested but not obtained (budget exhausted, rate limited, not cached in a dry-run, or absent from the response).
  notFetched: string[];
}

export interface RequestStats {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  rateLimited: number;
  // Requests a dry-run (or an exhausted budget) did not make, as endpoint + parameters without credentials.
  planned: string[];
  stoppedReason: string | null;
}

export interface IEnrichmentProvider {
  readonly source: string;
  isConfigured(): boolean;
  requestStats(): RequestStats;
  getSeasonCoverage(competitionSourceId: string): Promise<SourceResult<ProviderSeasonCoverage[]>>;
  getFixtures(dataset: DatasetRef, options?: { from?: string; to?: string; maxAgeMs?: number }): Promise<SourceResult<ProviderMatch[]>>;
  getFixturesByDate(dataset: DatasetRef, date: string): Promise<SourceResult<ProviderMatch[]>>;
  getUpcomingFixtures(dataset: DatasetRef, count: number): Promise<SourceResult<ProviderMatch[]>>;
  getFinishedFixtures(dataset: DatasetRef): Promise<SourceResult<ProviderMatch[]>>;
  getFixtureDetails(matchSourceIds: readonly string[], maxAgeMs: (matchSourceId: string) => number): Promise<DetailsResult>;
  getInjuries(dataset: DatasetRef, maxAgeMs: number): Promise<SourceResult<ProviderInjuryReport[]>>;
  getSquad(teamSourceId: string): Promise<SourceResult<ProviderPlayer[]>>;
}

export function isEnrichmentProvider(provider: object): provider is IEnrichmentProvider {
  return typeof (provider as Partial<IEnrichmentProvider>).getFixtureDetails === 'function';
}

// ---- Odds: sources that price a fixture. Separate from IDataProvider (which owns fixtures) and from
// IEnrichmentProvider (which adds detail to them). An odds source adds neither; it only quotes a market. ----

export type OddsMarket = 'MATCH_RESULT' | 'OVER_UNDER_25' | 'BTTS';

export interface ProviderOdds {
  matchSourceId: string;
  bookmaker: string;
  market: OddsMarket;
  // Decimal odds keyed by outcome: home/draw/away, over/under, or yes/no.
  prices: Record<string, number>;
  // When the bookmaker published this price. Sources without one are not back-dated.
  capturedAt: Date;
  sourceId: string | null;
}

export interface IOddsProvider {
  readonly source: string;
  isConfigured(): boolean;
  getOdds(dataset: DatasetRef, options?: { from?: string; to?: string }): Promise<SourceResult<ProviderOdds[]>>;
  getOddsForMatch(dataset: DatasetRef, matchSourceId: string): Promise<SourceResult<ProviderOdds[]>>;
}

export function isOddsProvider(provider: object): provider is IOddsProvider {
  return typeof (provider as Partial<IOddsProvider>).getOddsForMatch === 'function';
}
