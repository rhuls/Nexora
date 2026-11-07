-- v2 schema: data provenance, data environments, feature snapshots, evaluation fields, importer support.
-- Every row that exists before this migration came from the development seed, so it is backfilled as SYNTHETIC / nexora-seed.

-- Guard: these tables change shape destructively and must be empty.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Prediction") OR EXISTS (SELECT 1 FROM "PredictionResult")
     OR EXISTS (SELECT 1 FROM "ModelMetric") OR EXISTS (SELECT 1 FROM "AnalysisRun")
     OR EXISTS (SELECT 1 FROM "LearningEvent") THEN
    RAISE EXCEPTION 'v2 migration requires empty Prediction, PredictionResult, ModelMetric, AnalysisRun and LearningEvent tables';
  END IF;
END $$;

-- Enums
CREATE TYPE "DataEnvironment" AS ENUM ('SYNTHETIC', 'HISTORICAL', 'LIVE');
CREATE TYPE "PredictionTarget" AS ENUM ('MATCH_RESULT', 'GOALS', 'CORNERS', 'CARDS', 'SHOTS', 'SHOTS_ON_TARGET');
CREATE TYPE "ImportRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
ALTER TYPE "AvailabilityStatus" ADD VALUE 'UNKNOWN';

-- Provenance on reference data
ALTER TABLE "Competition" ADD COLUMN "dataEnvironment" "DataEnvironment", ADD COLUMN "source" TEXT, ADD COLUMN "sourceId" TEXT, ADD COLUMN "lastUpdated" TIMESTAMP(3);
UPDATE "Competition" SET "dataEnvironment" = 'SYNTHETIC', "source" = 'nexora-seed', "sourceId" = "id", "lastUpdated" = "updatedAt";
ALTER TABLE "Competition" ALTER COLUMN "dataEnvironment" SET NOT NULL, ALTER COLUMN "source" SET NOT NULL, ALTER COLUMN "sourceId" SET NOT NULL, ALTER COLUMN "lastUpdated" SET NOT NULL;

ALTER TABLE "Season" ADD COLUMN "source" TEXT, ADD COLUMN "sourceId" TEXT, ADD COLUMN "lastUpdated" TIMESTAMP(3);
UPDATE "Season" SET "source" = 'nexora-seed', "sourceId" = "id", "lastUpdated" = "updatedAt";
ALTER TABLE "Season" ALTER COLUMN "source" SET NOT NULL, ALTER COLUMN "sourceId" SET NOT NULL, ALTER COLUMN "lastUpdated" SET NOT NULL;

ALTER TABLE "Team" ADD COLUMN "source" TEXT, ADD COLUMN "sourceId" TEXT, ADD COLUMN "lastUpdated" TIMESTAMP(3);
UPDATE "Team" SET "source" = 'nexora-seed', "sourceId" = "id", "lastUpdated" = "updatedAt";
ALTER TABLE "Team" ALTER COLUMN "source" SET NOT NULL, ALTER COLUMN "sourceId" SET NOT NULL, ALTER COLUMN "lastUpdated" SET NOT NULL;
-- Real teams can share names across countries; identity is (source, sourceId) plus curated aliases.
DROP INDEX "Team_name_key";
DROP INDEX "Team_shortName_key";

ALTER TABLE "Player" ADD COLUMN "source" TEXT, ADD COLUMN "sourceId" TEXT, ADD COLUMN "lastUpdated" TIMESTAMP(3);
UPDATE "Player" SET "source" = 'nexora-seed', "sourceId" = "id", "lastUpdated" = "updatedAt";
ALTER TABLE "Player" ALTER COLUMN "source" SET NOT NULL, ALTER COLUMN "sourceId" SET NOT NULL, ALTER COLUMN "lastUpdated" SET NOT NULL;

-- Match
ALTER TABLE "Match"
  ADD COLUMN "dataEnvironment" "DataEnvironment",
  ADD COLUMN "source" TEXT,
  ADD COLUMN "sourceId" TEXT,
  ADD COLUMN "lastUpdated" TIMESTAMP(3),
  ADD COLUMN "round" TEXT,
  ADD COLUMN "kickoffTimeKnown" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sourceMatchDate" TEXT,
  ADD COLUMN "homeHalfTimeScore" INTEGER,
  ADD COLUMN "awayHalfTimeScore" INTEGER;
UPDATE "Match" m SET "dataEnvironment" = c."dataEnvironment", "source" = 'nexora-seed', "sourceId" = m."id", "lastUpdated" = m."updatedAt"
  FROM "Competition" c WHERE c."id" = m."competitionId";
