import { featureValue, type FeatureName, type MatchFeatureVector } from '../features/feature-engineering.service.js';
import type { FeatureGroup, IDataAnalysisModel, ModelContext, ModelOutput } from './types.js';

const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Mock data-analysis model: weighted standardised differences -> rating gap -> result probabilities.
export class RatingDifferentialModel implements IDataAnalysisModel {
  readonly id = 'rating-differential';
  readonly implementationVersion = '1.0.0';

  analyze(vector: MatchFeatureVector, { weights: w }: ModelContext): ModelOutput {
    const v = (n: FeatureName) => featureValue(vector, n);
    const diff = (a: FeatureName, b: FeatureName, scale: number) => {
      const x = v(a);
      const y = v(b);
      return x === null || y === null ? null : (x - y) / scale;
    };
    const reliability = v('h2hReliability') ?? 0;
    const goalDiff = (() => {
      const [gh, ch, ga, ca] = [v('goalsHomeAverage'), v('concededHomeAverage'), v('goalsAwayAverage'), v('concededAwayAverage')];
      return gh === null || ch === null || ga === null || ca === null ? null : (gh - ch - (ga - ca)) / 2;
    })();
    const balance = v('h2hResultBalance');

    const signals: Array<[FeatureGroup, number | null]> = [
      ['recentForm', diff('recentFormHome', 'recentFormAway', 1.5)],
      ['goals', goalDiff],
      ['shotsOnTarget', diff('shotsOnTargetHomeAverage', 'shotsOnTargetAwayAverage', 3)],
      ['homeAway', diff('homeFormAtHome', 'awayFormAway', 1.5)],
      ['h2h', balance === null ? null : balance * reliability],
      ['availability', diff('availabilityAwayImpact', 'availabilityHomeImpact', 1.5)],
      ['discipline', diff('cardsAwayAverage', 'cardsHomeAverage', 2)],
      ['corners', diff('cornersHomeAverage', 'cornersAwayAverage', 4)],
    ];
    const used = signals.filter((s): s is [FeatureGroup, number] => s[1] !== null && w[s[0]] > 0);
    const components: Record<string, number> = {};
    const notes: string[] = [];
    const forecasts: ModelOutput['forecasts'] = {};

    if (used.length > 0) {
      const totalWeight = used.reduce((s, [g]) => s + w[g], 0);
      const rating = used.reduce((s, [g, x]) => s + w[g] * x, 0) / totalWeight;
      const edge = v('homeAdvantage') ?? 0;
      const drawShare = Math.max(0.12, 0.3 * Math.exp(-1.2 * Math.abs(rating)));
      const home = (1 - drawShare) * sigmoid(3 * rating + edge);
      forecasts.MATCH_RESULT = { home, draw: drawShare, away: 1 - home - drawShare };
      components.ratingGap = round(rating);
      components.signalsUsed = used.length;
      for (const [g, x] of used) components[`signal.${g}`] = round(x);
      notes.push(`Rating gap ${round(rating, 3)} from ${used.length} weighted indicator(s); positive favours the home team.`);
    } else {
      notes.push('No comparable indicators were known for both teams.');
    }

    const totals = (candidates: Array<number | null>) => median(candidates.filter((c): c is number => c !== null));
    const sum = (a: FeatureName, b: FeatureName) => {
      const x = v(a);
      const y = v(b);
      return x === null || y === null ? null : x + y;
    };
    const teamGoals = (() => {
      const [gh, ga, ch, ca] = [v('goalsHomeAverage'), v('goalsAwayAverage'), v('concededHomeAverage'), v('concededAwayAverage')];
      return gh === null || ga === null || ch === null || ca === null ? null : (gh + ca) / 2 + (ga + ch) / 2;
    })();
    const league = sum('leagueHomeGoals', 'leagueAwayGoals');
    const trustH2h = reliability >= 0.3;
    const goals = totals([teamGoals, league, trustH2h ? v('h2hGoalsAverage') : null]);
    if (goals !== null) forecasts.GOALS = round(goals);
    const corners = totals([sum('cornersHomeAverage', 'cornersAwayAverage'), trustH2h ? v('h2hCornersAverage') : null]);
    if (corners !== null) forecasts.CORNERS = round(corners);
    const cards = totals([sum('cardsHomeAverage', 'cardsAwayAverage'), trustH2h ? v('h2hCardsAverage') : null]);
    if (cards !== null) forecasts.CARDS = round(cards);
    const shots = totals([sum('shotsHomeAverage', 'shotsAwayAverage'), trustH2h ? v('h2hShotsAverage') : null]);
    if (shots !== null) forecasts.SHOTS = round(shots);
    const sot = totals([sum('shotsOnTargetHomeAverage', 'shotsOnTargetAwayAverage'), trustH2h ? v('h2hShotsOnTargetAverage') : null]);
    if (sot !== null) forecasts.SHOTS_ON_TARGET = round(sot);

    return { model: this.id, modelKind: 'DATA_ANALYSIS', implementationVersion: this.implementationVersion, forecasts, components, notes };
  }
}
