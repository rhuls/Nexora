import type { DataEnvironment, Prisma, PrismaClient } from '@prisma/client';
import { analyzeAvailability, type TeamAvailability } from '../analysis/availability.analyzer.js';
import { analyzeForm, type FormAnalysis } from '../analysis/form.analyzer.js';
import { analyzeHeadToHead, type H2HAnalysis } from '../analysis/h2h.analyzer.js';
import { analyzeHomeAway, type HomeAwayAnalysis } from '../analysis/home-away.analyzer.js';
import type { Metric } from '../analysis/metrics.js';
import { analyzePlayerImpacts, type TeamPlayerImpacts } from '../analysis/player-impact.analyzer.js';
import { DIXON_COLES, ELO, calibrateOutcome, computeElo, dixonColesExpectation, eloExpectancy, eloRatingFor, fitDixonColes } from '../analysis/ratings.js';
import { KnowledgeService, type PointInTime } from '../data/knowledge/knowledge.service.js';

export const FEATURE_SET_VERSION = '2.0.0';
const FORM_WINDOW = 5;
const H2H_LIMIT = 5;
const PLAYER_LOOKBACK = 20;
const LEAGUE_BASELINE_MATCHES = 200;
const MIN_LEAGUE_SAMPLE = 30;

type Db = PrismaClient | Prisma.TransactionClient;

export interface FeatureValue {
  value: number | null;
  source: string;
  window: number;
  sampleSize: number;
  asOf: string;
}

