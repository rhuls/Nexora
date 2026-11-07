import type { AvailabilityStatus, MatchStatus, PlayerPosition } from '@prisma/client';
import { SeededRandom } from './prng.js';
import {
  COMPETITION,
  FIRST_NAMES,
  FORMATION,
  INJURY_REASONS,
  LAST_NAMES,
  RANDOM_SEED,
  ROUND_INTERVAL_DAYS,
  SEASONS,
  SEED_REFERENCE_DATE,
  SQUAD_TEMPLATE,
  TEAMS,
  type TeamProfile,
} from './reference.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const YELLOW_SUSPENSION_THRESHOLD = 5;
const INJURY_PROBABILITY_PER_MATCH = 0.012;
const DOUBTFUL_PLAY_PROBABILITY = 0.5;
const MISSING_CORNERS_PROBABILITY = 0.03;
const MISSING_POSSESSION_PROBABILITY = 0.02;

export interface SeedSeason {
  id: string;
  competitionId: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

export interface SeedTeam {
  id: string;
  name: string;
  shortName: string;
  country: string;
  competitionId: string;
}

export interface SeedPlayer {
  id: string;
  teamId: string;
  name: string;
  position: PlayerPosition;
}

export interface SeedHeadToHead {
  id: string;
  teamAId: string;
  teamBId: string;
}

export interface SeedMatch {
  id: string;
  competitionId: string;
  seasonId: string;
  homeTeamId: string;
  awayTeamId: string;
  headToHeadId: string;
  round: string;
  matchDate: Date;
  status: MatchStatus;
  homeScore: number | null;
  awayScore: number | null;
}

export interface SeedMatchStats {
  matchId: string;
  teamId: string;
  isHome: boolean;
  goals: number;
  possession: number | null;
  shots: number;
  shotsOnTarget: number;
  corners: number | null;
  yellowCards: number;
  redCards: number;
  fouls: number;
  offsides: number;
}

export interface SeedPlayerMatchStats {
  playerId: string;
  matchId: string;
  teamId: string;
  started: boolean;
  minutes: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  tackles: number | null;
  interceptions: number | null;
  clearances: number | null;
  yellowCards: number;
  redCards: number;
}

export interface SeedAvailability {
  playerId: string;
  matchId: string;
  status: AvailabilityStatus;
  reason: string | null;
  expectedReturn: Date | null;
  reportedAt: Date;
}

export interface SeedDataset {
  seasons: SeedSeason[];
  teams: SeedTeam[];
  players: SeedPlayer[];
  headToHeads: SeedHeadToHead[];
  matches: SeedMatch[];
  matchStats: SeedMatchStats[];
  playerMatchStats: SeedPlayerMatchStats[];
  availability: SeedAvailability[];
}

interface PlayerState {
  player: SeedPlayer;
  quality: number;
  injuryMatchesRemaining: number;
  injuryReason: string | null;
  returningFromInjury: boolean;
  suspensionMatchesRemaining: number;
  suspensionReason: string | null;
  seasonYellowCards: number;
}

interface Fixture {
  seasonId: string;
  round: number;
  date: Date;
  home: TeamProfile;
  away: TeamProfile;
}

interface Participation {
  state: PlayerState;
  started: boolean;
  minutes: number;
}

interface TeamSideResult {
  stats: SeedMatchStats;
  players: SeedPlayerMatchStats[];
}

const POSITION_GOAL_WEIGHT: Readonly<Record<PlayerPosition, number>> = {
  GOALKEEPER: 0,
  DEFENDER: 0.6,
  MIDFIELDER: 2,
  FORWARD: 5,
};

const POSITION_ASSIST_WEIGHT: Readonly<Record<PlayerPosition, number>> = {
  GOALKEEPER: 0.05,
  DEFENDER: 1,
  MIDFIELDER: 3,
  FORWARD: 2,
};

const POSITION_CARD_WEIGHT: Readonly<Record<PlayerPosition, number>> = {
  GOALKEEPER: 0.2,
  DEFENDER: 1.6,
  MIDFIELDER: 1.4,
  FORWARD: 0.8,
};

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// Circle-method double round robin: 7 rounds each way for 8 teams.
function buildFixtures(rng: SeededRandom): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const season of SEASONS) {
    const order = rng.shuffle(TEAMS);
    const n = order.length;
    const firstHalf: Array<Array<[TeamProfile, TeamProfile]>> = [];
    const rotating = order.slice(1);
    for (let round = 0; round < n - 1; round += 1) {
      const lineup = [order[0]!, ...rotating];
      const pairs: Array<[TeamProfile, TeamProfile]> = [];
      for (let i = 0; i < n / 2; i += 1) {
        const a = lineup[i]!;
        const b = lineup[n - 1 - i]!;
        pairs.push(round % 2 === 0 ? [a, b] : [b, a]);
      }
      firstHalf.push(pairs);
      rotating.unshift(rotating.pop()!);
    }
    const allRounds = [...firstHalf, ...firstHalf.map((pairs) => pairs.map(([h, a]) => [a, h] as [TeamProfile, TeamProfile]))];
    allRounds.forEach((pairs, roundIndex) => {
      const date = new Date(season.firstRound.getTime() + roundIndex * ROUND_INTERVAL_DAYS * DAY_MS);
      for (const [home, away] of pairs) {
        fixtures.push({ seasonId: season.id, round: roundIndex + 1, date, home, away });
      }
    });
  }
  return fixtures.sort((x, y) => x.date.getTime() - y.date.getTime());
}

