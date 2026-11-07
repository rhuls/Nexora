import { parseArgs } from 'node:util';
import type { DataEnvironment } from '@prisma/client';
import { createPrismaClient } from '../config/prisma.js';
import { EvaluationEngine } from '../evaluation/evaluation.engine.js';

const { values } = parseArgs({ options: { env: { type: 'string' }, 'include-simulations': { type: 'boolean', default: false } } });
const env = values.env?.toUpperCase() as DataEnvironment | undefined;

const prisma = createPrismaClient();
try {
  const engine = new EvaluationEngine(prisma);
  const pending = await engine.evaluatePending({ dataEnvironment: env });
  console.log(`Evaluated ${pending.evaluated} forecast(s) against actual results; ${pending.notEvaluable} not evaluable (the source did not supply that statistic).`);
  const envs: DataEnvironment[] = env ? [env] : ['HISTORICAL', 'LIVE', 'SYNTHETIC'];
  for (const e of envs) {
    const perf = await engine.performance({ dataEnvironment: e, includeSimulations: values['include-simulations'] });
    console.log(`\n${e}${e === 'SYNTHETIC' ? ' (development data — not evidence of real performance)' : ''}: ${perf.matchesEvaluated} matches, ${perf.forecastsEvaluated} forecasts, versions ${perf.modelVersions.join(', ') || 'none'}`);
    for (const [t, m] of Object.entries(perf.byTarget) as Array<[string, Record<string, unknown>]>) {
      if (t === 'MATCH_RESULT') console.log(`  ${t.padEnd(16)} n=${m.n} accuracy ${m.accuracy} brier ${m.brier} ECE ${m.expectedCalibrationError}`);
      else console.log(`  ${t.padEnd(16)} n=${m.n} MAE ${m.mae} RMSE ${m.rmse} bias ${m.bias}`);
    }
    for (const a of perf.errorAnalysis) for (const f of a.findings) console.log(`  [${a.target}] ${f.category}: ${f.explanation}`);
  }
} finally {
  await prisma.$disconnect();
}
