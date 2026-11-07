// Point-in-time team ratings computed only from results the caller has already filtered to "known before the cutoff".
// Parameters are fixed, commonly used literature values chosen before any backtest; they are not tuned on Nexora data.

export interface KnownResult {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  matchDate: Date;
}

// ---- Elo (World Football Elo style: goal-difference multiplier, fixed home advantage) ----

export const ELO = { initial: 1500, k: 20, homeAdvantage: 60, warmupMatches: 100 } as const;

export interface EloState {
  ratings: Map<string, number>;
  // Pre-match home win expectancy and outcome of every rated match after warm-up, for calibrating the draw curve.
  history: Array<{ expectancy: number; outcome: 'HOME' | 'DRAW' | 'AWAY' }>;
  matches: number;
}

export const eloExpectancy = (home: number, away: number, homeAdvantage: number = ELO.homeAdvantage): number => 1 / (1 + 10 ** (-(home + homeAdvantage - away) / 400));

function goalMultiplier(goalDifference: number): number {
  const gd = Math.abs(goalDifference);
  return gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
}

// A club first seen after warm-up (a promoted side) starts at the mean of the three lowest current ratings rather
// than at the league average, which would overrate it.
export function computeElo(results: readonly KnownResult[]): EloState {
  const sorted = [...results].sort((a, b) => a.matchDate.getTime() - b.matchDate.getTime());
  const ratings = new Map<string, number>();
  const history: EloState['history'] = [];
  let matches = 0;
  const entry = (teamId: string) => {
    if (!ratings.has(teamId)) {
      const current = [...ratings.values()].sort((a, b) => a - b);
      ratings.set(teamId, matches >= ELO.warmupMatches && current.length >= 3 ? (current[0]! + current[1]! + current[2]!) / 3 : ELO.initial);
    }
    return ratings.get(teamId)!;
  };
  for (const r of sorted) {
    const home = entry(r.homeTeamId);
    const away = entry(r.awayTeamId);
    const expected = eloExpectancy(home, away);
    const outcome = r.homeScore > r.awayScore ? 'HOME' : r.homeScore < r.awayScore ? 'AWAY' : 'DRAW';
    const score = outcome === 'HOME' ? 1 : outcome === 'DRAW' ? 0.5 : 0;
    if (matches >= ELO.warmupMatches) history.push({ expectancy: expected, outcome });
    const delta = ELO.k * goalMultiplier(r.homeScore - r.awayScore) * (score - expected);
    ratings.set(r.homeTeamId, home + delta);
    ratings.set(r.awayTeamId, away - delta);
    matches += 1;
  }
  return { ratings, history, matches };
}

// Null until the ratings have settled; a club not yet seen gets the promoted-side starting rating.
export function eloRatingFor(state: EloState, teamId: string): number | null {
  if (state.matches < ELO.warmupMatches) return null;
  const known = state.ratings.get(teamId);
  if (known !== undefined) return known;
  const lowest = [...state.ratings.values()].sort((a, b) => a - b).slice(0, 3);
  return lowest.reduce((s, v) => s + v, 0) / lowest.length;
}

export interface CalibratedOutcome {
  home: number;
  draw: number;
  away: number;
  sampleSize: number;
}

// Nonparametric map from Elo expectancy to observed outcome rates (Gaussian kernel), shrunk towards the overall
// rates when few similar matches are known. Learns, for example, how often evenly matched sides draw.
export function calibrateOutcome(history: EloState['history'], expectancy: number, bandwidth = 0.06, priorStrength = 30): CalibratedOutcome | null {
  if (history.length < 50) return null;
  const overall = { home: 0, draw: 0, away: 0 };
  for (const h of history) overall[h.outcome === 'HOME' ? 'home' : h.outcome === 'DRAW' ? 'draw' : 'away'] += 1 / history.length;
  const acc = { home: 0, draw: 0, away: 0 };
  let weight = 0;
  for (const h of history) {
    const w = Math.exp(-(((h.expectancy - expectancy) / bandwidth) ** 2) / 2);
    weight += w;
    acc[h.outcome === 'HOME' ? 'home' : h.outcome === 'DRAW' ? 'draw' : 'away'] += w;
  }
  const blend = (k: keyof typeof acc) => (acc[k] + priorStrength * overall[k]) / (weight + priorStrength);
  const home = blend('home');
  const draw = blend('draw');
  return { home, draw, away: Math.max(0, 1 - home - draw), sampleSize: history.length };
}

