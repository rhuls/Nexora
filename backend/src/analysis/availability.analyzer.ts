import type { AvailabilityReport } from '../data/knowledge/knowledge.service.js';
import { round } from './metrics.js';
import type { ImpactConfidence, TeamPlayerImpacts } from './player-impact.analyzer.js';

export const AVAILABILITY_ANALYZER_VERSION = '1.0.0';

export type ImpactLabel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface UnavailablePlayer {
  player: { id: string; name: string; position: string };
  status: AvailabilityReport['status'];
  reason: string | null;
  expectedReturn: string | null;
  reportedAt: string;
  // 1 for injured/suspended, 0.5 for doubtful, 0 for unknown status.
  absenceWeight: number;
  impactScore: number | null;
  impactLabel: ImpactLabel;
  impactConfidence: ImpactConfidence | null;
}

export interface TeamAvailability {
  team: { id: string; name: string };
  status: 'REPORTED' | 'DATA UNAVAILABLE';
  reportedPlayers: number;
  unavailableCount: number;
  doubtfulCount: number;
  unknownCount: number;
  // Sum of absence-weighted impact scores / 100: "full-impact players missing".
  combinedImpact: number | null;
  attackingImpact: number | null;
  defensiveImpact: number | null;
  confidence: ImpactConfidence | 'DATA UNAVAILABLE';
  players: UnavailablePlayer[];
  explanation: string[];
  limitations: string[];
}

const ABSENCE_WEIGHT: Record<AvailabilityReport['status'], number> = { AVAILABLE: 0, INJURED: 1, SUSPENDED: 1, DOUBTFUL: 0.5, UNKNOWN: 0 };

export function impactLabel(score: number | null): ImpactLabel {
  if (score === null) return 'UNKNOWN';
  return score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';
}

export function analyzeAvailability(team: { id: string; name: string }, reports: AvailabilityReport[], impacts: TeamPlayerImpacts): TeamAvailability {
  const own = reports.filter((r) => r.player.teamId === team.id);
  if (own.length === 0) {
    return {
      team,
      status: 'DATA UNAVAILABLE',
      reportedPlayers: 0,
      unavailableCount: 0,
      doubtfulCount: 0,
      unknownCount: 0,
      combinedImpact: null,
      attackingImpact: null,
      defensiveImpact: null,
      confidence: 'DATA UNAVAILABLE',
      players: [],
      explanation: [],
      limitations: [`No availability report for ${team.name} was published before the cutoff.`],
    };
  }

  const impactById = new Map(impacts.players.map((p) => [p.player.id, p]));
  const listed = own.filter((r) => r.status !== 'AVAILABLE');
  const players: UnavailablePlayer[] = listed.map((r) => {
    const impact = impactById.get(r.player.id);
    return {
      player: { id: r.player.id, name: r.player.name, position: r.player.position },
      status: r.status,
      reason: r.reason,
      expectedReturn: r.expectedReturn,
      reportedAt: r.reportedAt,
      absenceWeight: ABSENCE_WEIGHT[r.status],
      impactScore: impact?.impactScore ?? null,
      impactLabel: impactLabel(impact?.impactScore ?? null),
      impactConfidence: impact?.impactConfidence ?? null,
    };
  });
  players.sort((a, b) => (b.impactScore ?? -1) * b.absenceWeight - (a.impactScore ?? -1) * a.absenceWeight || a.player.name.localeCompare(b.player.name));

  const weighted = players.filter((p) => p.absenceWeight > 0);
  const scored = weighted.filter((p) => p.impactScore !== null);
  const combined = impacts.status === 'AVAILABLE' ? round(scored.reduce((s, p) => s + (p.absenceWeight * p.impactScore!) / 100, 0)) : null;
  const component = (key: 'attacking' | 'defensive') =>
    impacts.status === 'AVAILABLE' ? round(scored.reduce((s, p) => s + p.absenceWeight * (impactById.get(p.player.id)?.components[key] ?? 0), 0)) : null;

  const unscored = weighted.length - scored.length;
  const lowConfidence = scored.filter((p) => p.impactConfidence === 'LOW').length;
  const confidence: ImpactConfidence = impacts.status !== 'AVAILABLE' ? 'LOW' : unscored > 0 || lowConfidence > 0 ? 'MEDIUM' : 'HIGH';

  const explanation: string[] = [];
  const counts = {
    unavailable: players.filter((p) => p.status === 'INJURED' || p.status === 'SUSPENDED').length,
    doubtful: players.filter((p) => p.status === 'DOUBTFUL').length,
    unknown: players.filter((p) => p.status === 'UNKNOWN').length,
  };
  if (players.length === 0) explanation.push(`${team.name}: every reported player was available.`);
  for (const p of players.slice(0, 5)) {
    explanation.push(
      `${p.player.name} (${p.status.toLowerCase()}${p.reason ? `: ${p.reason}` : ''}) — impact ${p.impactScore === null ? 'unknown' : `${p.impactScore}/100 (${p.impactLabel.toLowerCase()})`}.`,
    );
  }
  if (combined !== null && weighted.length > 0) explanation.push(`Combined absence is equivalent to ${combined} full-impact players, weighting doubtful players at half.`);

  const limitations: string[] = [];
  if (impacts.status !== 'AVAILABLE') limitations.push(`Player impact data is unavailable for ${team.name}; absences are listed but not weighted.`);
  if (unscored > 0) limitations.push(`${unscored} absent player(s) have no impact score (no recorded appearances in the lookback).`);
  if (counts.unknown > 0) limitations.push(`${counts.unknown} player(s) have an UNKNOWN status and are not counted as absent.`);

  return {
    team,
    status: 'REPORTED',
    reportedPlayers: own.length,
    unavailableCount: counts.unavailable,
    doubtfulCount: counts.doubtful,
    unknownCount: counts.unknown,
    combinedImpact: combined,
    attackingImpact: component('attacking'),
    defensiveImpact: component('defensive'),
    confidence,
    players,
    explanation,
    limitations,
  };
}
