import type { DataEnvironment, ModelVersion, Prisma, PrismaClient } from '@prisma/client';
import { resultKnownAt } from '../data/knowledge/cutoff.js';
import { actualNumeric, actualResultLabel } from '../evaluation/metrics.js';
import type { FeatureName, FeatureValue, MatchFeatureVector } from '../features/feature-engineering.service.js';
import { NUMERIC_TARGETS } from '../models/types.js';
import type { LearningSample } from './learning.engine.js';

type Db = PrismaClient | Prisma.TransactionClient;

const statSelect = { corners: true, yellowCards: true, redCards: true, shots: true, shotsOnTarget: true } as const;

export async function actualsFor(db: Db, matchIds: string[]) {
  const rows = await db.match.findMany({ where: { id: { in: matchIds }, status: 'FINISHED' }, select: { id: true, matchDate: true, kickoffTimeKnown: true, homeScore: true, awayScore: true, stats: { select: statSelect } } });
  return new Map(
    rows.map((m) => {
      const numeric: LearningSample['actual']['numeric'] = {};
      for (const t of NUMERIC_TARGETS) {
        const a = actualNumeric(t, m);
        if (a !== null) numeric[t] = a;
      }
      return [m.id, { resultKnownAt: resultKnownAt(m), actual: { result: m.homeScore === null || m.awayScore === null ? null : actualResultLabel(m.homeScore, m.awayScore), numeric } }];
    }),
  );
}

// Rebuilds learning samples from stored, immutable feature snapshots of evaluated forecasts.
export async function samplesFromForecasts(db: Db, where: Prisma.AnalysisRunWhereInput): Promise<LearningSample[]> {
  const runs = await db.analysisRun.findMany({
    where: { ...where, status: 'COMPLETED', featureSnapshotId: { not: null }, predictions: { some: { result: { isNot: null } } } },
    include: { featureSnapshot: true },
    orderBy: [{ asOf: 'asc' }, { id: 'asc' }],
  });
  const seen = new Set<string>();
  const unique = runs.filter((r) => (seen.has(r.matchId) ? false : (seen.add(r.matchId), true)));
  const actuals = await actualsFor(db, unique.map((r) => r.matchId));
  return unique.flatMap((run) => {
    const a = actuals.get(run.matchId);
    const snap = run.featureSnapshot!;
    if (!a) return [];
    const vector: MatchFeatureVector = {
      matchId: run.matchId,
      dataEnvironment: snap.dataEnvironment,
      asOf: snap.asOf.toISOString(),
      featureSetVersion: snap.featureSetVersion,
      features: snap.features as unknown as Record<FeatureName, FeatureValue>,
    };
    return [{ matchId: run.matchId, cutoff: snap.asOf, resultKnownAt: a.resultKnownAt, vector, actual: a.actual }];
  });
}

export function trainingWindow(samples: LearningSample[]): { start: Date; end: Date } {
  return {
    start: samples[0]!.cutoff,
    // The last moment any training outcome became known; forecasts must have a later cutoff.
    end: new Date(Math.max(...samples.map((s) => s.resultKnownAt.getTime()))),
  };
}

export const unseenBy = (version: Pick<ModelVersion, 'trainingWindowEnd'>, samples: LearningSample[]) =>
  samples.filter((s) => !version.trainingWindowEnd || s.cutoff.getTime() > version.trainingWindowEnd.getTime());

export type { DataEnvironment };
