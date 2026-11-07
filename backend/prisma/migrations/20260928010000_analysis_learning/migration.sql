-- Walk-forward simulation runs, and a hard guard: a model version may only forecast matches whose cutoff is after its training data.

CREATE TYPE "SimulationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

CREATE TABLE "SimulationRun" (
    "id" TEXT NOT NULL,
    "dataEnvironment" "DataEnvironment" NOT NULL,
    "status" "SimulationRunStatus" NOT NULL,
    "config" JSONB NOT NULL,
    "summary" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SimulationRun_dataEnvironment_startedAt_idx" ON "SimulationRun"("dataEnvironment", "startedAt");

ALTER TABLE "AnalysisRun" ADD COLUMN "simulationRunId" TEXT;
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_simulationRunId_fkey" FOREIGN KEY ("simulationRunId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AnalysisRun_simulationRunId_idx" ON "AnalysisRun"("simulationRunId");

ALTER TABLE "ModelVersion" ADD COLUMN "simulationRunId" TEXT;
ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_simulationRunId_fkey" FOREIGN KEY ("simulationRunId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ModelMetric" ADD COLUMN "simulationRunId" TEXT;
ALTER TABLE "ModelMetric" ADD CONSTRAINT "ModelMetric_simulationRunId_fkey" FOREIGN KEY ("simulationRunId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A version fitted on outcomes up to trainingWindowEnd must never forecast a match whose information cutoff is not later.
CREATE OR REPLACE FUNCTION nexora_check_model_training_window() RETURNS trigger AS $$
DECLARE
  trained_until TIMESTAMP(3);
  version_name TEXT;
BEGIN
  SELECT "trainingWindowEnd", "version" INTO trained_until, version_name FROM "ModelVersion" WHERE "id" = NEW."modelVersionId";
  IF trained_until IS NOT NULL AND trained_until >= NEW."asOf" THEN
    RAISE EXCEPTION '%: model % was trained on outcomes known up to %, so it cannot forecast a match with cutoff % (future-data leakage)',
      TG_TABLE_NAME, version_name, trained_until, NEW."asOf";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER analysis_run_training_window BEFORE INSERT ON "AnalysisRun"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_model_training_window();
CREATE TRIGGER prediction_training_window BEFORE INSERT ON "Prediction"
  FOR EACH ROW EXECUTE FUNCTION nexora_check_model_training_window();

-- Real data may inform real data (HISTORICAL -> LIVE adoption); SYNTHETIC stays sealed off in both directions.
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
  IF parent_env IS NOT NULL AND parent_env IS DISTINCT FROM NEW."dataEnvironment"
     AND NOT (parent_env = 'HISTORICAL' AND NEW."dataEnvironment" = 'LIVE') THEN
    RAISE EXCEPTION 'ModelVersion %: parent learned from % cannot produce a % version', NEW."version", parent_env, NEW."dataEnvironment";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
