import type { EnrichmentSummary } from '../enrich/enrichment.service.js';
import type { ImportSummary } from '../import/football-data.importer.js';
import type { ImportService } from '../import/import.service.js';
import { IMPORTABLE_DATASETS, type ImportableDataset } from '../import/catalog.js';

export interface SyncResult {
  imports: ImportSummary[];
  enrichment: EnrichmentSummary[];
  // Set when enrichment crashed; the backbone imports above are unaffected.
  enrichmentError: string | null;
}

export type Enricher = () => Promise<EnrichmentSummary[]>;

// Refreshes current-season datasets only; closed HISTORICAL seasons are never re-synced automatically.
// The backbone (fixtures/results) always runs first; an enrichment failure can never block or undo it.
export class LiveSyncService {
  constructor(
    private readonly imports: ImportService,
    private readonly datasets: readonly ImportableDataset[] = IMPORTABLE_DATASETS.filter((d) => d.dataEnvironment === 'LIVE'),
    private readonly enrich: Enricher | null = null,
  ) {}

  async syncOnce(): Promise<SyncResult> {
    const imports: ImportSummary[] = [];
    for (const d of this.datasets) {
      imports.push(...(await this.imports.importSeasons(d.source, d.competitionSourceId, [d.seasonSourceId])));
    }
    if (!this.enrich) return { imports, enrichment: [], enrichmentError: null };
    try {
      return { imports, enrichment: await this.enrich(), enrichmentError: null };
    } catch (error) {
      return { imports, enrichment: [], enrichmentError: error instanceof Error ? error.message : String(error) };
    }
  }
}
