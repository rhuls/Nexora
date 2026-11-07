import type { DataEnvironment } from '@prisma/client';
import { OPENFOOTBALL_DATASETS, OPENFOOTBALL_SOURCE } from '../../providers/openfootball/datasets.js';

export interface ImportableDataset {
  source: string;
  competitionSourceId: string;
  seasonSourceId: string;
  dataEnvironment: DataEnvironment;
}

// The only datasets the API or CLI may import. Anything else is rejected before any network access.
export const IMPORTABLE_DATASETS: readonly ImportableDataset[] = OPENFOOTBALL_DATASETS.map((d) => ({
  source: OPENFOOTBALL_SOURCE,
  competitionSourceId: d.competitionSourceId,
  seasonSourceId: d.seasonSourceId,
  dataEnvironment: d.dataEnvironment,
}));

export function findImportable(source: string, competitionSourceId: string, seasonSourceId: string): ImportableDataset | undefined {
  return IMPORTABLE_DATASETS.find((d) => d.source === source && d.competitionSourceId === competitionSourceId && d.seasonSourceId === seasonSourceId);
}