function buildSquads(rng: SeededRandom): { players: SeedPlayer[]; states: Map<string, PlayerState[]> } {
  const players: SeedPlayer[] = [];
  const states = new Map<string, PlayerState[]>();
  const usedNames = new Set<string>();

  for (const team of TEAMS) {
    const squad: PlayerState[] = [];
    const rankByPosition = new Map<PlayerPosition, number>();
    SQUAD_TEMPLATE.forEach((position, index) => {
      let name = '';
      do {
        name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
      } while (usedNames.has(name));
      usedNames.add(name);

      const rank = rankByPosition.get(position) ?? 0;
      rankByPosition.set(position, rank + 1);
      const isStarForward = position === 'FORWARD' && rank === 0;
      const quality = isStarForward ? 1.6 : Math.max(0.55, 1.3 - rank * 0.12 + rng.normal(0, 0.05));

      const player: SeedPlayer = { id: `${team.id}_p${String(index + 1).padStart(2, '0')}`, teamId: team.id, name, position };
      players.push(player);
      squad.push({
        player,
        quality,
        injuryMatchesRemaining: 0,
        injuryReason: null,
        returningFromInjury: false,
        suspensionMatchesRemaining: 0,
        suspensionReason: null,
        seasonYellowCards: 0,
      });
    });
    states.set(team.id, squad);
  }
  return { players, states };
}

function availabilityOf(state: PlayerState): { status: AvailabilityStatus; reason: string | null } {
  if (state.suspensionMatchesRemaining > 0) return { status: 'SUSPENDED', reason: state.suspensionReason };
  if (state.injuryMatchesRemaining > 0) return { status: 'INJURED', reason: state.injuryReason };
  if (state.returningFromInjury) return { status: 'DOUBTFUL', reason: `Returning from ${state.injuryReason?.toLowerCase() ?? 'injury'}` };
  return { status: 'AVAILABLE', reason: null };
}

