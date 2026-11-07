import { normalizeTeamName } from '../identity/team-identity.js';
import type { ProviderMatch, ProviderTeamRef } from '../../providers/types.js';

// ---- Team identity: provider team ID → canonical Nexora team, via curated TeamAlias rows only. ----

export interface AliasRow {
  teamId: string;
  normalizedAlias: string;
  sourceTeamId: string | null;
}

export interface ResolvedTeam {
  teamId: string;
  // Normalized alias whose sourceTeamId should be bound to this provider ID (first successful name resolution).
  bindAlias: string | null;
}

export interface UnresolvedProviderTeam {
  sourceTeamId: string | null;
  name: string;
  reason: 'NO_ALIAS' | 'NO_SOURCE_ID' | 'ID_NAME_CONFLICT' | 'ALIAS_BOUND_TO_OTHER_ID';
}

// An ID binding wins, but only if the printed name does not point at a different club; nothing is ever guessed.
export function resolveProviderTeams(aliases: readonly AliasRow[], refs: readonly ProviderTeamRef[]): { resolved: Map<string, ResolvedTeam>; unresolved: UnresolvedProviderTeam[] } {
  const byId = new Map(aliases.filter((a) => a.sourceTeamId !== null).map((a) => [a.sourceTeamId!, a]));
  const byName = new Map(aliases.map((a) => [a.normalizedAlias, a]));
  const resolved = new Map<string, ResolvedTeam>();
  const unresolved: UnresolvedProviderTeam[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const key = `${ref.sourceId ?? ''}|${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!ref.sourceId) {
      unresolved.push({ sourceTeamId: null, name: ref.name, reason: 'NO_SOURCE_ID' });
      continue;
    }
    const bound = byId.get(ref.sourceId);
    const named = byName.get(normalizeTeamName(ref.name));
    if (bound) {
      if (named && named.teamId !== bound.teamId) unresolved.push({ sourceTeamId: ref.sourceId, name: ref.name, reason: 'ID_NAME_CONFLICT' });
      else resolved.set(ref.sourceId, { teamId: bound.teamId, bindAlias: null });
      continue;
    }
    if (!named) {
      unresolved.push({ sourceTeamId: ref.sourceId, name: ref.name, reason: 'NO_ALIAS' });
      continue;
    }
    if (named.sourceTeamId !== null && named.sourceTeamId !== ref.sourceId) {
      unresolved.push({ sourceTeamId: ref.sourceId, name: ref.name, reason: 'ALIAS_BOUND_TO_OTHER_ID' });
      continue;
    }
    resolved.set(ref.sourceId, { teamId: named.teamId, bindAlias: named.sourceTeamId === null ? named.normalizedAlias : null });
  }
  return { resolved, unresolved };
}

// ---- Fixture matching: provider fixture → existing Nexora match. Never creates or merges ambiguously. ----

export interface CandidateMatch {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  matchDate: Date;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  dataEnvironment: 'SYNTHETIC' | 'HISTORICAL' | 'LIVE';
}

export type MatchedBy = 'EXISTING_LINK' | 'TEAMS_AND_KICKOFF';
export type UnresolvedReason =
  | 'TEAM_UNRESOLVED'
  | 'NO_CANDIDATE'
  | 'AMBIGUOUS_CANDIDATES'
  | 'KICKOFF_MISMATCH'
  | 'DUPLICATE_FIXTURE_FOR_MATCH'
  | 'MATCH_LINKED_TO_OTHER_FIXTURE'
  | 'LINK_TEAMS_DISAGREE';

export interface FixtureMatch {
  fixture: ProviderMatch;
  match: CandidateMatch;
  matchedBy: MatchedBy;
  kickoffDeltaMinutes: number;
}

export interface UnresolvedFixture {
  fixture: ProviderMatch;
  reason: UnresolvedReason;
  detail: string;
}

// Wide enough for timezone slips and date-only kickoffs; a larger gap means a reschedule the backbone has not seen yet.
export const KICKOFF_TOLERANCE_MS = 36 * 60 * 60 * 1000;

export function matchFixtures(input: {
  fixtures: readonly ProviderMatch[];
  teams: ReadonlyMap<string, ResolvedTeam>;
  candidates: readonly CandidateMatch[];
  // provider fixture ID → Nexora match ID, from earlier runs
  linksBySourceId: ReadonlyMap<string, string>;
  // Nexora match ID → provider fixture ID
  linksByMatchId: ReadonlyMap<string, string>;
  toleranceMs?: number;
}): { matched: FixtureMatch[]; unresolved: UnresolvedFixture[] } {
  const tolerance = input.toleranceMs ?? KICKOFF_TOLERANCE_MS;
  const real = input.candidates.filter((c) => c.dataEnvironment !== 'SYNTHETIC');
  const byId = new Map(real.map((c) => [c.id, c]));
  const byPair = new Map<string, CandidateMatch[]>();
  for (const c of real) {
    const k = `${c.homeTeamId}|${c.awayTeamId}`;
    byPair.set(k, [...(byPair.get(k) ?? []), c]);
  }

  const provisional: FixtureMatch[] = [];
  const unresolved: UnresolvedFixture[] = [];
  const delta = (f: ProviderMatch, m: CandidateMatch) => Math.round((f.kickoff.getTime() - m.matchDate.getTime()) / 60_000);

  for (const fixture of input.fixtures) {
    const home = fixture.homeTeam.sourceId ? input.teams.get(fixture.homeTeam.sourceId) : undefined;
    const away = fixture.awayTeam.sourceId ? input.teams.get(fixture.awayTeam.sourceId) : undefined;
    if (!home || !away) {
      unresolved.push({ fixture, reason: 'TEAM_UNRESOLVED', detail: `${!home ? fixture.homeTeam.name : ''}${!home && !away ? ', ' : ''}${!away ? fixture.awayTeam.name : ''} not mapped to a Nexora team` });
      continue;
    }

    const linkedMatchId = input.linksBySourceId.get(fixture.sourceId);
    if (linkedMatchId) {
      const linked = byId.get(linkedMatchId);
      if (linked && linked.homeTeamId === home.teamId && linked.awayTeamId === away.teamId) {
        provisional.push({ fixture, match: linked, matchedBy: 'EXISTING_LINK', kickoffDeltaMinutes: delta(fixture, linked) });
      } else {
        unresolved.push({ fixture, reason: 'LINK_TEAMS_DISAGREE', detail: `Previously linked to match ${linkedMatchId}, which no longer has these teams in this season` });
      }
      continue;
    }

    const candidates = byPair.get(`${home.teamId}|${away.teamId}`) ?? [];
    if (candidates.length === 0) {
      unresolved.push({ fixture, reason: 'NO_CANDIDATE', detail: 'No Nexora match with this home and away team in the season' });
      continue;
    }
    const near = candidates.filter((c) => Math.abs(fixture.kickoff.getTime() - c.matchDate.getTime()) <= tolerance);
    if (near.length > 1) {
      unresolved.push({ fixture, reason: 'AMBIGUOUS_CANDIDATES', detail: `${near.length} Nexora matches fit: ${near.map((c) => c.id).join(', ')}` });
      continue;
    }
    if (near.length === 0) {
      const nearest = candidates.map((c) => delta(fixture, c)).sort((a, b) => Math.abs(a) - Math.abs(b))[0]!;
      unresolved.push({ fixture, reason: 'KICKOFF_MISMATCH', detail: `Kickoff differs by ${Math.round(nearest / 60)}h from the Nexora fixture (tolerance ${tolerance / 3_600_000}h)` });
      continue;
    }
    const match = near[0]!;
    const other = input.linksByMatchId.get(match.id);
    if (other && other !== fixture.sourceId) {
      unresolved.push({ fixture, reason: 'MATCH_LINKED_TO_OTHER_FIXTURE', detail: `Match ${match.id} is already linked to fixture ${other}` });
      continue;
    }
    provisional.push({ fixture, match, matchedBy: 'TEAMS_AND_KICKOFF', kickoffDeltaMinutes: delta(fixture, match) });
  }

  // Two provider fixtures claiming one Nexora match are both left unresolved rather than merged.
  const claims = new Map<string, number>();
  for (const p of provisional) claims.set(p.match.id, (claims.get(p.match.id) ?? 0) + 1);
  const matched: FixtureMatch[] = [];
  for (const p of provisional) {
    if (claims.get(p.match.id)! > 1) unresolved.push({ fixture: p.fixture, reason: 'DUPLICATE_FIXTURE_FOR_MATCH', detail: `Several provider fixtures map to match ${p.match.id}` });
    else matched.push(p);
  }
  return { matched, unresolved };
}

export interface ResultComparison {
  enrichable: boolean;
  conflict: { canonical: { home: number | null; away: number | null; status: string }; source: { home: number | null; away: number | null; status: string } } | null;
  reason: 'OK' | 'RESULT_CONFLICT' | 'AWAITING_CANONICAL_RESULT' | 'NOT_FINISHED_AT_SOURCE' | 'NOT_FINISHED';
}

// Post-match data is attached only when both sources agree the match is finished with the same score.
export function compareResult(match: CandidateMatch, fixture: ProviderMatch): ResultComparison {
  const nexoraDone = match.status === 'FINISHED';
  const sourceDone = fixture.status === 'FINISHED';
  if (nexoraDone && sourceDone) {
    if (match.homeScore !== fixture.homeScore || match.awayScore !== fixture.awayScore) {
      return {
        enrichable: false,
        reason: 'RESULT_CONFLICT',
        conflict: { canonical: { home: match.homeScore, away: match.awayScore, status: match.status }, source: { home: fixture.homeScore, away: fixture.awayScore, status: fixture.status } },
      };
    }
    return { enrichable: true, reason: 'OK', conflict: null };
  }
  if (sourceDone) return { enrichable: false, reason: 'AWAITING_CANONICAL_RESULT', conflict: null };
  if (nexoraDone) return { enrichable: false, reason: 'NOT_FINISHED_AT_SOURCE', conflict: null };
  return { enrichable: false, reason: 'NOT_FINISHED', conflict: null };
}
