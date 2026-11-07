import { featureValue, type MatchFeatureVector } from '../features/feature-engineering.service.js';
import { dixonColesResult } from '../analysis/ratings.js';
import { RatingDifferentialModel } from './data-analysis.model.js';
import { PoissonBlendModel } from './mathematical.model.js';
import type { IDataAnalysisModel, IMathematicalModel, ModelContext, ModelOutput } from './types.js';

const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

// Dixon-Coles goal model for result and total goals; corners, cards and shots come from the Poisson blend.
// Falls back entirely to the Poisson blend until enough results are known to fit the ratings.
export class DixonColesModel implements IMathematicalModel {
  readonly id = 'dixon-coles';
  readonly implementationVersion = '1.0.0';
  private readonly fallback = new PoissonBlendModel();

  calculate(vector: MatchFeatureVector, context: ModelContext): ModelOutput {
    const base = this.fallback.calculate(vector, context);
    const lh = featureValue(vector, 'dcExpectedHomeGoals');
    const la = featureValue(vector, 'dcExpectedAwayGoals');
    const rho = featureValue(vector, 'dcRho');
    if (lh === null || la === null || rho === null) {
      return { ...base, model: this.id, implementationVersion: this.implementationVersion, notes: [...base.notes, 'Dixon-Coles ratings not yet available; Poisson blend used for the result.'] };
    }
    return {
      ...base,
      model: this.id,
      implementationVersion: this.implementationVersion,
      forecasts: { ...base.forecasts, MATCH_RESULT: dixonColesResult(lh, la, rho), GOALS: round(lh + la) },
      components: { ...base.components, expectedHomeGoals: round(lh), expectedAwayGoals: round(la), dixonColesRho: rho },
      notes: [`Dixon-Coles team ratings (time-weighted, low-score corrected) expect ${round(lh, 2)} home and ${round(la, 2)} away goals.`, ...base.notes.filter((n) => !n.startsWith('Expected goals'))],
    };
  }
}

// Elo ratings mapped to outcome rates learned from earlier matches between similarly rated sides (including how
// often they drew). Totals come from the rating-differential model, which also serves as the fallback.
export class EloCalibratedModel implements IDataAnalysisModel {
  readonly id = 'elo-calibrated';
  readonly implementationVersion = '1.0.0';
  private readonly fallback = new RatingDifferentialModel();

  analyze(vector: MatchFeatureVector, context: ModelContext): ModelOutput {
    const base = this.fallback.analyze(vector, context);
    const [home, draw, away] = [featureValue(vector, 'eloCalibratedHome'), featureValue(vector, 'eloCalibratedDraw'), featureValue(vector, 'eloCalibratedAway')];
    const expectancy = featureValue(vector, 'eloHomeExpectancy');
    if (home === null || draw === null || away === null || expectancy === null) {
      return { ...base, model: this.id, implementationVersion: this.implementationVersion, notes: [...base.notes, 'Elo ratings not yet settled; rating differential used for the result.'] };
    }
    const total = home + draw + away;
    const h = home / total;
    const d = draw / total;
    return {
      ...base,
      model: this.id,
      implementationVersion: this.implementationVersion,
      forecasts: { ...base.forecasts, MATCH_RESULT: { home: h, draw: d, away: 1 - h - d } },
      components: { ...base.components, eloHome: featureValue(vector, 'eloHome') ?? 0, eloAway: featureValue(vector, 'eloAway') ?? 0, eloHomeExpectancy: expectancy },
      notes: [`Elo expectancy ${round(expectancy, 3)} for the home side; earlier matches with similar ratings ended ${Math.round(h * 100)}% home, ${Math.round(d * 100)}% draw, ${Math.round((1 - h - d) * 100)}% away.`, ...base.notes],
    };
  }
}
