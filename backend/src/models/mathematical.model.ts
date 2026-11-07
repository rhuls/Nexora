import { featureValue, type FeatureName, type MatchFeatureVector } from '../features/feature-engineering.service.js';
import type { IMathematicalModel, ModelContext, ModelOutput, ResultProbabilities } from './types.js';

const MAX_GOALS = 10;
// Fixed weight given to the league baseline so thin team samples are shrunk towards it.
const BASELINE_PRIOR_WEIGHT = 0.1;
// Weight at which the availability adjustment is applied at full strength (the brief's initial availability weight).
const AVAILABILITY_REFERENCE_WEIGHT = 0.15;

interface Estimate {
  value: number;
  weight: number;
  label: string;
}

function blend(estimates: Estimate[]): number | null {
  const usable = estimates.filter((e) => e.weight > 0 && Number.isFinite(e.value));
  const total = usable.reduce((s, e) => s + e.weight, 0);
  return total > 0 ? usable.reduce((s, e) => s + e.value * e.weight, 0) / total : null;
}

function poissonPmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) p *= lambda / i;
  return p;
}

export function resultFromPoisson(lambdaHome: number, lambdaAway: number): ResultProbabilities {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const p = poissonPmf(lambdaHome, h) * poissonPmf(lambdaAway, a);
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away;
  return { home: home / total, draw: draw / total, away: 1 - home / total - draw / total };
}

const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

// Mock mathematical model: weighted Poisson goal model. Replace via MathematicalModelAdapter with the real one.
export class PoissonBlendModel implements IMathematicalModel {
  readonly id = 'poisson-blend';
  readonly implementationVersion = '1.0.0';

  calculate(vector: MatchFeatureVector, { weights: w }: ModelContext): ModelOutput {
    const v = (n: FeatureName) => featureValue(vector, n);
    const notes: string[] = [];
    const components: Record<string, number> = {};
    const reliability = v('h2hReliability') ?? 0;

    const side = (att: 'Home' | 'Away') => {
      const opp = att === 'Home' ? 'Away' : 'Home';
      const gf = v(`goals${att}Average`);
      const ga = v(`conceded${opp}Average`);
      const split = att === 'Home' ? [v('homeGoalsAtHome'), v('awayConcededAway')] : [v('awayGoalsAway'), v('homeConcededAtHome')];
      const sot = v(`shotsOnTarget${att}Average`);
      const conv = v('goalsPerShotOnTarget');
      const league = att === 'Home' ? v('leagueHomeGoals') : v('leagueAwayGoals');
      const ppgOwn = v(`recentForm${att}`);
      const ppgOpp = v(`recentForm${opp}`);
      const h2hGoals = att === 'Home' ? v('h2hHomeGoals') : v('h2hAwayGoals');
      const estimates: Estimate[] = [];
      if (gf !== null && ga !== null) estimates.push({ value: (gf + ga) / 2, weight: w.goals, label: 'goals' });
      if (split[0] != null && split[1] != null) estimates.push({ value: (split[0] + split[1]) / 2, weight: w.homeAway, label: 'homeAway' });
      if (sot !== null && conv !== null) estimates.push({ value: sot * conv, weight: w.shotsOnTarget, label: 'shotsOnTarget' });
      if (league !== null && ppgOwn !== null && ppgOpp !== null) estimates.push({ value: Math.max(0.05, league * (1 + 0.15 * (ppgOwn - ppgOpp))), weight: w.recentForm, label: 'recentForm' });
      if (h2hGoals !== null) estimates.push({ value: h2hGoals, weight: w.h2h * reliability, label: 'h2h' });
      if (league !== null) estimates.push({ value: league, weight: BASELINE_PRIOR_WEIGHT, label: 'leagueBaseline' });
      let lambda = blend(estimates);
      if (lambda === null) return null;

      const strength = w.availability / AVAILABILITY_REFERENCE_WEIGHT;
      const ownAttackLoss = att === 'Home' ? v('availabilityHomeAttacking') : v('availabilityAwayAttacking');
      const oppDefenceLoss = att === 'Home' ? v('availabilityAwayDefensive') : v('availabilityHomeDefensive');
      if (ownAttackLoss !== null) lambda *= Math.min(1, Math.max(0.7, 1 - 0.1 * ownAttackLoss * strength));
      if (oppDefenceLoss !== null) lambda *= Math.max(1, Math.min(1.3, 1 + 0.1 * oppDefenceLoss * strength));
      components[`${att.toLowerCase()}EstimatesUsed`] = estimates.length;
      return Math.max(0.05, lambda);
    };

    const lambdaHome = side('Home');
    const lambdaAway = side('Away');
    const forecasts: ModelOutput['forecasts'] = {};
    if (lambdaHome !== null && lambdaAway !== null) {
      components.expectedHomeGoals = round(lambdaHome);
      components.expectedAwayGoals = round(lambdaAway);
      forecasts.MATCH_RESULT = resultFromPoisson(lambdaHome, lambdaAway);
      forecasts.GOALS = round(lambdaHome + lambdaAway);
      notes.push(`Expected goals ${round(lambdaHome, 2)} (home) and ${round(lambdaAway, 2)} (away) from a weighted blend of known averages.`);
    } else {
      notes.push('Not enough known goal information to estimate expected goals.');
    }

    const total = (teamA: FeatureName, teamB: FeatureName, h2h: FeatureName, teamWeight: number, key: string) => {
      const a = v(teamA);
      const b = v(teamB);
      const estimates: Estimate[] = [];
      if (a !== null && b !== null) estimates.push({ value: a + b, weight: teamWeight, label: 'teams' });
      const h = v(h2h);
      if (h !== null) estimates.push({ value: h, weight: w.h2h * reliability, label: 'h2h' });
      const value = blend(estimates);
      if (value === null) return undefined;
      components[`${key}EstimatesUsed`] = estimates.length;
      return round(value);
    };
    forecasts.CORNERS = total('cornersHomeAverage', 'cornersAwayAverage', 'h2hCornersAverage', w.corners, 'corners');
    forecasts.CARDS = total('cardsHomeAverage', 'cardsAwayAverage', 'h2hCardsAverage', w.discipline, 'cards');
    forecasts.SHOTS = total('shotsHomeAverage', 'shotsAwayAverage', 'h2hShotsAverage', w.shotsOnTarget, 'shots');
    forecasts.SHOTS_ON_TARGET = total('shotsOnTargetHomeAverage', 'shotsOnTargetAwayAverage', 'h2hShotsOnTargetAverage', w.shotsOnTarget, 'shotsOnTarget');
    for (const key of Object.keys(forecasts) as Array<keyof typeof forecasts>) if (forecasts[key] === undefined) delete forecasts[key];

    return { model: this.id, modelKind: 'MATHEMATICAL', implementationVersion: this.implementationVersion, forecasts, components, notes };
  }
}
