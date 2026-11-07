import type { ConfidenceLevel, Prisma, PrismaClient } from '@prisma/client';
import { MatchAnalysisEngine, runModels, type MatchAnalysis } from '../analysis/engine.js';
import { FeatureEngineeringService, FEATURE_NAMES, type MatchFeatureVector } from '../features/feature-engineering.service.js';
import { ModelRegistry } from '../learning/model-registry.js';
import { createModelAdapters, type ModelAdapters } from '../models/adapters.js';
import { NotFoundError } from '../utils/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RunOptions {
  modelVersionId?: string;
  simulationRunId?: string | null;
}

export interface RunResult {
  analysisRunId: string;
  featureSnapshotId: string;
  mode: 'PROSPECTIVE' | 'BACKTEST';
  analysis: MatchAnalysis;
  vector: MatchFeatureVector;
  predictionIds: string[];
}

export class AnalysisService {
  private readonly features: FeatureEngineeringService;
  private readonly registry: ModelRegistry;
  private readonly engine = new MatchAnalysisEngine();

  constructor(
    private readonly db: Db,
    private readonly adapters: ModelAdapters = createModelAdapters(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.features = new FeatureEngineeringService(db);
    this.registry = new ModelRegistry(db);
  }

  // Upcoming matches are analysed with what is known now; played matches are backtested at their pre-kickoff cutoff.
  async run(matchId: string, options: RunOptions = {}): Promise<RunResult> {
    const match = await this.db.match.findUnique({ where: { id: matchId }, select: { id: true, status: true, matchDate: true, dataEnvironment: true } });
    if (!match) throw new NotFoundError('Match', matchId);
    const now = this.now();
    const prospective = match.status !== 'FINISHED' && match.matchDate.getTime() > now.getTime();
    const build = await this.features.build(matchId, prospective ? now : undefined);
    const asOf = build.pit.cutoff;

    const version = options.modelVersionId
      ? await this.registry.usableFrom(await this.db.modelVersion.findUniqueOrThrow({ where: { id: options.modelVersionId } }), asOf)
      : await this.registry.usableFor(match.dataEnvironment, asOf);
    const weights = await this.registry.weightsOf(version.id);

    const snapshot = await this.db.featureSnapshot.create({
      data: {
        matchId,
        dataEnvironment: match.dataEnvironment,
        asOf,
        latestInputAt: build.latestInputAt,
        featureSetVersion: build.vector.featureSetVersion,
        features: build.vector.features as unknown as Prisma.InputJsonValue,
        dataQuality: build.quality as unknown as Prisma.InputJsonValue,
      },
    });
    const run = await this.db.analysisRun.create({
      data: {
        matchId,
        modelVersionId: version.id,
        featureSnapshotId: snapshot.id,
        dataEnvironment: match.dataEnvironment,
        status: 'RUNNING',
        asOf,
        isSimulation: !prospective,
        simulationRunId: options.simulationRunId ?? null,
      },
    });

    try {
      const modelResults = await runModels(this.adapters, build.vector, weights, version.version);
      const analysis = this.engine.analyze(build, modelResults, version.version, snapshot.id, now);
      const featuresUsed = {
        featureSetVersion: build.vector.featureSetVersion,
        featureSnapshotId: snapshot.id,
        weights,
        qualityStatus: build.quality.status,
        values: Object.fromEntries(FEATURE_NAMES.map((n) => [n, build.vector.features[n].value])),
      } as unknown as Prisma.InputJsonValue;

      const predictionIds: string[] = [];
      for (const f of analysis.forecasts) {
        const p = await this.db.prediction.create({
          data: {
            matchId,
            modelVersionId: version.id,
            analysisRunId: run.id,
            dataEnvironment: match.dataEnvironment,
            target: f.target,
            predictedValue: f.predictedValue,
            predictedLabel: f.predictedLabel,
            probabilities: (f.probabilities ?? undefined) as Prisma.InputJsonValue | undefined,
            confidence: f.confidence.level as ConfidenceLevel,
            confidenceScore: f.confidence.score,
            featuresUsed,
            asOf,
          },
        });
        predictionIds.push(p.id);
      }
      await this.db.analysisRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', completedAt: this.now(), output: analysis as unknown as Prisma.InputJsonValue } });
      return { analysisRunId: run.id, featureSnapshotId: snapshot.id, mode: prospective ? 'PROSPECTIVE' : 'BACKTEST', analysis, vector: build.vector, predictionIds };
    } catch (error) {
      await this.db.analysisRun.update({ where: { id: run.id }, data: { status: 'FAILED', completedAt: this.now(), errorMessage: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }

  async latest(matchId: string) {
    if ((await this.db.match.count({ where: { id: matchId } })) === 0) throw new NotFoundError('Match', matchId);
    const run = await this.db.analysisRun.findFirst({
      where: { matchId, status: 'COMPLETED' },
      orderBy: [{ isSimulation: 'asc' }, { startedAt: 'desc' }],
      include: { modelVersion: { select: { version: true } }, predictions: { include: { result: true } } },
    });
    return run;
  }
}
