import type { KnownResult, PlayerHistory } from '../data/knowledge/knowledge.service.js';
import { round } from './metrics.js';

export const PLAYER_IMPACT_VERSION = '1.0.0';
export const MIN_SPLIT_MATCHES = 3;

export type ImpactConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PlayerImpact {
  player: { id: string; name: string; position: string };
  impactScore: number | null;
  impactConfidence: ImpactConfidence;
  components: {
    involvement: number | null;
    attacking: number | null;
    defensive: number | null;
    withWithout: number | null;
  };
  sample: { teamMatchesWithPlayerData: number; appearances: number; starts: number; minutes: number; matchesWithout: number };
  withWithout: { pointsPerGameWith: number | null; pointsPerGameWithout: number | null; goalsPerGameWith: number | null; goalsPerGameWithout: number | null };
  factors: string[];
}

export interface TeamPlayerImpacts {
  teamId: string;
  status: 'AVAILABLE' | 'DATA UNAVAILABLE';
  lookback: number;
  teamMatchesWithPlayerData: number;
  players: PlayerImpact[];
  limitations: string[];
}

const COMPONENT_WEIGHTS = { involvement: 0.35, attacking: 0.25, defensive: 0.15, withWithout: 0.25 } as const;

const sumKnown = (values: Array<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const points = (r: KnownResult) => (r.outcome === 'W' ? 3 : r.outcome === 'D' ? 1 : 0);
const perGame = (rs: KnownResult[], f: (r: KnownResult) => number) => (rs.length === 0 ? null : round(rs.reduce((s, r) => s + f(r), 0) / rs.length));

export function analyzePlayerImpacts(teamId: string, history: PlayerHistory, lookback: number): TeamPlayerImpacts {
  const covered = new Set(history.rows.map((r) => r.matchId));
  const coveredMatches = history.matches.filter((m) => covered.has(m.matchId));
  const n = coveredMatches.length;
  const limitations: string[] = [];

  if (n === 0) {
    limitations.push(
      history.matches.length === 0 ? 'No completed matches were known for this team before the cutoff.' : `Player statistics are unavailable for all ${history.matches.length} known matches; player impact cannot be calculated.`,
    );
    return { teamId, status: 'DATA UNAVAILABLE', lookback, teamMatchesWithPlayerData: 0, players: [], limitations };
  }
  if (n < history.matches.length) limitations.push(`Player statistics available for ${n} of ${history.matches.length} known matches; the rest are excluded, not treated as absences.`);

  const teamRows = history.rows.filter((r) => covered.has(r.matchId));
  const teamGoals = coveredMatches.reduce((s, m) => s + m.goalsFor, 0);
  const teamShots = sumKnown(teamRows.map((r) => r.shots));
  const defensive = (r: (typeof teamRows)[number]) => sumKnown([r.tackles, r.interceptions, r.clearances]);
  const teamDefensive = sumKnown(teamRows.map(defensive));

  const players: PlayerImpact[] = [];
  for (const player of history.players) {
    const rows = teamRows.filter((r) => r.playerId === player.id && r.minutes > 0);
    if (rows.length === 0) continue;
    const played = new Set(rows.map((r) => r.matchId));
    const withMatches = coveredMatches.filter((m) => played.has(m.matchId));
    const withoutMatches = coveredMatches.filter((m) => !played.has(m.matchId));
    const minutes = rows.reduce((s, r) => s + r.minutes, 0);
    const starts = rows.filter((r) => r.started).length;

    const involvementShare = minutes / (n * 90);
    const involvement = clamp01(involvementShare / 0.9);

    const contributions = sumKnown(rows.flatMap((r) => [r.goals, r.assists]));
    const shots = sumKnown(rows.map((r) => r.shots));
    let attacking: number | null = null;
    let goalShare: number | null = null;
    let shotShare: number | null = null;
    if (contributions !== null) {
      goalShare = teamGoals > 0 ? contributions / teamGoals : 0;
      shotShare = shots !== null && teamShots ? shots / teamShots : null;
      const index = shotShare === null ? goalShare : 0.6 * goalShare + 0.4 * shotShare;
      attacking = clamp01(index * 3);
    }

    const def = sumKnown(rows.map(defensive));
    const defShare = def !== null && teamDefensive ? def / teamDefensive : null;
    const defensiveComponent = defShare === null ? null : clamp01(defShare * 6);

    const ppgWith = perGame(withMatches, points);
    const ppgWithout = perGame(withoutMatches, points);
    const splitOk = withMatches.length >= MIN_SPLIT_MATCHES && withoutMatches.length >= MIN_SPLIT_MATCHES;
    const withWithout = splitOk ? clamp01(0.5 + (ppgWith! - ppgWithout!) / 2) : null;

    const parts: Array<[keyof typeof COMPONENT_WEIGHTS, number | null]> = [
      ['involvement', involvement],
      ['attacking', attacking],
      ['defensive', defensiveComponent],
      ['withWithout', withWithout],
    ];
    const available = parts.filter((p): p is [keyof typeof COMPONENT_WEIGHTS, number] => p[1] !== null);
    const weightSum = available.reduce((s, [k]) => s + COMPONENT_WEIGHTS[k], 0);
    const score = weightSum > 0 ? Math.round((100 * available.reduce((s, [k, v]) => s + COMPONENT_WEIGHTS[k] * v, 0)) / weightSum) : null;

    const confidence: ImpactConfidence = n < 5 || rows.length < 3 ? 'LOW' : n >= 10 && withWithout !== null ? 'HIGH' : 'MEDIUM';

    const factors: string[] = [];
    factors.push(`Played ${round(involvementShare * 100, 0)}% of available minutes (${rows.length} of ${n} matches, ${starts} starts).`);
    if (goalShare !== null && contributions !== null) factors.push(`Direct goal involvement in ${round(goalShare * 100, 0)}% of team goals (${contributions} goals + assists).`);
    if (shotShare !== null) factors.push(`Took ${round(shotShare * 100, 0)}% of team shots.`);
    if (defShare !== null) factors.push(`Made ${round(defShare * 100, 0)}% of recorded team defensive actions.`);
    if (splitOk) {
      factors.push(
        `The team averaged ${ppgWith} points per game with this player (${withMatches.length} matches) and ${ppgWithout} without (${withoutMatches.length}); the player's presence is associated with this difference, which may also have other explanations.`,
      );
    } else {
      factors.push(`Too few matches with (${withMatches.length}) or without (${withoutMatches.length}) this player to compare team results (minimum ${MIN_SPLIT_MATCHES} each).`);
    }

    players.push({
      player,
      impactScore: score,
      impactConfidence: confidence,
      components: {
        involvement: round(involvement),
        attacking: attacking === null ? null : round(attacking),
        defensive: defensiveComponent === null ? null : round(defensiveComponent),
        withWithout: withWithout === null ? null : round(withWithout),
      },
      sample: { teamMatchesWithPlayerData: n, appearances: rows.length, starts, minutes, matchesWithout: withoutMatches.length },
      withWithout: {
        pointsPerGameWith: ppgWith,
        pointsPerGameWithout: ppgWithout,
        goalsPerGameWith: perGame(withMatches, (r) => r.goalsFor),
        goalsPerGameWithout: perGame(withoutMatches, (r) => r.goalsFor),
      },
      factors,
    });
  }

  players.sort((a, b) => (b.impactScore ?? -1) - (a.impactScore ?? -1) || a.player.name.localeCompare(b.player.name));
  return { teamId, status: 'AVAILABLE', lookback, teamMatchesWithPlayerData: n, players, limitations };
}