ALTER TABLE "Match" ALTER COLUMN "dataEnvironment" SET NOT NULL, ALTER COLUMN "source" SET NOT NULL, ALTER COLUMN "sourceId" SET NOT NULL, ALTER COLUMN "lastUpdated" SET NOT NULL;

-- MatchStats -> MatchTeamStats (renamed in place to keep data)
ALTER TABLE "MatchStats" RENAME TO "MatchTeamStats";
ALTER TABLE "MatchTeamStats" RENAME CONSTRAINT "MatchStats_pkey" TO "MatchTeamStats_pkey";
ALTER TABLE "MatchTeamStats" RENAME CONSTRAINT "MatchStats_matchId_fkey" TO "MatchTeamStats_matchId_fkey";
ALTER TABLE "MatchTeamStats" RENAME CONSTRAINT "MatchStats_teamId_fkey" TO "MatchTeamStats_teamId_fkey";
ALTER INDEX "MatchStats_matchId_teamId_key" RENAME TO "MatchTeamStats_matchId_teamId_key";
ALTER INDEX "MatchStats_teamId_idx" RENAME TO "MatchTeamStats_teamId_idx";
ALTER TABLE "MatchTeamStats" ADD COLUMN "source" TEXT, ADD COLUMN "lastUpdated" TIMESTAMP(3);
UPDATE "MatchTeamStats" SET "source" = 'nexora-seed', "lastUpdated" = "updatedAt";
ALTER TABLE "MatchTeamStats" ALTER COLUMN "source" SET NOT NULL, ALTER COLUMN "lastUpdated" SET NOT NULL;

-- PlayerMatchStats: keep minutes data, make unsupplied statistics nullable
ALTER TABLE "PlayerMatchStats" RENAME COLUMN "minutesPlayed" TO "minutes";
ALTER TABLE "PlayerMatchStats"
  ADD COLUMN "passes" INTEGER,
  ADD COLUMN "source" TEXT,
  ALTER COLUMN "goals" DROP NOT NULL,
  ALTER COLUMN "assists" DROP NOT NULL,
  ALTER COLUMN "shots" DROP NOT NULL,
  ALTER COLUMN "shotsOnTarget" DROP NOT NULL,
  ALTER COLUMN "yellowCards" DROP NOT NULL,
  ALTER COLUMN "redCards" DROP NOT NULL;
UPDATE "PlayerMatchStats" SET "source" = 'nexora-seed';
ALTER TABLE "PlayerMatchStats" ALTER COLUMN "source" SET NOT NULL;

ALTER TABLE "PlayerAvailability" ADD COLUMN "source" TEXT;
UPDATE "PlayerAvailability" SET "source" = 'nexora-seed';
ALTER TABLE "PlayerAvailability" ALTER COLUMN "source" SET NOT NULL;

-- Model versioning
ALTER TABLE "ModelVersion" RENAME COLUMN "evaluationStart" TO "evaluationWindowStart";
ALTER TABLE "ModelVersion" RENAME COLUMN "evaluationEnd" TO "evaluationWindowEnd";
ALTER TABLE "ModelVersion"
  ADD COLUMN "dataEnvironment" "DataEnvironment",
  ADD COLUMN "trainingWindowStart" TIMESTAMP(3),
  ADD COLUMN "trainingWindowEnd" TIMESTAMP(3);

-- Empty tables (checked above)
DROP INDEX "ModelMetric_modelVersionId_metric_idx";
ALTER TABLE "ModelMetric"
  DROP COLUMN "predictionType",
  DROP COLUMN "periodStart",
  DROP COLUMN "periodEnd",
  ADD COLUMN "dataEnvironment" "DataEnvironment" NOT NULL,
  ADD COLUMN "target" "PredictionTarget",
  ADD COLUMN "segment" TEXT,
  ADD COLUMN "windowStart" TIMESTAMP(3) NOT NULL,
  ADD COLUMN "windowEnd" TIMESTAMP(3) NOT NULL;

DROP INDEX "Prediction_analysisRunId_predictionType_key";
DROP INDEX "Prediction_modelVersionId_predictionType_idx";
ALTER TABLE "Prediction"
  DROP COLUMN "predictionType",
  ADD COLUMN "dataEnvironment" "DataEnvironment" NOT NULL,
  ADD COLUMN "target" "PredictionTarget" NOT NULL;
DROP TYPE "PredictionType";

ALTER TABLE "PredictionResult" ADD COLUMN "squaredError" DOUBLE PRECISION NOT NULL;

ALTER TABLE "AnalysisRun" ADD COLUMN "dataEnvironment" "DataEnvironment" NOT NULL, ADD COLUMN "featureSnapshotId" TEXT;

