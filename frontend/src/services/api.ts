export const DATA_UNAVAILABLE = 'DATA UNAVAILABLE' as const;
export type DataEnvironment = 'SYNTHETIC' | 'HISTORICAL' | 'LIVE';
export type Maybe = number | typeof DATA_UNAVAILABLE;

export interface Metric {
  value: Maybe;
  sampleSize: number;
  window: number;
}

export interface TeamRef {
  id: string;
  name: string;
  shortName?: string;
}

export interface MatchSummary {
  id: string;
  matchDate: string;
  status: string;
  dataEnvironment: DataEnvironment;
  round: string | null;
  competition: { id: string; name: string };
  season: { id: string; name: string };
  homeTeam: TeamRef;
  awayTeam: TeamRef;
  homeScore: number | null;
  awayScore: number | null;
  provenance: { source: string; sourceId: string; lastUpdated: string; sourceMatchDate: string | null; kickoffTimeKnown: boolean };
}

export interface FormAnalysis {
  team: TeamRef;
  scope: 'ALL' | 'HOME' | 'AWAY';
  status: string;
  sequence: Array<'W' | 'D' | 'L'>;
  record: { wins: number; draws: number; losses: number };
  pointsPerGame: Metric;
  averageGoalsScored: Metric;
  averageGoalsConceded: Metric;
  averagePossession: Metric;
  averageShots: Metric;
  averageShotsOnTarget: Metric;
  averageCorners: Metric;
  averageYellowCards: Metric;
  averageRedCards: Metric;
  matches: Array<{ matchId: string; matchDate: string; venue: string; opponent: TeamRef; goalsFor: number; goalsAgainst: number; outcome: string }>;
  metadata: { calculationWindow: number; sampleSize: number; cutoff: string; dataEnvironments: DataEnvironment[] };
  limitations: string[];
}

export interface TeamFormBundle {
  overall: FormAnalysis;
  homeAway: { home: FormAnalysis; away: FormAnalysis };
}

export interface MatchForm {
  matchId: string;
  cutoff: string;
  dataEnvironment: DataEnvironment;
  home: TeamFormBundle;
  away: TeamFormBundle;
}

export interface H2H {
  subjectHome: TeamRef;
  subjectAway: TeamRef;
  status: string;
  meetingsUsed: number;
  halfLifeDays: number;
  effectiveSampleSize: number;
  reliability: number;
  results: { subjectHomeWins: number; draws: number; subjectAwayWins: number };
  totalGoals: { unweighted: Metric; timeWeighted: Metric };
  totalCorners: { unweighted: Metric; timeWeighted: Metric };
  meetings: Array<{ matchId: string; matchDate: string; weight: number; subjectHomeGoals: number; subjectAwayGoals: number; outcomeForSubjectHome: string }>;
  limitations: string[];
}

export interface UnavailablePlayer {
  player: { id: string; name: string; position: string };
  status: string;
  reason: string | null;
  impactScore: number | null;
  impactLabel: string;
  impactConfidence: string | null;
}

export interface TeamAvailability {
  team: TeamRef;
  status: 'REPORTED' | typeof DATA_UNAVAILABLE;
  unavailableCount: number;
  doubtfulCount: number;
  combinedImpact: number | null;
  confidence: string;
  players: UnavailablePlayer[];
  limitations: string[];
}

export interface AvailabilityResponse {
  matchId: string;
  cutoff: string;
  home: { availability: TeamAvailability };
  away: { availability: TeamAvailability };
}

export interface Confidence {
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  score: number;
  reasons: string[];
}

export interface MatchAnalysis {
  modelVersion: string;
  asOf: string;
  resultTrend: { lean: string; probabilities: { home: number; draw: number; away: number }; explanation: string } | null;
  goalTrend: { expectedTotal: number; explanation: string } | null;
  cornerTrend: { expectedTotal: number; explanation: string } | null;
  cardTrend: { expectedTotal: number; explanation: string } | null;
  attackingComparison: string[];
  defensiveComparison: string[];
  availabilityComparison: string[];
  confidence: Confidence;
  keyFactors: string[];
  supportingFactors: string[];
  conflictingFactors: string[];
  warnings: string[];
  dataLimitations: string[];
  dataQuality: { status: string; featuresAvailable: number; featuresTotal: number };
  models: Array<{ model: string; kind: string; status: string; notes: string[] }>;
}

export interface StoredAnalysis {
  matchId: string;
  status: 'ANALYSED' | 'NOT_ANALYSED';
  mode?: 'PROSPECTIVE' | 'BACKTEST';
  modelVersion?: string;
  asOf?: string;
  analysis?: MatchAnalysis;
  predictions?: Array<{ target: string; predictedValue: number; predictedLabel: string | null; confidence: string; result: { actualValue: number; actualLabel: string | null; absoluteError: number; wasCorrect: boolean | null } | null }>;
}