function selectLineup(rng: SeededRandom, squad: PlayerState[]): { starters: PlayerState[]; bench: PlayerState[] } {
  const eligible = squad.filter((s) => {
    const { status } = availabilityOf(s);
    if (status === 'AVAILABLE') return true;
    if (status === 'DOUBTFUL') return rng.chance(DOUBTFUL_PLAY_PROBABILITY);
    return false;
  });
  const ranked = eligible
    .map((s) => ({ s, score: s.quality + rng.normal(0, 0.08) }))
    .sort((a, b) => b.score - a.score)
    .map(({ s }) => s);

  const starters: PlayerState[] = [];
  for (const position of Object.keys(FORMATION) as PlayerPosition[]) {
    starters.push(...ranked.filter((s) => s.player.position === position).slice(0, FORMATION[position]));
  }
  const outfieldReserves = ranked.filter((s) => !starters.includes(s) && s.player.position !== 'GOALKEEPER');
  while (starters.length < 11 && outfieldReserves.length > 0) starters.push(outfieldReserves.shift()!);

  const bench = ranked.filter((s) => !starters.includes(s) && s.player.position !== 'GOALKEEPER');
  return { starters, bench };
}

function bestPossibleQuality(squad: PlayerState[], positions: PlayerPosition[]): number {
  return positions.reduce((sum, position) => {
    const top = squad
      .filter((s) => s.player.position === position)
      .map((s) => s.quality)
      .sort((a, b) => b - a)
      .slice(0, FORMATION[position]);
    return sum + top.reduce((a, b) => a + b, 0);
  }, 0);
}

function lineupQuality(starters: PlayerState[], positions: PlayerPosition[]): number {
  return starters.filter((s) => positions.includes(s.player.position)).reduce((sum, s) => sum + s.quality, 0);
}

function distributeWeighted(rng: SeededRandom, count: number, pool: Participation[], weight: (p: Participation) => number): number[] {
  const tally = pool.map(() => 0);
  const weights = pool.map(weight);
  for (let i = 0; i < count; i += 1) {
    const index = rng.weightedIndex(weights);
    if (index >= 0) tally[index]! += 1;
  }
  return tally;
}

function buildParticipation(rng: SeededRandom, starters: PlayerState[], bench: PlayerState[]): Participation[] {
  const participation: Participation[] = starters.map((state) => ({ state, started: true, minutes: 90 }));
  const substitutions = Math.min(3, bench.length);
  const replaceable = rng.shuffle(participation.filter((p) => p.state.player.position !== 'GOALKEEPER'));
  for (let i = 0; i < substitutions; i += 1) {
    const off = replaceable[i];
    if (!off) break;
    const minute = rng.int(55, 85);
    off.minutes = minute;
    participation.push({ state: bench[i]!, started: false, minutes: 90 - minute });
  }
  return participation;
}

