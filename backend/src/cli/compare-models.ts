import { parseArgs } from 'node:util';
import { createPrismaClient } from '../config/prisma.js';
import { resultKnownAt } from '../data/knowledge/cutoff.js';
import { ensemble } from '../analysis/engine.js';
import { FeatureEngineeringService } from '../features/feature-engineering.service.js';
import { ModelRegistry } from '../learning/model-registry.js';
import { createModelAdapters, type ModelAdapters, type ModelSet } from '../models/adapters.js';
import type { ResultProbabilities } from '../models/types.js';

// Read-only, side-by-side walk-forward backtest: every model sees the same point-in-time features (cutoff = kickoff).
// Nothing is written to the database.

const { values } = parseArgs({ options: { env: { type: 'string', default: 'HISTORICAL' }, max: { type: 'string' } } });
const env = values.env!.toUpperCase();
if (env !== 'HISTORICAL' && env !== 'SYNTHETIC') {
  console.error('--env must be HISTORICAL or SYNTHETIC');
  process.exit(1);
}

type Label = 'HOME' | 'DRAW' | 'AWAY';
type Contender = 'legacy' | 'ratings' | 'poisson-blend' | 'rating-differential' | 'dixon-coles' | 'elo-calibrated' | 'always-home' | 'known-base-rates';
interface Row {
  season: string;
  actual: Label;
  p: Partial<Record<Contender, ResultProbabilities>>;
}

const argmax = (p: ResultProbabilities): Label => (p.home >= p.draw && p.home >= p.away ? 'HOME' : p.away >= p.draw ? 'AWAY' : 'DRAW');
const brier = (p: ResultProbabilities, a: Label) => (p.home - (a === 'HOME' ? 1 : 0)) ** 2 + (p.draw - (a === 'DRAW' ? 1 : 0)) ** 2 + (p.away - (a === 'AWAY' ? 1 : 0)) ** 2;
const prob = (p: ResultProbabilities, a: Label) => (a === 'HOME' ? p.home : a === 'DRAW' ? p.draw : p.away);
const logLoss = (p: ResultProbabilities, a: Label) => -Math.log(Math.max(1e-12, prob(p, a)));
const withDrawRule = (p: ResultProbabilities, t: number): Label => (p.draw >= t ? 'DRAW' : p.home >= p.away ? 'HOME' : 'AWAY');

function ece(rows: Array<{ p: ResultProbabilities; a: Label }>): number {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, hit: 0 }));
  for (const { p, a } of rows) {
    for (const l of ['HOME', 'DRAW', 'AWAY'] as const) {
      const c = prob(p, l);
      const b = bins[Math.min(9, Math.floor(c * 10))]!;
      b.n += 1;
      b.conf += c;
      b.hit += l === a ? 1 : 0;
    }
  }
  const total = bins.reduce((s, b) => s + b.n, 0);
  return bins.reduce((s, b) => (b.n === 0 ? s : s + (b.n / total) * Math.abs(b.conf / b.n - b.hit / b.n)), 0);
}

function score(rows: Row[], c: Contender) {
  const scored = rows.filter((r) => r.p[c]).map((r) => ({ p: r.p[c]!, a: r.actual }));
  const n = scored.length;
  const mean = (f: (x: (typeof scored)[number]) => number) => scored.reduce((s, x) => s + f(x), 0) / n;
  return {
    n,
    accuracy: mean((x) => (argmax(x.p) === x.a ? 1 : 0)),
    brier: mean((x) => brier(x.p, x.a)),
    logLoss: mean((x) => logLoss(x.p, x.a)),
    ece: ece(scored),
    drawsPredicted: scored.filter((x) => argmax(x.p) === 'DRAW').length,
  };
}

// Mean paired Brier difference (b - a) with a normal-approximation 95% interval; negative means b is better.
function pairedBrier(rows: Row[], a: Contender, b: Contender) {
  const d = rows.filter((r) => r.p[a] && r.p[b]).map((r) => brier(r.p[b]!, r.actual) - brier(r.p[a]!, r.actual));
  const n = d.length;
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const half = 1.96 * (sd / Math.sqrt(n));
  return { n, mean, low: mean - half, high: mean + half };
}

const f = (v: number, p = 4) => v.toFixed(p);
const pc = (v: number) => `${(v * 100).toFixed(1)}%`;