export interface Performance {
  dataEnvironment: DataEnvironment;
  currentModel: string;
  isEvidenceOfRealPerformance: boolean;
  includesBacktests: boolean;
  matchesEvaluated: number;
  forecastsEvaluated: number;
  window: { from: string; to: string } | null;
  byTarget: Record<string, Record<string, unknown> & { n: number }>;
  errorAnalysis: Array<{ target: string; n: number; findings: Array<{ category: string; explanation: string }> }>;
  overTime: Array<{ month: string; target: string; n: number; meanAbsoluteError: number }>;
}

export interface ModelVersionItem {
  version: string;
  status: string;
  dataEnvironment: DataEnvironment | null;
  parent: string | null;
  trainingWindow: { start: string; end: string | null } | null;
  matchesEvaluated: number;
  notes: string | null;
  createdAt: string;
  weights: Array<{ feature: string; weight: number; previousWeight: number | null; reason: string | null }>;
}

export interface LearningEventItem {
  id: string;
  type: string;
  dataEnvironment: DataEnvironment;
  fromVersion: string | null;
  toVersion: string | null;
  feature: string | null;
  previousWeight: number | null;
  proposedWeight: number | null;
  reason: string;
  createdAt: string;
}

export interface QualityReport {
  asOf: string;
  status: string;
  checks: Array<{ check: string; status: 'PASS' | 'WARN' | 'FAIL'; count: number; detail: string }>;
  coverage: Array<{ dataEnvironment: string; finishedMatches: number; withoutAnyStatistics: number; missingCorners: number; missingPossession: number; missingCards: number }>;
}

export interface Freshness {
  asOf: string;
  datasets: Array<{ dataset: string; dataEnvironment: DataEnvironment; lastSuccessfulImportAt: string | null; sourceFetchedAt: string | null; matches: number; finished: number; scheduled: number; awaitingResult: number; nextKickoff: string | null }>;
}

// ---- Debate layer ----

export type DebateMarket = 'MATCH_RESULT' | 'OVER_UNDER_25' | 'BTTS';
export type DebateRecommendation = 'PICK' | 'LEAN' | 'NO_PICK';
export type DebateAgentName = 'SCOUT' | 'COPYCAT' | 'SKEPTIC' | 'BOOKKEEPER';

export interface DebateFact {
  key: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  source: string;
  asOf: string | null;
  sampleSize: number | null;
  unavailable: boolean;
  staleHours: number | null;
}

export interface DebateObjection {
  code: string;
  summary: string;
  severity: 'NOTE' | 'CONCERN' | 'VETO';
  targetAgent: DebateAgentName;
  market: DebateMarket | null;
}

export interface DebateVerdict {
  market: DebateMarket;
  probabilities: Record<string, number> | null;
  marketBaseline: Record<string, number> | null;
  edge: number | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  recommendation: DebateRecommendation;
  reasoning: string;
  unresolvedObjections: string[];
  stakePct: number | null;
  stakeReason: string;
  calibration: { bucket: string; observed: number | null; expected: number | null; sampleSize: number; trustworthy: boolean; note: string };
}

export interface DebateTranscript {
  fixture: string;
  kickoff: string;
  asOf: string;
  dataEnvironment: DataEnvironment;
  modelVersion: string;
  rounds: {
    one: {
      evidence: { facts: DebateFact[]; missing: string[]; stale: string[]; dataQuality: { status: string; featuresAvailable: number; featuresTotal: number } };
      baseline: { status: string; reason: string; bookmaker: string | null; capturedAt: string | null; overround: Record<string, number>; method: string | null };
    };
    two: { objections: DebateObjection[]; responses: Array<{ code: string; agent: DebateAgentName; response: string; conceded: boolean }> };
    three: { verdicts: DebateVerdict[]; lastObjections: DebateObjection[] };
    four: { notes: string[] };
  };
  verdicts: DebateVerdict[];
}

export interface StoredDebate {
  status: 'DEBATED' | 'NOT_DEBATED';
  debateRunId?: string;
  asOf?: string;
  transcript?: DebateTranscript;
}

export interface BookkeeperReport {
  dataEnvironment: string;
  settledPicks: number;
  overall: { n: number; accuracy: number | null; brier: number | null; logLoss: number | null; note: string };
  byMarket: Record<string, { n: number; accuracy: number | null; brier: number | null; logLoss: number | null; note: string }>;
  byConfidence: Array<{ bucket: string; n: number; predicted: number | null; observed: number | null; trustworthy: boolean; note: string }>;
  roi: { settled: number; priced: number; returned: number; roi: number | null; significant: boolean; note: string };
  agentAccuracy: Array<{ agent: DebateAgentName; scoredClaims: number; correct: number; accuracy: number | null; trustworthy: boolean; note: string }>;
}