DROP INDEX "LearningEvent_createdAt_idx";
ALTER TABLE "LearningEvent" ADD COLUMN "dataEnvironment" "DataEnvironment" NOT NULL;

-- New tables
CREATE TABLE "TeamAlias" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamAlias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeatureSnapshot" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "dataEnvironment" "DataEnvironment" NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "latestInputAt" TIMESTAMP(3),
    "featureSetVersion" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "dataQuality" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalSourceCache" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "etag" TEXT,
    "lastModified" TEXT,
    "contentHash" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalSourceCache_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "dataEnvironment" "DataEnvironment" NOT NULL,
    "status" "ImportRunStatus" NOT NULL,
    "counts" JSONB,
    "warnings" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "Competition_source_sourceId_key" ON "Competition"("source", "sourceId");
CREATE UNIQUE INDEX "Season_source_sourceId_key" ON "Season"("source", "sourceId");
CREATE UNIQUE INDEX "Team_source_sourceId_key" ON "Team"("source", "sourceId");
CREATE INDEX "Team_competitionId_idx" ON "Team"("competitionId");
CREATE UNIQUE INDEX "Player_source_sourceId_key" ON "Player"("source", "sourceId");
CREATE UNIQUE INDEX "Match_source_sourceId_key" ON "Match"("source", "sourceId");
CREATE INDEX "Match_dataEnvironment_matchDate_idx" ON "Match"("dataEnvironment", "matchDate");
CREATE UNIQUE INDEX "TeamAlias_source_normalizedAlias_key" ON "TeamAlias"("source", "normalizedAlias");
CREATE INDEX "TeamAlias_teamId_idx" ON "TeamAlias"("teamId");
CREATE INDEX "FeatureSnapshot_matchId_asOf_idx" ON "FeatureSnapshot"("matchId", "asOf");
CREATE UNIQUE INDEX "ExternalSourceCache_url_key" ON "ExternalSourceCache"("url");
CREATE INDEX "ImportRun_source_startedAt_idx" ON "ImportRun"("source", "startedAt");
CREATE INDEX "ModelMetric_modelVersionId_dataEnvironment_metric_idx" ON "ModelMetric"("modelVersionId", "dataEnvironment", "metric");
CREATE INDEX "Prediction_modelVersionId_dataEnvironment_target_idx" ON "Prediction"("modelVersionId", "dataEnvironment", "target");
CREATE UNIQUE INDEX "Prediction_analysisRunId_target_key" ON "Prediction"("analysisRunId", "target");
CREATE INDEX "LearningEvent_dataEnvironment_createdAt_idx" ON "LearningEvent"("dataEnvironment", "createdAt");

-- Foreign keys
ALTER TABLE "TeamAlias" ADD CONSTRAINT "TeamAlias_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeatureSnapshot" ADD CONSTRAINT "FeatureSnapshot_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_featureSnapshotId_fkey" FOREIGN KEY ("featureSnapshotId") REFERENCES "FeatureSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===================== Integrity guards =====================

-- Finished matches: result, timing, identity, provenance and environment are frozen.
CREATE OR REPLACE FUNCTION nexora_protect_finished_match() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'FINISHED' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."homeScore" IS DISTINCT FROM OLD."homeScore"
    OR NEW."awayScore" IS DISTINCT FROM OLD."awayScore"
    OR NEW."homeHalfTimeScore" IS DISTINCT FROM OLD."homeHalfTimeScore"
    OR NEW."awayHalfTimeScore" IS DISTINCT FROM OLD."awayHalfTimeScore"
    OR NEW."matchDate" IS DISTINCT FROM OLD."matchDate"
    OR NEW."sourceMatchDate" IS DISTINCT FROM OLD."sourceMatchDate"
    OR NEW."homeTeamId" IS DISTINCT FROM OLD."homeTeamId"
    OR NEW."awayTeamId" IS DISTINCT FROM OLD."awayTeamId"
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId"
    OR NEW."dataEnvironment" IS DISTINCT FROM OLD."dataEnvironment"
  ) THEN
    RAISE EXCEPTION 'Match % is FINISHED; historical results are immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Chronology + environment guard for anything produced *about* a match.
CREATE OR REPLACE FUNCTION nexora_check_match_chronology() RETURNS trigger AS $$
DECLARE
  m_date TIMESTAMP(3);
  m_env "DataEnvironment";