// ---- Dixon-Coles: time-weighted Poisson attack/defence model with the low-score dependence correction ----

// xi = 0.0019/day gives older matches half the weight after about a year (Dixon & Coles 1997 order of magnitude).
export const DIXON_COLES = { xiPerDay: 0.0019, iterations: 40, priorMatches: 3, minMatches: 60, establishedWeight: 10 } as const;

export interface DixonColesFit {
  attack: Map<string, number>;
  defence: Map<string, number>;
  homeAdvantage: number;
  rho: number;
  matches: number;
}

const DAY_MS = 86_400_000;

// Weighted maximum likelihood via alternating closed-form updates (Maher 1982), with a weak prior per team so thin
// samples are shrunk: established clubs towards average, newly seen clubs towards the three weakest established ones.
export function fitDixonColes(results: readonly KnownResult[], asOf: Date): DixonColesFit | null {
  if (results.length < DIXON_COLES.minMatches) return null;
  const rows = results.map((r) => ({ ...r, w: Math.exp(-DIXON_COLES.xiPerDay * Math.max(0, (asOf.getTime() - r.matchDate.getTime()) / DAY_MS)) }));
  const teams = [...new Set(rows.flatMap((r) => [r.homeTeamId, r.awayTeamId]))];
  const attack = new Map(teams.map((t) => [t, 1]));
  const defence = new Map(teams.map((t) => [t, 1]));
  const exposure = new Map(teams.map((t) => [t, 0]));
  for (const r of rows) {
    exposure.set(r.homeTeamId, exposure.get(r.homeTeamId)! + r.w);
    exposure.set(r.awayTeamId, exposure.get(r.awayTeamId)! + r.w);
  }
  const totalW = rows.reduce((s, r) => s + r.w, 0);
  const goalsPerTeamMatch = rows.reduce((s, r) => s + r.w * (r.homeScore + r.awayScore), 0) / (2 * totalW);
  let gamma = 1.3;

  const priorFor = new Map<string, { a: number; d: number }>(teams.map((t) => [t, { a: 1, d: 1 }]));
  for (let iter = 0; iter < DIXON_COLES.iterations; iter += 1) {
    // Priors are refreshed from the current fit, so "weakest established" reflects the data, not an assumption.
    const established = teams.filter((t) => exposure.get(t)! >= DIXON_COLES.establishedWeight);
    const weakest = [...established].sort((x, y) => attack.get(x)! / defence.get(x)! - attack.get(y)! / defence.get(y)!).slice(0, 3);
    const weakPrior = weakest.length === 3 ? { a: weakest.reduce((s, t) => s + attack.get(t)!, 0) / 3, d: weakest.reduce((s, t) => s + defence.get(t)!, 0) / 3 } : { a: 1, d: 1 };
    for (const t of teams) priorFor.set(t, exposure.get(t)! >= DIXON_COLES.establishedWeight ? { a: 1, d: 1 } : weakPrior);

    const k = DIXON_COLES.priorMatches * goalsPerTeamMatch;
    const scoredNum = new Map(teams.map((t) => [t, k * priorFor.get(t)!.a]));
    const scoredDen = new Map(teams.map((t) => [t, k]));
    for (const r of rows) {
      scoredNum.set(r.homeTeamId, scoredNum.get(r.homeTeamId)! + r.w * r.homeScore);
      scoredDen.set(r.homeTeamId, scoredDen.get(r.homeTeamId)! + r.w * gamma * defence.get(r.awayTeamId)!);
      scoredNum.set(r.awayTeamId, scoredNum.get(r.awayTeamId)! + r.w * r.awayScore);
      scoredDen.set(r.awayTeamId, scoredDen.get(r.awayTeamId)! + r.w * defence.get(r.homeTeamId)!);
    }
    for (const t of teams) attack.set(t, scoredNum.get(t)! / scoredDen.get(t)!);

    const concededNum = new Map(teams.map((t) => [t, k * priorFor.get(t)!.d]));
    const concededDen = new Map(teams.map((t) => [t, k]));
    for (const r of rows) {
      concededNum.set(r.awayTeamId, concededNum.get(r.awayTeamId)! + r.w * r.homeScore);
      concededDen.set(r.awayTeamId, concededDen.get(r.awayTeamId)! + r.w * gamma * attack.get(r.homeTeamId)!);
      concededNum.set(r.homeTeamId, concededNum.get(r.homeTeamId)! + r.w * r.awayScore);
      concededDen.set(r.homeTeamId, concededDen.get(r.homeTeamId)! + r.w * attack.get(r.awayTeamId)!);
    }
    for (const t of teams) defence.set(t, concededNum.get(t)! / concededDen.get(t)!);

    // Identifiability: mean attack fixed at 1 (defence absorbs the scale).
    const meanA = teams.reduce((s, t) => s + attack.get(t)!, 0) / teams.length;
    for (const t of teams) {
      attack.set(t, attack.get(t)! / meanA);
      defence.set(t, defence.get(t)! * meanA);
    }
    let homeGoals = 0;
    let homeExpected = 0;
    for (const r of rows) {
      homeGoals += r.w * r.homeScore;
      homeExpected += r.w * attack.get(r.homeTeamId)! * defence.get(r.awayTeamId)!;
    }
    gamma = homeGoals / homeExpected;
  }

  // rho only affects the four low scores, so it is fitted separately by a one-dimensional search.
  let rho = 0;
  let best = Number.NEGATIVE_INFINITY;
  for (let candidate = -0.2; candidate <= 0.2 + 1e-9; candidate += 0.01) {
    let ll = 0;
    let valid = true;
    for (const r of rows) {
      if (r.homeScore > 1 || r.awayScore > 1) continue;
      const lh = gamma * attack.get(r.homeTeamId)! * defence.get(r.awayTeamId)!;
      const la = attack.get(r.awayTeamId)! * defence.get(r.homeTeamId)!;
      const t = tau(r.homeScore, r.awayScore, lh, la, candidate);
      if (t <= 0) {
        valid = false;
        break;
      }
      ll += r.w * Math.log(t);
    }
    if (valid && ll > best) {
      best = ll;
      rho = Math.round(candidate * 100) / 100;
    }
  }
  return { attack, defence, homeAdvantage: gamma, rho, matches: rows.length };
}