export interface DebateRunRow {
  id: string;
  matchId: string;
  fixture: string;
  kickoff: string;
  matchStatus: string;
  dataEnvironment: DataEnvironment;
  status: string;
  asOf: string;
  picks: Array<{ market: DebateMarket; recommendation: DebateRecommendation; confidence: string; edge: number | null; stakePct: number | null; result: { wasCorrect: boolean; brier: number } | null }>;
}

// ---- Blackjack ----

export type BlackjackAction = 'Stand' | 'Hit' | 'Double' | 'Split' | 'Surrender';

export interface BlackjackRules {
  decks: number;
  hitSoft17: boolean;
  doubleAnyTwo: boolean;
  das: boolean;
  surrender: boolean;
  blackjackPays: number;
  peek: boolean;
}

export interface BlackjackDecision {
  actions: Array<{ action: BlackjackAction; ev: number }>;
  best: { action: BlackjackAction; ev: number };
  margin: number | null;
  total: number;
  soft: boolean;
  dealerDistribution: number[];
  unseenCards: number;
}

export interface BlackjackChart {
  rules: BlackjackRules;
  upcards: number[];
  cells: number;
  rows: Array<{
    kind: 'hard' | 'soft' | 'pair';
    label: string;
    cells: Array<{ upcard: number; action: BlackjackAction; code: string; ev: number; margin: number }>;
  }>;
}

export interface BlackjackEdge {
  playerEV: number;
  houseEdge: number;
  reliability: 'GOOD' | 'INDICATIVE';
  note: string;
}

export interface BlackjackSimulation {
  rounds: number;
  seed: number;
  net: number;
  evPerRound: number;
  standardDeviation: number;
  interval95: [number, number];
  settledHands: number;
  winRate: number;
  lossRate: number;
  pushRate: number;
  pWinDecided: number;
  streaks: Array<{ length: number; observed: number; independent: number; ratio: number }>;
  computedEV: number;
  agrees: boolean;
}

export interface TrainerSituation {
  kind: 'hard' | 'soft' | 'pair';
  value: number;
  upcard: number;
  key: string;
  label: string;
}

export interface TrainerDeal {
  player: number[];
  upcard: number;
  hole: number;
  situation: TrainerSituation;
  drilled: boolean;
  reshuffled: boolean;
  dealerNatural: boolean;
  playerNatural: boolean;
  legalActions: BlackjackAction[];
  count: { running: number; true: number };
}

export interface TrainerHand {
  cards: number[];
  stake: number;
  surrendered: boolean;
}

export interface TrainerSettlement {
  dealer: number[];
  drawn: number[];
  hands: Array<{ cards: number[]; outcome: 'win' | 'lose' | 'push' | 'surrender'; net: number }>;
  net: number;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// The deployment token for the endpoints that write state. Held per browser, never bundled:
// a public build must not ship a secret, so whoever administers the deployment pastes it in.
const TOKEN_KEY = 'nexora.adminToken';

export function getAdminToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // A browser with storage blocked simply cannot hold the token; requests then go unauthenticated.
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there is one: Fastify rejects an empty body sent with
  // content-type application/json, which is every POST that takes no payload.
  const token = getAdminToken();
  const headers = {
    ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(init?.headers ?? {}),
  };
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as Array<[string, string | number]>;
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
};