function generateSide(
  rng: SeededRandom,
  matchId: string,
  team: TeamProfile,
  isHome: boolean,
  goals: number,
  expectedGoals: number,
  possession: number | null,
  cornersMissing: boolean,
  participation: Participation[],
): TeamSideResult {
  const shots = Math.max(goals, rng.poisson(expectedGoals * 6.5 + 3));
  const shotsOnTarget = Math.min(shots, Math.max(goals, rng.binomial(shots, 0.36)));
  const possessionShare = possession ?? 50;
  const corners = cornersMissing ? null : rng.poisson((1.6 + shots * 0.2 + (possessionShare - 50) * 0.04) * team.cornerBias);
  const fouls = rng.poisson(11 * team.cardBias);
  const yellowCards = Math.min(5, rng.poisson(0.15 * fouls));
  const redCards = rng.chance(0.04 * team.cardBias) ? 1 : 0;
  const offsides = rng.poisson(1.2 + team.attack);

  const players: SeedPlayerMatchStats[] = participation.map((p) => ({
    playerId: p.state.player.id,
    matchId,
    teamId: team.id,
    started: p.started,
    minutes: p.minutes,
    goals: 0,
    assists: 0,
    shots: 0,
    shotsOnTarget: 0,
    tackles: null,
    interceptions: null,
    clearances: null,
    yellowCards: 0,
    redCards: 0,
  }));

  // Totals are allocated top-down so player sums always equal team totals.
  const attackWeight = (p: Participation): number => POSITION_GOAL_WEIGHT[p.state.player.position] * p.state.quality * (p.minutes / 90);
  const scorers = distributeWeighted(rng, goals, participation, attackWeight);
  scorers.forEach((g, i) => {
    const row = players[i]!;
    row.goals += g;
    row.shots += g;
    row.shotsOnTarget += g;
  });

  scorers.forEach((g, scorerIndex) => {
    for (let k = 0; k < g; k += 1) {
      if (!rng.chance(0.75)) continue;
      const weights = participation.map((p, i) => (i === scorerIndex ? 0 : POSITION_ASSIST_WEIGHT[p.state.player.position] * p.state.quality * (p.minutes / 90)));
      const assister = rng.weightedIndex(weights);
      if (assister >= 0) players[assister]!.assists += 1;
    }
  });

  distributeWeighted(rng, shotsOnTarget - goals, participation, attackWeight).forEach((n, i) => {
    players[i]!.shots += n;
    players[i]!.shotsOnTarget += n;
  });
  distributeWeighted(rng, shots - shotsOnTarget, participation, (p) => attackWeight(p) + 0.3 * (p.minutes / 90)).forEach((n, i) => {
    players[i]!.shots += n;
  });

  const cardCandidates = rng.shuffle(participation.map((_, i) => i));
  const cardWeights = participation.map((p) => POSITION_CARD_WEIGHT[p.state.player.position] * team.cardBias);
  const booked = new Set<number>();
  for (let k = 0; k < yellowCards; k += 1) {
    const weights = cardWeights.map((w, i) => (booked.has(i) ? 0 : w));
    const index = rng.weightedIndex(weights);
    if (index < 0) break;
    booked.add(index);
    players[index]!.yellowCards = 1;
  }
  if (redCards > 0) {
    const index = cardCandidates.find((i) => !booked.has(i) && participation[i]!.state.player.position !== 'GOALKEEPER');
    if (index !== undefined) {
      players[index]!.redCards = 1;
      const sentOffAt = rng.int(20, 88);
      players[index]!.minutes = Math.min(players[index]!.minutes, sentOffAt);
    }
  }

  participation.forEach((p, i) => {
    const row = players[i]!;
    const factor = row.minutes / 90;
    switch (p.state.player.position) {
      case 'DEFENDER':
        row.tackles = rng.poisson(2.2 * factor);
        row.interceptions = rng.poisson(1.6 * factor);
        row.clearances = rng.poisson(3.5 * factor);
        break;
      case 'MIDFIELDER':
        row.tackles = rng.poisson(2.0 * factor);
        row.interceptions = rng.poisson(1.2 * factor);
        row.clearances = rng.poisson(0.8 * factor);
        break;
      case 'FORWARD':
        row.tackles = rng.poisson(0.7 * factor);
        row.interceptions = rng.poisson(0.3 * factor);
        row.clearances = rng.poisson(0.3 * factor);
        break;
      case 'GOALKEEPER':
        row.tackles = 0;
        row.interceptions = rng.poisson(0.3 * factor);
        row.clearances = rng.poisson(1.2 * factor);
        break;
    }
  });

  return {
    stats: { matchId, teamId: team.id, isHome, goals, possession, shots, shotsOnTarget, corners, yellowCards, redCards, fouls, offsides },
    players,
  };
}

function applyPostMatchState(rng: SeededRandom, squad: PlayerState[], rows: SeedPlayerMatchStats[]): void {
  const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
  for (const state of squad) {
    const wasSuspended = state.suspensionMatchesRemaining > 0;
    const wasInjured = state.injuryMatchesRemaining > 0;
    if (wasSuspended) {
      state.suspensionMatchesRemaining -= 1;
      if (state.suspensionMatchesRemaining === 0) state.suspensionReason = null;
    }
    if (wasInjured) {
      state.injuryMatchesRemaining -= 1;
      if (state.injuryMatchesRemaining === 0) state.returningFromInjury = true;
    } else if (state.returningFromInjury) {
      state.returningFromInjury = false;
      state.injuryReason = null;
    }

    const row = byPlayer.get(state.player.id);
    if (row) {
      if (row.redCards > 0) {
        state.suspensionMatchesRemaining = 1;
        state.suspensionReason = 'Red card suspension';
      }
      if (row.yellowCards > 0) {
        state.seasonYellowCards += row.yellowCards;
        if (state.seasonYellowCards % YELLOW_SUSPENSION_THRESHOLD === 0) {
          state.suspensionMatchesRemaining += 1;
          state.suspensionReason = `Yellow card accumulation (${state.seasonYellowCards})`;
        }
      }
    }

    if (!wasInjured && state.injuryMatchesRemaining === 0 && rng.chance(INJURY_PROBABILITY_PER_MATCH * (row ? 1.5 : 0.5))) {
      state.injuryMatchesRemaining = rng.int(1, 5);
      state.injuryReason = rng.pick(INJURY_REASONS);
      state.returningFromInjury = false;
    }
  }
}

