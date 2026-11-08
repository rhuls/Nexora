import { PrismaClient } from '@prisma/client';
import { generateDataset } from '../src/data/synthetic/generator.js';
import { COMPETITION, INITIAL_MODEL_VERSION, SEED_REFERENCE_DATE } from '../src/data/synthetic/reference.js';
import { ensureBaselineModel } from '../src/learning/baseline.js';

const prisma = new PrismaClient();
const CHUNK = 1000;
const SOURCE = 'nexora-seed';
const ENVIRONMENT = 'SYNTHETIC' as const;

async function insertInChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await insert(rows.slice(i, i + CHUNK));
  }
}

async function resetDatabase(): Promise<void> {
  // TRUNCATE bypasses the row-level immutability triggers, which is intended for a development reset only.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "LearningEvent", "PredictionResult", "Prediction", "AnalysisRun", "FeatureSnapshot", "ModelMetric",
      "FeatureWeight", "ModelVersion", "PlayerAvailability", "PlayerMatchStats", "MatchTeamStats",
      "Match", "HeadToHead", "Player", "TeamAlias", "Team", "Season", "Competition", "User"
    CASCADE
  `);
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');

  // The baseline model is reference data from the brief, not part of the synthetic dataset, and
  // every analysis needs it. It is created before the guard below so that a database holding real
  // imported fixtures — which skips the dataset — still ends up with one.
  await ensureBaselineModel(prisma, SEED_REFERENCE_DATE);

  const existingMatches = await prisma.match.count();
  if (existingMatches > 0 && !reset) {
    console.log(`Database already contains ${existingMatches} matches. Re-run with --reset to wipe and reseed.`);
    console.log(`Baseline model ${INITIAL_MODEL_VERSION.version} is present.`);
    return;
  }
  if (reset) await resetDatabase();

  const data = generateDataset();
  const provenance = { source: SOURCE, lastUpdated: SEED_REFERENCE_DATE };

  await prisma.competition.create({
    data: { id: COMPETITION.id, code: COMPETITION.code, name: COMPETITION.name, country: COMPETITION.country, dataEnvironment: ENVIRONMENT, sourceId: COMPETITION.id, ...provenance },
  });
  await prisma.season.createMany({ data: data.seasons.map((s) => ({ ...s, sourceId: s.id, ...provenance })) });
  await prisma.team.createMany({ data: data.teams.map((t) => ({ ...t, sourceId: t.id, ...provenance })) });
  await prisma.player.createMany({ data: data.players.map((p) => ({ ...p, sourceId: p.id, ...provenance })) });
  await prisma.headToHead.createMany({ data: data.headToHeads });
  await insertInChunks(data.matches, (chunk) =>
    prisma.match.createMany({ data: chunk.map((m) => ({ ...m, dataEnvironment: ENVIRONMENT, sourceId: m.id, ...provenance })) }),
  );
  await insertInChunks(data.matchStats, (chunk) => prisma.matchTeamStats.createMany({ data: chunk.map((s) => ({ ...s, ...provenance })) }));
  await insertInChunks(data.playerMatchStats, (chunk) => prisma.playerMatchStats.createMany({ data: chunk.map((p) => ({ ...p, ...provenance })) }));
  await insertInChunks(data.availability, (chunk) => prisma.playerAvailability.createMany({ data: chunk.map((a) => ({ ...a, source: SOURCE })) }));

  // A --reset wipes the baseline along with everything else, so put it back.
  await ensureBaselineModel(prisma, SEED_REFERENCE_DATE);

  const finished = data.matches.filter((m) => m.status === 'FINISHED').length;
  const unavailable = data.availability.filter((a) => a.status !== 'AVAILABLE').length;
  console.log('Nexora seed complete (dataEnvironment = SYNTHETIC; not evidence of real-world model performance)');
  console.log(`  Teams:                 ${data.teams.length}`);
  console.log(`  Players:               ${data.players.length}`);
  console.log(`  Matches:               ${data.matches.length} (${finished} finished, ${data.matches.length - finished} scheduled)`);
  console.log(`  Team match stats:      ${data.matchStats.length}`);
  console.log(`  Player match stats:    ${data.playerMatchStats.length}`);
  console.log(`  Availability records:  ${data.availability.length} (${unavailable} not available)`);
  console.log(`  Model version:         ${INITIAL_MODEL_VERSION.version} (ACTIVE)`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
