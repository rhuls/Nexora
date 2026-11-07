import { parseArgs } from 'node:util';
import { createPrismaClient } from '../config/prisma.js';
import { LearningSimulator, type SimulationSummary } from '../learning/simulator.js';
import { ModelRegistry } from '../learning/model-registry.js';

const { values } = parseArgs({
  options: {
    env: { type: 'string', default: 'HISTORICAL' },
    competition: { type: 'string' },
    max: { type: 'string' },
    'adopt-live': { type: 'boolean', default: false },
  },
});

const env = values.env!.toUpperCase();
if (env !== 'HISTORICAL' && env !== 'SYNTHETIC') {
  console.error('--env must be HISTORICAL or SYNTHETIC (LIVE data is evaluated prospectively, never simulated).');
  process.exit(1);
}

const fmt = (v: number, p = 3) => v.toFixed(p);

function print(s: SimulationSummary): void {
  const line = '='.repeat(64);
  console.log(`\n${line}\nNEXORA LEARNING SIMULATION  [${s.dataEnvironment}]\n${line}`);
  console.log(s.evidenceNote);
  console.log(`\nMatches processed: ${s.matchesProcessed} (${s.matchesForecast} forecast; the rest had too little prior information)`);
  if (s.window) console.log(`Window: ${s.window.from.slice(0, 10)} → ${s.window.to.slice(0, 10)} across ${s.periods} monthly periods`);
  console.log(`Forecasts evaluated: ${s.forecastsEvaluated}`);
  console.log(`\nInitial model: ${s.initialModel}\nFinal model:   ${s.finalModel}`);

  console.log('\nChanges made:');
  if (s.promoted.length === 0) console.log('  - none (no proposal passed validation)');
  for (const p of s.promoted) {
    console.log(`  - ${p.version} (from ${p.parent}, after ${p.createdAfter}, trained on ${p.trainingSamples}, validated on ${p.holdoutSamples} unseen matches)`);
    for (const c of p.changes) console.log(`      ${c.feature}: ${fmt(c.from)} → ${fmt(c.to)}`);
    console.log(`      Reason: ${p.reason}`);
  }
  console.log('\nRejected changes:');
  if (s.rejected.length === 0) console.log('  - none');
  for (const p of s.rejected) {
    console.log(`  - ${p.version} (${p.changes.map((c) => `${c.feature} ${fmt(c.from)}→${fmt(c.to)}`).join(', ')})`);
    console.log(`      Reason: ${p.reason}`);
  }

  console.log(`\nPerformance before → after (${s.outOfSample.description})`);
  for (const [target, v] of Object.entries(s.outOfSample.perTarget)) {
    console.log(`  ${target.padEnd(16)} ${v.metric.padEnd(12)} ${fmt(v.before, 4)} → ${fmt(v.after, 4)}  (${v.change <= 0 ? '' : '+'}${fmt(v.change * 100, 2)}%, n=${v.n})`);
  }
  console.log('\nWalk-forward forecasts actually made during the simulation:');
  for (const [target, m] of Object.entries(s.walkForward) as Array<[string, Record<string, unknown>]>) {
    if (target === 'MATCH_RESULT') console.log(`  ${target.padEnd(16)} n=${m.n} accuracy=${m.accuracy} brier=${m.brier} logLoss=${m.logLoss} ECE=${m.expectedCalibrationError} F1(macro)=${m.f1Macro}`);
    else console.log(`  ${target.padEnd(16)} n=${m.n} MAE=${m.mae} RMSE=${m.rmse} bias=${m.bias} withinTolerance=${m.withinTolerance}`);
  }
  console.log(`\nSimulation run: ${s.simulationRunId}\n${line}`);
}

const prisma = createPrismaClient();
try {
  const simulator = new LearningSimulator(prisma, undefined, (l) => console.log(l));
  console.log(`Starting walk-forward simulation on ${env} data...`);
  const summary = await simulator.run({ dataEnvironment: env, competitionCode: values.competition, maxMatches: values.max ? Number(values.max) : undefined });
  print(summary);
  if (values['adopt-live'] && env === 'HISTORICAL' && summary.finalModel !== summary.initialModel) {
    const registry = new ModelRegistry(prisma);
    const adopted = await registry.adoptForLive(await registry.byVersion(summary.finalModel));
    console.log(`Adopted ${summary.finalModel} for LIVE forecasts as ${adopted.version}.`);
  }
} finally {
  await prisma.$disconnect();
}