export const api = {
  competitions: () => request<{ items: Array<{ id: string; code: string; name: string; dataEnvironment: DataEnvironment; teams: number; matches: number; matchesByEnvironment: Record<string, number> }> }>('/competitions'),
  matches: (p: { dataEnvironment?: DataEnvironment; status?: string; teamId?: string; order?: 'asc' | 'desc'; limit?: number; offset?: number }) =>
    request<{ total: number; items: MatchSummary[] }>(`/matches${qs(p)}`),
  today: (timeZone: string) => request<{ date: string; items: MatchSummary[] }>(`/matches/today${qs({ timeZone })}`),
  upcoming: (days: number) => request<{ upcoming: MatchSummary[]; awaitingResult: MatchSummary[] }>(`/matches/upcoming${qs({ days, dataEnvironment: 'LIVE' })}`),
  match: (id: string) => request<MatchSummary & { stats: unknown }>(`/matches/${encodeURIComponent(id)}`),
  form: (id: string) => request<MatchForm>(`/matches/${encodeURIComponent(id)}/form`),
  h2h: (id: string) => request<H2H>(`/matches/${encodeURIComponent(id)}/h2h`),
  availability: (id: string) => request<AvailabilityResponse>(`/matches/${encodeURIComponent(id)}/availability`),
  analysis: (id: string) => request<StoredAnalysis>(`/matches/${encodeURIComponent(id)}/analysis`),
  runAnalysis: (id: string) => request<{ mode: string; analysis: MatchAnalysis }>(`/analysis/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  teams: (competitionId?: string) => request<{ items: Array<{ id: string; name: string; shortName: string; competitionId: string }> }>(`/teams${qs({ competitionId })}`),
  team: (id: string) => request<{ id: string; name: string; shortName: string; country: string; competition: { id: string; name: string }; squadSize: number }>(`/teams/${encodeURIComponent(id)}`),
  teamForm: (id: string) => request<TeamFormBundle & { asOf: string }>(`/teams/${encodeURIComponent(id)}/form`),
  teamPlayers: (id: string) => request<{ players: Array<{ id: string; name: string; position: string }> }>(`/teams/${encodeURIComponent(id)}/players`),
  player: (id: string) =>
    request<{ id: string; name: string; position: string; team: TeamRef; source: string; impact: { impactScore?: number | null; impactConfidence?: string; factors?: string[]; status?: string; limitations?: string[] }; recentMatches: Array<{ matchId: string; matchDate: string; minutes: number; goals: Maybe; assists: Maybe; shots: Maybe }>; availabilityHistory: Array<{ status: string; reason: string | null; reportedAt: string }> }>(
      `/players/${encodeURIComponent(id)}`,
    ),
  performance: (dataEnvironment: DataEnvironment) => request<Performance>(`/model/performance${qs({ dataEnvironment })}`),
  models: () => request<{ activeByEnvironment: Record<DataEnvironment, string>; items: ModelVersionItem[] }>('/models'),
  learningEvents: (dataEnvironment?: DataEnvironment) => request<{ items: LearningEventItem[] }>(`/learning-events${qs({ dataEnvironment, limit: 200 })}`),
  simulations: () => request<{ items: Array<{ id: string; dataEnvironment: DataEnvironment; status: string; startedAt: string; summary: Record<string, unknown> | null }> }>('/simulations'),
  quality: () => request<QualityReport>('/data/quality'),
  freshness: () => request<Freshness>('/data/freshness'),
  trainerDeal: (body: { rules: BlackjackRules; seen: number[]; weak: Array<{ key: string; evLost: number }>; drillBias: number }) =>
    request<TrainerDeal>('/blackjack/trainer/deal', { method: 'POST', body: JSON.stringify(body) }),
  trainerDraw: (body: { rules: BlackjackRules; seen: number[]; count: number }) =>
    request<{ cards: number[]; count: { running: number; true: number } }>('/blackjack/trainer/draw', { method: 'POST', body: JSON.stringify(body) }),
  trainerSettle: (body: { rules: BlackjackRules; seen: number[]; dealer: number[]; hands: TrainerHand[] }) =>
    request<TrainerSettlement>('/blackjack/trainer/settle', { method: 'POST', body: JSON.stringify(body) }),
  blackjackEvaluate: (body: { hand: number[]; upcard: number; seen?: number[]; afterSplit?: boolean; rules: BlackjackRules }) =>
    request<BlackjackDecision>('/blackjack/evaluate', { method: 'POST', body: JSON.stringify(body) }),
  blackjackStrategy: (rules: BlackjackRules) => request<BlackjackChart>(`/blackjack/strategy${qs(rules as unknown as Record<string, string | number>)}`),
  blackjackEdge: (rules: BlackjackRules) => request<BlackjackEdge & { rules: BlackjackRules }>(`/blackjack/edge${qs(rules as unknown as Record<string, string | number>)}`),
  blackjackSimulate: (body: { rounds: number; seed: number; rules: BlackjackRules }) =>
    request<BlackjackSimulation>('/blackjack/simulate', { method: 'POST', body: JSON.stringify(body) }),
  debate: (id: string) => request<StoredDebate>(`/debate/${encodeURIComponent(id)}${qs({ full: 'true' })}`),
  runDebate: (id: string) => request<{ debateRunId: string; transcript: DebateTranscript }>(`/debate/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  debateRuns: (dataEnvironment?: DataEnvironment) => request<{ items: DebateRunRow[] }>(`/debate/runs${qs({ dataEnvironment, limit: 50 })}`),
  bookkeeper: (dataEnvironment?: DataEnvironment) => request<BookkeeperReport>(`/debate/bookkeeper${qs({ dataEnvironment })}`),
};
