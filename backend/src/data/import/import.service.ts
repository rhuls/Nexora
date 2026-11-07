import type { PrismaClient } from '@prisma/client';
import type { ProviderRegistry } from '../../providers/registry.js';
import { findImportable } from './catalog.js';
import { FootballDataImporter, type ImportSummary } from './football-data.importer.js';

export class ImportService {
  private readonly importer: FootballDataImporter;

  constructor(
    private readonly db: PrismaClient,
    private readonly registry: ProviderRegistry,
    importer?: FootballDataImporter,
  ) {
    this.importer = importer ?? new FootballDataImporter(db);
  }

  // Seasons are imported oldest-first so each run only ever adds later history.
  async importSeasons(source: string, competitionSourceId: string, seasonSourceIds: readonly string[]): Promise<ImportSummary[]> {
    const datasets = [...new Set(seasonSourceIds)].sort().map((seasonSourceId) => {
      const dataset = findImportable(source, competitionSourceId, seasonSourceId);
      if (!dataset) throw new Error(`Dataset ${source} ${competitionSourceId} ${seasonSourceId} is not importable`);
      return dataset;
    });
    const provider = this.registry.get(source);
    const summaries: ImportSummary[] = [];
    for (const dataset of datasets) {
      summaries.push(await this.importer.import(provider, dataset));
    }
    return summaries;
  }

  listRuns(limit: number) {
    return this.db.importRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
  }
}
