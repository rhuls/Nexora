// One pass of the live sync: refresh the backbone, enrich the live seasons, then score any
// forecast whose result has since arrived.
//
// Extracted so the long-running worker and a scheduled HTTP trigger run exactly the same code.
// A host that cannot keep a process alive (a serverless platform) calls this on a timer instead
// of looping, and gets the identical behaviour.

import type { PrismaClient } from '@prisma/client';
import { createProviderRegistry, enrichmentProvider } from '../../config/providers.js';
import { EvaluationEngine } from '../../evaluation/evaluation.engine.js';
import { EnrichmentService, enrichableSeasons } from '../enrich/enrichment.service.js';
import { ImportService } from '../import/import.service.js';
import { LiveSyncService } from './live-sync.service.js';

export interface SyncPassResult {
  imports: Array<{ dataset: string; dataEnvironment: string; status: string; counts: unknown; warnings: unknown; importRunId: string | null; errorMessage: string | null }>;
  enrichment: Array<{ source: string; dataset: string; status: string; counts: unknown; requests: unknown; importRunId: string | null; errorMessage: string | null }>;
  enrichmentError: string | null;
  evaluated: unknown;
  durationMs: number;
}

export async function runSyncPass(prisma: PrismaClient): Promise<SyncPassResult> {
  const startedAt = Date.now();
  const registry = createProviderRegistry(prisma);
  // No high-frequency live polling: enrichment follows the backbone's cadence and relies on caching.
  const enrichment = new EnrichmentService(prisma, enrichmentProvider(registry));
  const enrichLive = async () => {
    const summaries = [];
    for (const season of enrichableSeasons().filter((s) => s.dataEnvironment === 'LIVE')) summaries.push(await enrichment.run(season));
    return summaries;
  };

  const result = await new LiveSyncService(new ImportService(prisma, registry), undefined, enrichLive).syncOnce();
  // New results may have arrived: compare any stored LIVE forecasts with what actually happened.
  const evaluated = await new EvaluationEngine(prisma).evaluatePending({ dataEnvironment: 'LIVE' });

  return {
    imports: result.imports.map((s) => ({
      dataset: s.dataset, dataEnvironment: s.dataEnvironment, status: s.status,
      counts: s.counts, warnings: s.warningCounts, importRunId: s.importRunId, errorMessage: s.errorMessage ?? null,
    })),
    enrichment: result.enrichment.map((e) => ({
      source: e.source, dataset: e.dataset, status: e.status, counts: e.counts,
      requests: { ...e.requests, planned: e.requests.planned.length }, importRunId: e.importRunId, errorMessage: e.errorMessage ?? null,
    })),
    enrichmentError: result.enrichmentError ?? null,
    evaluated,
    durationMs: Date.now() - startedAt,
  };
}