BEGIN
  SELECT "matchDate", "dataEnvironment" INTO m_date, m_env FROM "Match" WHERE "id" = NEW."matchId";
  IF NEW."asOf" > m_date THEN
    RAISE EXCEPTION '% for match %: cutoff % is after kick-off %', TG_TABLE_NAME, NEW."matchId", NEW."asOf", m_date;
  END IF;
  IF NEW."dataEnvironment" IS DISTINCT FROM m_env THEN
    RAISE EXCEPTION '% for match %: dataEnvironment % does not match the match environment %', TG_TABLE_NAME, NEW."matchId", NEW."dataEnvironment", m_env;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nexora_check_feature_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW."latestInputAt" IS NOT NULL AND NEW."latestInputAt" >= NEW."asOf" THEN
    RAISE EXCEPTION 'FeatureSnapshot for match %: input dated % is not before cutoff % (future-data leakage)', NEW."matchId", NEW."latestInputAt", NEW."asOf";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nexora_block_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feature_snapshot_chronology BEFORE INSERT ON "FeatureSnapshot"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_match_chronology();
CREATE TRIGGER feature_snapshot_leakage BEFORE INSERT ON "FeatureSnapshot"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_feature_snapshot();
CREATE TRIGGER feature_snapshot_immutable BEFORE UPDATE OR DELETE ON "FeatureSnapshot"
  FOR EACH ROW EXECUTE FUNCTION nexora_block_modification();

CREATE TRIGGER analysis_run_chronology BEFORE INSERT OR UPDATE OF "asOf", "matchId", "dataEnvironment" ON "AnalysisRun"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_match_chronology();

CREATE TRIGGER prediction_chronology BEFORE INSERT ON "Prediction"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_match_chronology();
CREATE TRIGGER prediction_immutable BEFORE UPDATE OR DELETE ON "Prediction"
  FOR EACH ROW EXECUTE FUNCTION nexora_block_modification();

-- An outcome can only be recorded once the match has actually finished.
CREATE OR REPLACE FUNCTION nexora_check_prediction_result() RETURNS trigger AS $$
DECLARE
  m_status "MatchStatus";
BEGIN
  SELECT m."status" INTO m_status FROM "Prediction" p JOIN "Match" m ON m."id" = p."matchId" WHERE p."id" = NEW."predictionId";
  IF m_status IS DISTINCT FROM 'FINISHED' THEN
    RAISE EXCEPTION 'Prediction % cannot be evaluated: match is %', NEW."predictionId", m_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prediction_result_requires_finished BEFORE INSERT ON "PredictionResult"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_prediction_result();

-- Environment separation for models: a version learned from one environment never mixes with another.
CREATE OR REPLACE FUNCTION nexora_check_model_lineage() RETURNS trigger AS $$
DECLARE
  parent_env "DataEnvironment";
BEGIN
  IF NEW."parentVersionId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "dataEnvironment" INTO parent_env FROM "ModelVersion" WHERE "id" = NEW."parentVersionId";
  IF NEW."dataEnvironment" IS NULL THEN
    RAISE EXCEPTION 'ModelVersion %: only the baseline may have no dataEnvironment', NEW."version";
  END IF;
  IF parent_env IS NOT NULL AND parent_env IS DISTINCT FROM NEW."dataEnvironment" THEN
    RAISE EXCEPTION 'ModelVersion %: parent learned from % cannot produce a % version', NEW."version", parent_env, NEW."dataEnvironment";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER model_version_lineage BEFORE INSERT OR UPDATE OF "parentVersionId", "dataEnvironment" ON "ModelVersion"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_model_lineage();

CREATE OR REPLACE FUNCTION nexora_check_model_environment() RETURNS trigger AS $$
DECLARE
  model_env "DataEnvironment";
BEGIN
  SELECT "dataEnvironment" INTO model_env FROM "ModelVersion" WHERE "id" = NEW."modelVersionId";
  IF model_env IS NOT NULL AND model_env IS DISTINCT FROM NEW."dataEnvironment" THEN
    RAISE EXCEPTION '%: model version learned from % cannot be used or measured on % data', TG_TABLE_NAME, model_env, NEW."dataEnvironment";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER analysis_run_model_environment BEFORE INSERT ON "AnalysisRun"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_model_environment();
CREATE TRIGGER prediction_model_environment BEFORE INSERT ON "Prediction"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_model_environment();
CREATE TRIGGER model_metric_model_environment BEFORE INSERT ON "ModelMetric"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_model_environment();

-- At most one ACTIVE version per environment; the baseline (NULL environment) is its own bucket.
CREATE UNIQUE INDEX "ModelVersion_one_active_per_environment"
  ON "ModelVersion" ("dataEnvironment")
  WHERE "status" = 'ACTIVE' AND "dataEnvironment" IS NOT NULL;
CREATE UNIQUE INDEX "ModelVersion_one_active_baseline"
  ON "ModelVersion" ("status")
  WHERE "status" = 'ACTIVE' AND "dataEnvironment" IS NULL;