export const FEATURE_NAMES = [
  'recentFormHome', 'recentFormAway',
  'goalsHomeAverage', 'goalsAwayAverage', 'concededHomeAverage', 'concededAwayAverage',
  'homeFormAtHome', 'awayFormAway', 'homeGoalsAtHome', 'awayGoalsAway', 'homeConcededAtHome', 'awayConcededAway',
  'shotsHomeAverage', 'shotsAwayAverage', 'shotsOnTargetHomeAverage', 'shotsOnTargetAwayAverage',
  'cornersHomeAverage', 'cornersAwayAverage', 'possessionHomeAverage', 'possessionAwayAverage',
  'cardsHomeAverage', 'cardsAwayAverage',
  'availabilityHomeImpact', 'availabilityAwayImpact', 'availabilityHomeAttacking', 'availabilityAwayAttacking',
  'availabilityHomeDefensive', 'availabilityAwayDefensive',
  'h2hGoalsAverage', 'h2hHomeGoals', 'h2hAwayGoals', 'h2hCornersAverage', 'h2hCardsAverage', 'h2hShotsAverage',
  'h2hShotsOnTargetAverage', 'h2hResultBalance', 'h2hReliability',
  'leagueHomeGoals', 'leagueAwayGoals', 'homeAdvantage', 'goalsPerShotOnTarget',
  // Ratings from every known result of the competition (2.0.0).
  'eloHome', 'eloAway', 'eloHomeExpectancy', 'eloCalibratedHome', 'eloCalibratedDraw', 'eloCalibratedAway',
  'dcExpectedHomeGoals', 'dcExpectedAwayGoals', 'dcRho',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface MatchFeatureVector {
  matchId: string;
  dataEnvironment: DataEnvironment;
  asOf: string;
  featureSetVersion: string;
  features: Record<FeatureName, FeatureValue>;
}

export interface DataQuality {
  status: 'GOOD' | 'WARNINGS';
  featuresAvailable: number;
  featuresTotal: number;
  warnings: string[];
}

export interface FeatureBuild {
  match: { id: string; competitionId: string; dataEnvironment: DataEnvironment; matchDate: Date; homeTeam: { id: string; name: string }; awayTeam: { id: string; name: string } };
  pit: PointInTime;
  vector: MatchFeatureVector;
  latestInputAt: Date | null;
  quality: DataQuality;
  context: {
    home: { form: FormAnalysis; homeAway: HomeAwayAnalysis; availability: TeamAvailability; impacts: TeamPlayerImpacts };
    away: { form: FormAnalysis; homeAway: HomeAwayAnalysis; availability: TeamAvailability; impacts: TeamPlayerImpacts };
    h2h: H2HAnalysis;
  };
}

export const featureValue = (v: MatchFeatureVector, name: FeatureName): number | null => v.features[name].value;

const metricValue = (m: Metric): number | null => (typeof m.value === 'number' ? m.value : null);

export class FeatureEngineeringService {
  private readonly knowledge: KnowledgeService;

  constructor(db: Db) {
    this.knowledge = new KnowledgeService(db);
  }

  async build(matchId: string, asOf?: Date): Promise<FeatureBuild> {
    const { match, pit } = await this.knowledge.matchPointInTime(matchId, asOf);
    const at = pit.cutoff.toISOString();

    const side = async (team: { id: string; name: string }) => {
      const [all, home, away, players] = await Promise.all([
        this.knowledge.teamHistory(team.id, pit, FORM_WINDOW),
        this.knowledge.teamHistory(team.id, pit, FORM_WINDOW, 'HOME'),
        this.knowledge.teamHistory(team.id, pit, FORM_WINDOW, 'AWAY'),
        this.knowledge.playerHistory(team.id, pit, PLAYER_LOOKBACK),
      ]);
      const common = { team, window: FORM_WINDOW, cutoff: pit.cutoff, environments: pit.environments };
      return {
        form: analyzeForm({ ...common, scope: 'ALL', results: all.results }),
        homeAway: analyzeHomeAway({ ...common, homeResults: home.results, awayResults: away.results }),
        impacts: analyzePlayerImpacts(team.id, players, PLAYER_LOOKBACK),
        inputTimes: [...all.results, ...home.results, ...away.results, ...players.matches].map((r) => new Date(r.resultKnownAt).getTime()),
      };
    };

    const [homeSide, awaySide, h2hHistory, availability, league, known] = await Promise.all([
      side(match.homeTeam),
      side(match.awayTeam),
      this.knowledge.headToHeadHistory(match.headToHeadId, match.homeTeamId, pit, H2H_LIMIT),
      this.knowledge.availabilityAt(match.id, pit.cutoff),
      this.knowledge.competitionHistory(match.competitionId, pit, LEAGUE_BASELINE_MATCHES),
      this.knowledge.knownResults(match.competitionId, pit),
    ]);

    const h2h = analyzeHeadToHead({ subjectHome: match.homeTeam, subjectAway: match.awayTeam, meetings: h2hHistory.results, limit: H2H_LIMIT, cutoff: pit.cutoff, environments: pit.environments });
    const homeAvailability = analyzeAvailability(match.homeTeam, availability.reports, homeSide.impacts);
    const awayAvailability = analyzeAvailability(match.awayTeam, availability.reports, awaySide.impacts);

    const f = (value: number | null, source: string, window: number, sampleSize: number): FeatureValue => ({ value, source, window, sampleSize, asOf: at });
    const fromMetric = (m: Metric, source: string) => f(metricValue(m), source, m.window, m.sampleSize);
    const cards = (form: FormAnalysis) => {
      const y = metricValue(form.averageYellowCards);
      const r = metricValue(form.averageRedCards);
      return f(y !== null && r !== null ? Math.round((y + r) * 1000) / 1000 : null, 'form:all', FORM_WINDOW, Math.min(form.averageYellowCards.sampleSize, form.averageRedCards.sampleSize));
    };
    const avail = (a: TeamAvailability, key: 'combinedImpact' | 'attackingImpact' | 'defensiveImpact') => f(a[key], 'availability', 1, a.reportedPlayers);

    const leagueN = league.length;
    const leagueOk = leagueN >= MIN_LEAGUE_SAMPLE;
    const leagueHome = leagueOk ? league.reduce((s, m) => s + m.homeScore, 0) / leagueN : null;
    const leagueAway = leagueOk ? league.reduce((s, m) => s + m.awayScore, 0) / leagueN : null;
    const r3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

    const pooled = [homeSide.form, awaySide.form].flatMap((form) => form.matches);
    const conversion = (() => {
      const goals = [homeSide.form, awaySide.form].reduce((s, form) => s + (metricValue(form.averageShotsOnTarget) !== null ? form.goalsScored : 0), 0);
      const sot = [homeSide.form, awaySide.form].reduce((s, form) => {
        const v = metricValue(form.averageShotsOnTarget);
        return v === null ? s : s + v * form.averageShotsOnTarget.sampleSize;
      }, 0);
      return sot > 0 ? r3(goals / sot) : null;
    })();

    const hf = homeSide.form;
    const af = awaySide.form;
    const hh = homeSide.homeAway.home;
    const aa = awaySide.homeAway.away;
    const h2hTotal = (m: H2HAnalysis['totalGoals']) => f(metricValue(m.timeWeighted), 'h2h', H2H_LIMIT, m.timeWeighted.sampleSize);
    const balance = h2h.meetingsUsed > 0
      ? r3((metricValue(h2h.weightedResultShare.subjectHomeWin) ?? 0) - (metricValue(h2h.weightedResultShare.subjectAwayWin) ?? 0))
      : null;

    const elo = computeElo(known);
    const eloH = eloRatingFor(elo, match.homeTeamId);
    const eloA = eloRatingFor(elo, match.awayTeamId);
    const expectancy = eloH !== null && eloA !== null ? eloExpectancy(eloH, eloA) : null;
    const calibrated = expectancy !== null ? calibrateOutcome(elo.history, expectancy) : null;
    const dc = fitDixonColes(known, pit.cutoff);
    const dcGoals = dc ? dixonColesExpectation(dc, match.homeTeamId, match.awayTeamId) : null;
    const eloF = (value: number | null) => f(value === null ? null : r3(value), 'ratings:elo', known.length, elo.matches);
    const dcF = (value: number | null) => f(value === null ? null : r3(value), 'ratings:dixon-coles', known.length, dc?.matches ?? known.length);

    const features: Record<FeatureName, FeatureValue> = {
      recentFormHome: fromMetric(hf.pointsPerGame, 'form:all'),
      recentFormAway: fromMetric(af.pointsPerGame, 'form:all'),
      goalsHomeAverage: fromMetric(hf.averageGoalsScored, 'form:all'),
      goalsAwayAverage: fromMetric(af.averageGoalsScored, 'form:all'),
      concededHomeAverage: fromMetric(hf.averageGoalsConceded, 'form:all'),
      concededAwayAverage: fromMetric(af.averageGoalsConceded, 'form:all'),
      homeFormAtHome: fromMetric(hh.pointsPerGame, 'form:home'),
      awayFormAway: fromMetric(aa.pointsPerGame, 'form:away'),
      homeGoalsAtHome: fromMetric(hh.averageGoalsScored, 'form:home'),
      awayGoalsAway: fromMetric(aa.averageGoalsScored, 'form:away'),
      homeConcededAtHome: fromMetric(hh.averageGoalsConceded, 'form:home'),
      awayConcededAway: fromMetric(aa.averageGoalsConceded, 'form:away'),
      shotsHomeAverage: fromMetric(hf.averageShots, 'form:all'),
      shotsAwayAverage: fromMetric(af.averageShots, 'form:all'),
      shotsOnTargetHomeAverage: fromMetric(hf.averageShotsOnTarget, 'form:all'),
      shotsOnTargetAwayAverage: fromMetric(af.averageShotsOnTarget, 'form:all'),
      cornersHomeAverage: fromMetric(hf.averageCorners, 'form:all'),
      cornersAwayAverage: fromMetric(af.averageCorners, 'form:all'),
      possessionHomeAverage: fromMetric(hf.averagePossession, 'form:all'),
      possessionAwayAverage: fromMetric(af.averagePossession, 'form:all'),
      cardsHomeAverage: cards(hf),
      cardsAwayAverage: cards(af),
      availabilityHomeImpact: avail(homeAvailability, 'combinedImpact'),
      availabilityAwayImpact: avail(awayAvailability, 'combinedImpact'),
      availabilityHomeAttacking: avail(homeAvailability, 'attackingImpact'),
      availabilityAwayAttacking: avail(awayAvailability, 'attackingImpact'),
      availabilityHomeDefensive: avail(homeAvailability, 'defensiveImpact'),
      availabilityAwayDefensive: avail(awayAvailability, 'defensiveImpact'),
      h2hGoalsAverage: h2hTotal(h2h.totalGoals),
      h2hHomeGoals: h2hTotal(h2h.subjectHomeGoals),
      h2hAwayGoals: h2hTotal(h2h.subjectAwayGoals),
      h2hCornersAverage: h2hTotal(h2h.totalCorners),
      h2hCardsAverage: (() => {
        const y = metricValue(h2h.totalYellowCards.timeWeighted);
        const r = metricValue(h2h.totalRedCards.timeWeighted);
        return f(y !== null && r !== null ? r3(y + r) : null, 'h2h', H2H_LIMIT, Math.min(h2h.totalYellowCards.timeWeighted.sampleSize, h2h.totalRedCards.timeWeighted.sampleSize));
      })(),
      h2hShotsAverage: h2hTotal(h2h.totalShots),
      h2hShotsOnTargetAverage: h2hTotal(h2h.totalShotsOnTarget),
      h2hResultBalance: f(balance, 'h2h', H2H_LIMIT, h2h.meetingsUsed),
      h2hReliability: f(h2h.meetingsUsed > 0 ? h2h.reliability : null, 'h2h', H2H_LIMIT, h2h.meetingsUsed),
      leagueHomeGoals: f(r3(leagueHome), 'league-baseline', LEAGUE_BASELINE_MATCHES, leagueN),
      leagueAwayGoals: f(r3(leagueAway), 'league-baseline', LEAGUE_BASELINE_MATCHES, leagueN),
      homeAdvantage: f(leagueHome !== null && leagueAway !== null ? r3(leagueHome - leagueAway) : null, 'league-baseline', LEAGUE_BASELINE_MATCHES, leagueN),
      goalsPerShotOnTarget: f(conversion, 'form:all', FORM_WINDOW, pooled.length),
      eloHome: eloF(eloH),
      eloAway: eloF(eloA),
      eloHomeExpectancy: eloF(expectancy),
      eloCalibratedHome: eloF(calibrated?.home ?? null),
      eloCalibratedDraw: eloF(calibrated?.draw ?? null),
      eloCalibratedAway: eloF(calibrated?.away ?? null),
      dcExpectedHomeGoals: dcF(dcGoals?.home ?? null),
      dcExpectedAwayGoals: dcF(dcGoals?.away ?? null),
      dcRho: dcF(dc?.rho ?? null),
    };

    const inputTimes = [
      ...homeSide.inputTimes,
      ...awaySide.inputTimes,
      ...h2hHistory.results.map((r) => new Date(r.resultKnownAt).getTime()),
      ...availability.reports.map((r) => new Date(r.reportedAt).getTime()),
      ...league.map((m) => m.resultKnownAt.getTime()),
      ...known.map((m) => m.resultKnownAt.getTime()),
    ];
    const latestInputAt = inputTimes.length > 0 ? new Date(Math.max(...inputTimes)) : null;

    const available = FEATURE_NAMES.filter((n) => features[n].value !== null).length;
    const warnings = [
      ...hf.limitations,
      ...af.limitations,
      ...h2h.limitations,
      ...homeAvailability.limitations,
      ...awayAvailability.limitations,
      ...homeSide.impacts.limitations.map((l) => `${match.homeTeam.name}: ${l}`),
      ...awaySide.impacts.limitations.map((l) => `${match.awayTeam.name}: ${l}`),
      ...(leagueOk ? [] : [`League baseline needs ${MIN_LEAGUE_SAMPLE} known matches; only ${leagueN} available.`]),
      ...(elo.matches >= ELO.warmupMatches ? [] : [`Elo ratings need ${ELO.warmupMatches} known results to settle; only ${elo.matches} available.`]),
      ...(dc ? [] : [`Dixon-Coles ratings need ${DIXON_COLES.minMatches} known results; only ${known.length} available.`]),
      ...(match.kickoffTimeKnown ? [] : ['Kickoff time unknown; cutoff set to the start of the match day.']),
    ];
    if (available < FEATURE_NAMES.length) warnings.push(`${FEATURE_NAMES.length - available} of ${FEATURE_NAMES.length} features are unavailable.`);

    return {
      match: { id: match.id, competitionId: match.competitionId, dataEnvironment: match.dataEnvironment, matchDate: match.matchDate, homeTeam: match.homeTeam, awayTeam: match.awayTeam },
      pit,
      vector: { matchId: match.id, dataEnvironment: match.dataEnvironment, asOf: at, featureSetVersion: FEATURE_SET_VERSION, features },
      latestInputAt,
      quality: { status: warnings.length === 0 ? 'GOOD' : 'WARNINGS', featuresAvailable: available, featuresTotal: FEATURE_NAMES.length, warnings: [...new Set(warnings)] },
      context: {
        home: { form: hf, homeAway: homeSide.homeAway, availability: homeAvailability, impacts: homeSide.impacts },
        away: { form: af, homeAway: awaySide.homeAway, availability: awayAvailability, impacts: awaySide.impacts },
        h2h,
      },
    };
  }
}