const prisma = createPrismaClient();
try {
  const registry = new ModelRegistry(prisma);
  const weights = await registry.weightsOf((await registry.baseline()).id);
  const sets: Record<ModelSet, ModelAdapters> = { legacy: createModelAdapters('legacy'), ratings: createModelAdapters('ratings') };
  const features = new FeatureEngineeringService(prisma);
  const matches = await prisma.match.findMany({
    where: { dataEnvironment: env, status: 'FINISHED' },
    select: { id: true, matchDate: true, kickoffTimeKnown: true, homeScore: true, awayScore: true, season: { select: { name: true } } },
    orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
    take: values.max ? Number(values.max) : undefined,
  });

  const rows: Row[] = [];
  const started = Date.now();
  for (const [i, m] of matches.entries()) {
    const build = await features.build(m.id);
    const actual: Label = m.homeScore! > m.awayScore! ? 'HOME' : m.homeScore! < m.awayScore! ? 'AWAY' : 'DRAW';
    const row: Row = { season: m.season.name, actual, p: {} };
    for (const [set, adapters] of Object.entries(sets) as Array<[ModelSet, ModelAdapters]>) {
      const context = { weights, modelVersion: 'comparison' };
      const outputs = (await Promise.all([adapters.mathematical.run(build.vector, context), adapters.dataAnalysis.run(build.vector, context)])).flatMap((r) => (r.ok ? [r.output] : []));
      const combined = ensemble(outputs).MATCH_RESULT;
      if (combined) row.p[set] = { home: combined.home, draw: combined.draw, away: combined.away };
      for (const o of outputs) if (o.forecasts.MATCH_RESULT) row.p[o.model as Contender] = o.forecasts.MATCH_RESULT;
    }
    // Reference points using only results known at this kickoff.
    const known = matches.slice(0, i).filter((x) => resultKnownAt(x).getTime() < m.matchDate.getTime());
    if (known.length >= 30) {
      const count = (l: Label) => known.filter((x) => (x.homeScore! > x.awayScore! ? 'HOME' : x.homeScore! < x.awayScore! ? 'AWAY' : 'DRAW') === l).length / known.length;
      const home = count('HOME');
      const draw = count('DRAW');
      row.p['known-base-rates'] = { home, draw, away: 1 - home - draw };
    }
    row.p['always-home'] = { home: 1, draw: 0, away: 0 };
    rows.push(row);
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${matches.length} matches (${Math.round((Date.now() - started) / 1000)}s)`);
  }

  // Compare only matches every contender could forecast, so no model is scored on easier matches.
  const contenders: Contender[] = ['legacy', 'ratings', 'poisson-blend', 'rating-differential', 'dixon-coles', 'elo-calibrated', 'known-base-rates', 'always-home'];
  const common = rows.filter((r) => contenders.every((c) => r.p[c]));
  const drawRate = common.filter((r) => r.actual === 'DRAW').length / common.length;
  const line = '='.repeat(96);
  console.log(`\n${line}\nNEXORA MODEL COMPARISON [${env}] — read-only, walk-forward, cutoff = kickoff\n${line}`);
  console.log(`Matches: ${rows.length} finished; ${common.length} forecast by every contender (${pc(drawRate)} draws).`);
  console.log('Note: dixon-coles / elo-calibrated fall back to the legacy models until enough results are known to fit ratings.\n');
  console.log(`${'model'.padEnd(22)}${'n'.padStart(6)}${'accuracy'.padStart(10)}${'brier'.padStart(9)}${'logLoss'.padStart(9)}${'ECE'.padStart(8)}${'draws called'.padStart(14)}`);
  for (const c of contenders) {
    const s = score(common, c);
    console.log(`${c.padEnd(22)}${String(s.n).padStart(6)}${pc(s.accuracy).padStart(10)}${f(s.brier).padStart(9)}${(c === 'always-home' ? '  —' : f(s.logLoss)).padStart(9)}${f(s.ece, 3).padStart(8)}${String(s.drawsPredicted).padStart(14)}`);
  }

  console.log('\nBy season (legacy → ratings):');
  for (const season of [...new Set(common.map((r) => r.season))]) {
    const rs = common.filter((r) => r.season === season);
    const [a, b] = [score(rs, 'legacy'), score(rs, 'ratings')];
    console.log(`  ${season}  n=${String(rs.length).padStart(3)}  accuracy ${pc(a.accuracy)} → ${pc(b.accuracy)}   brier ${f(a.brier)} → ${f(b.brier)}   logLoss ${f(a.logLoss)} → ${f(b.logLoss)}`);
  }

  const d = pairedBrier(common, 'legacy', 'ratings');
  console.log(`\nPaired Brier difference (ratings − legacy): ${f(d.mean)} [95% CI ${f(d.low)}, ${f(d.high)}] over ${d.n} matches — ${d.high < 0 ? 'ratings significantly better' : d.low > 0 ? 'ratings significantly worse' : 'not statistically distinguishable'}.`);

  // Draw rule: threshold chosen on the first season only, then scored on later, unseen seasons.
  const seasons = [...new Set(common.map((r) => r.season))];
  if (seasons.length >= 2) {
    const [tuneSeason, ...testSeasons] = seasons;
    const tune = common.filter((r) => r.season === tuneSeason);
    const test = common.filter((r) => r.season !== tuneSeason);
    console.log(`\nDraw rule "call DRAW when p(draw) ≥ t" — t tuned on ${tuneSeason} (n=${tune.length}), tested on ${testSeasons.join(', ')} (n=${test.length}):`);
    for (const c of ['legacy', 'ratings'] as const) {
      const acc = (rs: Row[], t: number | null) => rs.reduce((s, r) => s + ((t === null ? argmax(r.p[c]!) : withDrawRule(r.p[c]!, t)) === r.actual ? 1 : 0), 0) / rs.length;
      let bestT = 1;
      let bestAcc = acc(tune, null);
      for (let t = 0.2; t <= 0.4 + 1e-9; t += 0.005) {
        const a = acc(tune, t);
        if (a > bestAcc + 1e-9) {
          bestAcc = a;
          bestT = Math.round(t * 1000) / 1000;
        }
      }
      const draws = test.filter((r) => withDrawRule(r.p[c]!, bestT) === 'DRAW').length;
      console.log(`  ${c.padEnd(8)} best t=${bestT >= 1 ? 'none (never call draws)' : bestT}  tuning ${pc(acc(tune, null))} → ${pc(bestAcc)}   unseen seasons ${pc(acc(test, null))} → ${pc(acc(test, bestT >= 1 ? null : bestT))} (${draws} draws called)`);
    }
  }
  console.log(`\nCompleted in ${Math.round((Date.now() - started) / 1000)}s. No database writes.\n${line}`);
} finally {
  await prisma.$disconnect();
}