function recordAvailability(squad: PlayerState[], match: SeedMatch, reportedAt: Date): SeedAvailability[] {
  return squad.map((state) => {
    const { status, reason } = availabilityOf(state);
    const expectedReturn =
      status === 'INJURED' ? new Date(match.matchDate.getTime() + state.injuryMatchesRemaining * ROUND_INTERVAL_DAYS * DAY_MS) : null;
    return { playerId: state.player.id, matchId: match.id, status, reason, expectedReturn, reportedAt };
  });
}

export function generateDataset(): SeedDataset {
  const rng = new SeededRandom(RANDOM_SEED);
  const fixtures = buildFixtures(rng);
  const { players, states } = buildSquads(rng);

  const teams: SeedTeam[] = TEAMS.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName, country: COMPETITION.country, competitionId: COMPETITION.id }));

  const seasons: SeedSeason[] = SEASONS.map((s) => {
    const seasonFixtures = fixtures.filter((f) => f.seasonId === s.id);
    const last = seasonFixtures[seasonFixtures.length - 1]!;
    return { id: s.id, competitionId: COMPETITION.id, name: s.name, startDate: s.firstRound, endDate: last.date };
  });

  const headToHeadIds = new Map<string, SeedHeadToHead>();
  for (let i = 0; i < TEAMS.length; i += 1) {
    for (let j = i + 1; j < TEAMS.length; j += 1) {
      const [a, b] = pairKey(TEAMS[i]!.id, TEAMS[j]!.id);
      headToHeadIds.set(`${a}|${b}`, { id: `h2h_${a}_${b}`, teamAId: a, teamBId: b });
    }
  }

  // Season-level drift so team strength is not perfectly constant across years.
  const seasonStrength = new Map<string, { attack: number; defense: number }>();
  for (const season of SEASONS) {
    for (const team of TEAMS) {
      seasonStrength.set(`${season.id}|${team.id}`, {
        attack: team.attack * (1 + rng.normal(0, 0.05)),
        defense: team.defense * (1 + rng.normal(0, 0.05)),
      });
    }
  }

  const matches: SeedMatch[] = [];
  const matchStats: SeedMatchStats[] = [];
  const playerMatchStats: SeedPlayerMatchStats[] = [];
  const availability: SeedAvailability[] = [];
  const nextScheduledRecorded = new Set<string>();
  let currentSeasonId = '';

  for (const fixture of fixtures) {
    if (fixture.seasonId !== currentSeasonId) {
      currentSeasonId = fixture.seasonId;
      for (const squad of states.values()) for (const s of squad) s.seasonYellowCards = 0;
    }

    const [a, b] = pairKey(fixture.home.id, fixture.away.id);
    const match: SeedMatch = {
      id: `m_${fixture.seasonId.replace('season_', '')}_r${String(fixture.round).padStart(2, '0')}_${fixture.home.shortName.toLowerCase()}_${fixture.away.shortName.toLowerCase()}`,
      competitionId: COMPETITION.id,
      seasonId: fixture.seasonId,
      homeTeamId: fixture.home.id,
      awayTeamId: fixture.away.id,
      headToHeadId: headToHeadIds.get(`${a}|${b}`)!.id,
      round: `Round ${fixture.round}`,
      matchDate: fixture.date,
      status: 'SCHEDULED',
      homeScore: null,
      awayScore: null,
    };
    matches.push(match);

    const homeSquad = states.get(fixture.home.id)!;
    const awaySquad = states.get(fixture.away.id)!;

    if (fixture.date.getTime() >= SEED_REFERENCE_DATE.getTime()) {
      // Only each team's next fixture has a published availability report; later fixtures have none (DATA UNAVAILABLE).
      const reportedAt = new Date(Math.min(SEED_REFERENCE_DATE.getTime(), fixture.date.getTime() - DAY_MS));
      for (const [teamId, squad] of [[fixture.home.id, homeSquad], [fixture.away.id, awaySquad]] as const) {
        if (nextScheduledRecorded.has(teamId)) continue;
        nextScheduledRecorded.add(teamId);
        availability.push(...recordAvailability(squad, match, reportedAt));
      }
      continue;
    }

    const reportedAt = new Date(fixture.date.getTime() - DAY_MS);
    availability.push(...recordAvailability(homeSquad, match, reportedAt), ...recordAvailability(awaySquad, match, reportedAt));

    const homeLineup = selectLineup(rng, homeSquad);
    const awayLineup = selectLineup(rng, awaySquad);
    const attackPositions: PlayerPosition[] = ['MIDFIELDER', 'FORWARD'];
    const defensePositions: PlayerPosition[] = ['GOALKEEPER', 'DEFENDER'];
    const homeAttackFactor = Math.pow(lineupQuality(homeLineup.starters, attackPositions) / bestPossibleQuality(homeSquad, attackPositions), 1.5);
    const awayAttackFactor = Math.pow(lineupQuality(awayLineup.starters, attackPositions) / bestPossibleQuality(awaySquad, attackPositions), 1.5);
    const homeDefenseFactor = bestPossibleQuality(homeSquad, defensePositions) / lineupQuality(homeLineup.starters, defensePositions);
    const awayDefenseFactor = bestPossibleQuality(awaySquad, defensePositions) / lineupQuality(awayLineup.starters, defensePositions);

    const homeStrength = seasonStrength.get(`${fixture.seasonId}|${fixture.home.id}`)!;
    const awayStrength = seasonStrength.get(`${fixture.seasonId}|${fixture.away.id}`)!;
    const homeExpected = 1.45 * homeStrength.attack * awayStrength.defense * homeAttackFactor * awayDefenseFactor;
    const awayExpected = 1.1 * awayStrength.attack * homeStrength.defense * awayAttackFactor * homeDefenseFactor;
    const homeGoals = rng.poisson(homeExpected);
    const awayGoals = rng.poisson(awayExpected);

    const possessionMissing = rng.chance(MISSING_POSSESSION_PROBABILITY);
    const cornersMissing = rng.chance(MISSING_CORNERS_PROBABILITY);
    const homePossession = Math.round(Math.min(70, Math.max(30, 52 + (fixture.home.possessionBias - fixture.away.possessionBias) * 0.8 + rng.normal(0, 4))));

    const homeSide = generateSide(
      rng, match.id, fixture.home, true, homeGoals, homeExpected,
      possessionMissing ? null : homePossession, cornersMissing,
      buildParticipation(rng, homeLineup.starters, homeLineup.bench),
    );
    const awaySide = generateSide(
      rng, match.id, fixture.away, false, awayGoals, awayExpected,
      possessionMissing ? null : 100 - homePossession, cornersMissing,
      buildParticipation(rng, awayLineup.starters, awayLineup.bench),
    );

    match.status = 'FINISHED';
    match.homeScore = homeGoals;
    match.awayScore = awayGoals;
    matchStats.push(homeSide.stats, awaySide.stats);
    playerMatchStats.push(...homeSide.players, ...awaySide.players);

    applyPostMatchState(rng, homeSquad, homeSide.players);
    applyPostMatchState(rng, awaySquad, awaySide.players);
  }

  return { seasons, teams, players, headToHeads: [...headToHeadIds.values()], matches, matchStats, playerMatchStats, availability };
}
