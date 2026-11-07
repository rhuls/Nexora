// SCOUT — gathers evidence. Facts only, each with a source and a date; no opinions and no forecasts.
//
// Every value comes from the FeatureBuild the analysis pipeline already produced, which was itself built
// through KnowledgeService at the match's knowledge cutoff. Scout therefore cannot see anything the forecast
// could not see. It must never query the database directly: that is what would leak future information.

import type { Fact, EvidenceBundle, IScout, ScoutInput } from './types.js';
import type { FeatureBuild } from '../features/feature-engineering.service.js';
import type { FormAnalysis } from '../analysis/form.analyzer.js';
import type { TeamAvailability } from '../analysis/availability.analyzer.js';

// A fact built on inputs older than this is flagged; the Skeptic decides what to do about it.
const STALE_AFTER_HOURS = { availability: 72, form: 21 * 24 } as const;
const HOUR_MS = 3_600_000;

const hoursBetween = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / HOUR_MS);

export class Scout implements IScout {
  readonly id = 'SCOUT' as const;

  gather({ build, analysis, now }: ScoutInput): EvidenceBundle {
    const asOf = build.pit.cutoff;
    const facts: Fact[] = [];
    const missing: string[] = [];
    const stale: string[] = [];

    const add = (f: Fact) => {
      facts.push(f);
      if (f.unavailable) missing.push(f.label);
      else if (f.staleHours !== null) stale.push(`${f.label} (newest input ${Math.round(f.staleHours)}h before the cutoff)`);
    };

    // A feature the engine recorded as null is unavailable, never zero.
    const feature = (key: string, label: string, unit: string | null): Fact => {
      const v = build.vector.features[key as keyof typeof build.vector.features];
      return {
        key,
        label,
        value: v?.value ?? null,
        unit,
        source: v?.source ?? 'nexora-knowledge',
        asOf: v?.asOf ?? asOf.toISOString(),
        sampleSize: v?.sampleSize ?? null,
        unavailable: v?.value === null || v === undefined,
        staleHours: null,
      };
    };

    for (const [side, team] of [['home', build.match.homeTeam], ['away', build.match.awayTeam]] as const) {
      const ctx = build.context[side];
      const label = (what: string) => `${team.name} ${what}`;

      add(feature(side === 'home' ? 'recentFormHome' : 'recentFormAway', label('recent form (points per game, last 5)'), 'ppg'));
      add(feature(side === 'home' ? 'goalsHomeAverage' : 'goalsAwayAverage', label('goals scored per match'), 'goals'));
      add(feature(side === 'home' ? 'concededHomeAverage' : 'concededAwayAverage', label('goals conceded per match'), 'goals'));
      add(feature(side === 'home' ? 'homeFormAtHome' : 'awayFormAway', label(side === 'home' ? 'form at home' : 'form away'), 'ppg'));
      add(feature(side === 'home' ? 'shotsOnTargetHomeAverage' : 'shotsOnTargetAwayAverage', label('shots on target per match'), 'shots'));
      add(feature(side === 'home' ? 'cornersHomeAverage' : 'cornersAwayAverage', label('corners per match'), 'corners'));
      add(feature(side === 'home' ? 'possessionHomeAverage' : 'possessionAwayAverage', label('possession'), '%'));
      add(feature(side === 'home' ? 'cardsHomeAverage' : 'cardsAwayAverage', label('cards per match'), 'cards'));
      add(feature(side === 'home' ? 'eloHome' : 'eloAway', label('Elo rating'), 'elo'));

      add(this.formFact(side, team.name, ctx.form, asOf));
      add(this.availabilityFact(side, team.name, ctx.availability, asOf));
      add(this.restFact(side, team.name, ctx.form, build, asOf));
    }

    add(feature('h2hResultBalance', 'Head-to-head result balance', 'share'));
    add(feature('h2hGoalsAverage', 'Head-to-head goals per meeting', 'goals'));
    add(feature('h2hReliability', 'Head-to-head reliability', 'score'));
    add(feature('homeAdvantage', 'League home advantage', 'goals'));
    add(feature('dcExpectedHomeGoals', 'Dixon-Coles expected home goals', 'goals'));
    add(feature('dcExpectedAwayGoals', 'Dixon-Coles expected away goals', 'goals'));

    // Sources Nexora genuinely does not hold. Reported as absent rather than approximated.
    for (const [key, label] of [
      ['weather', 'Weather at kickoff'],
      ['venueTravel', 'Away-side travel distance'],
      ['competitionCongestion', 'Fixture congestion beyond rest days'],
      ['motivationContext', 'Title race / relegation stake'],
    ] as const) {
      add({ key, label, value: null, unit: null, source: 'none', asOf: null, sampleSize: null, unavailable: true, staleHours: null });
    }

    return {
      matchId: build.match.id,
      asOf: asOf.toISOString(),
      facts,
      missing,
      stale,
      dataQuality: build.quality,
    };
  }

  private formFact(side: 'home' | 'away', teamName: string, form: FormAnalysis, asOf: Date): Fact {
    const matches = form.matches ?? [];
    const newest = matches.length > 0 ? new Date(matches[0]!.matchDate) : null;
    const age = newest ? hoursBetween(newest, asOf) : null;
    return {
      key: `${side}FormSequence`,
      label: `${teamName} form sequence (most recent first)`,
      value: matches.length === 0 ? null : form.sequence.join(''),
      unit: null,
      source: 'nexora-knowledge',
      asOf: newest ? newest.toISOString() : null,
      sampleSize: matches.length,
      unavailable: matches.length === 0,
      staleHours: age !== null && age > STALE_AFTER_HOURS.form ? age : null,
    };
  }

  // A player with no report is UNKNOWN, never assumed available, so "0 absentees" is stated only when
  // reports actually exist. status DATA UNAVAILABLE means nothing was published before the cutoff.
  private availabilityFact(side: 'home' | 'away', teamName: string, availability: TeamAvailability, asOf: Date): Fact {
    const reported = availability.status === 'REPORTED';
    const timestamps = availability.players.map((p) => new Date(p.reportedAt).getTime()).filter((t) => Number.isFinite(t));
    const newestReport = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
    const age = newestReport ? hoursBetween(newestReport, asOf) : null;
    return {
      key: `${side}Absentees`,
      label: `${teamName} players reported unavailable`,
      value: reported ? availability.unavailableCount + availability.doubtfulCount : null,
      unit: 'players',
      source: 'nexora-knowledge',
      asOf: newestReport ? newestReport.toISOString() : null,
      sampleSize: availability.reportedPlayers,
      unavailable: !reported,
      staleHours: age !== null && age > STALE_AFTER_HOURS.availability ? age : null,
    };
  }

  // Days since the team's most recent known match. Derived from kickoff dates, which are backbone data.
  private restFact(side: 'home' | 'away', teamName: string, form: FormAnalysis, build: FeatureBuild, asOf: Date): Fact {
    const matches = form.matches ?? [];
    const last = matches.length > 0 ? new Date(matches[0]!.matchDate) : null;
    const days = last ? (build.match.matchDate.getTime() - last.getTime()) / 86_400_000 : null;
    return {
      key: `${side}RestDays`,
      label: `${teamName} days since last known match`,
      value: days === null ? null : Math.round(days * 10) / 10,
      unit: 'days',
      source: 'nexora-knowledge',
      asOf: last ? last.toISOString() : asOf.toISOString(),
      sampleSize: matches.length,
      unavailable: days === null,
      staleHours: null,
    };
  }
}
