import { parseArgs } from 'node:util';
import { createPrismaClient } from '../../config/prisma.js';
import { createProviderRegistry } from '../../config/providers.js';
import { IMPORTABLE_DATASETS } from './catalog.js';
import { ImportService } from './import.service.js';

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: 'openfootball' },
    competition: { type: 'string', default: 'en.1' },
    seasons: { type: 'string' },
  },
});

const source = values.source!;
const competition = values.competition!;
const seasons = values.seasons
  ? values.seasons.split(',').map((s) => s.trim()).filter(Boolean)
  : IMPORTABLE_DATASETS.filter((d) => d.source === source && d.competitionSourceId === competition).map((d) => d.seasonSourceId);

const prisma = createPrismaClient();
try {
  const summaries = await new ImportService(prisma, createProviderRegistry(prisma)).importSeasons(source, competition, seasons);
  for (const s of summaries) {
    console.log(`\n${s.source} ${s.dataset} [${s.dataEnvironment}] -> ${s.status} (run ${s.importRunId})`);
    if (s.counts) console.log(`  ${JSON.stringify(s.counts)}`);
    if (Object.keys(s.warningCounts).length > 0) console.log(`  warnings: ${JSON.stringify(s.warningCounts)}`);
    console.log(`  not supplied by source: ${s.unavailableFromSource.join(', ') || 'none'}`);
    if (s.errorMessage) console.log(`  error: ${s.errorMessage}`);
  }
  if (summaries.some((s) => s.status === 'FAILED')) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