export function tau(x: number, y: number, lambdaHome: number, lambdaAway: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (x === 0 && y === 1) return 1 + lambdaHome * rho;
  if (x === 1 && y === 0) return 1 + lambdaAway * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

// Expected goals for a fixture; a club absent from the fit gets the newly-seen prior (three weakest established).
export function dixonColesExpectation(fit: DixonColesFit, homeTeamId: string, awayTeamId: string): { home: number; away: number } {
  const teams = [...fit.attack.keys()];
  const weakest = [...teams].sort((x, y) => fit.attack.get(x)! / fit.defence.get(x)! - fit.attack.get(y)! / fit.defence.get(y)!).slice(0, 3);
  const fallback = { a: weakest.reduce((s, t) => s + fit.attack.get(t)!, 0) / weakest.length, d: weakest.reduce((s, t) => s + fit.defence.get(t)!, 0) / weakest.length };
  const a = (t: string) => fit.attack.get(t) ?? fallback.a;
  const d = (t: string) => fit.defence.get(t) ?? fallback.d;
  return { home: fit.homeAdvantage * a(homeTeamId) * d(awayTeamId), away: a(awayTeamId) * d(homeTeamId) };
}

const MAX_GOALS = 10;

function poissonPmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) p *= lambda / i;
  return p;
}

export function dixonColesResult(lambdaHome: number, lambdaAway: number, rho: number): { home: number; draw: number; away: number } {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const p = Math.max(0, poissonPmf(lambdaHome, h) * poissonPmf(lambdaAway, a) * tau(h, a, lambdaHome, lambdaAway, rho));
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away;
  return { home: home / total, draw: draw / total, away: 1 - home / total - draw / total };
}
