-- CreateEnum
CREATE TYPE "BlackjackObservationSource" AS ENUM ('PLAYED', 'SIMULATED');

-- CreateEnum
CREATE TYPE "BlackjackModelKind" AS ENUM ('SOLVER', 'CALIBRATED');

-- CreateTable
CREATE TABLE "BlackjackModelVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "kind" "BlackjackModelKind" NOT NULL,
    "parentVersion" TEXT,
    "rules" JSONB NOT NULL,
    "priorStrength" DOUBLE PRECISION,
    "adjustments" JSONB,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "BlackjackModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackjackObservation" (
    "id" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "source" "BlackjackObservationSource" NOT NULL,
    "predictedAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rules" JSONB NOT NULL,
    "playerCards" INTEGER[],
    "dealerUpcard" INTEGER NOT NULL,
    "remaining" INTEGER[],
    "unseenCards" INTEGER NOT NULL,
    "dealerDistribution" DOUBLE PRECISION[],
    "actionEvs" JSONB NOT NULL,
    "bestAction" TEXT NOT NULL,
    "bestActionEv" DOUBLE PRECISION NOT NULL,
    "dealerFinalCards" INTEGER[],
    "dealerOutcome" INTEGER NOT NULL,
    "playerFinalCards" INTEGER[],
    "playerTotal" INTEGER NOT NULL,
    "settled" TEXT NOT NULL,
    "net" DOUBLE PRECISION NOT NULL,
    "cardsDrawnAfterForecast" INTEGER NOT NULL,

    CONSTRAINT "BlackjackObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackjackEvaluationRun" (
    "id" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observationCount" INTEGER NOT NULL,
    "trainingCount" INTEGER NOT NULL,
    "validationCount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "recalibrationJustified" BOOLEAN NOT NULL,
    "notes" TEXT NOT NULL,

    CONSTRAINT "BlackjackEvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlackjackModelVersion_version_key" ON "BlackjackModelVersion"("version");

-- CreateIndex
CREATE INDEX "BlackjackObservation_modelVersionId_predictedAt_idx" ON "BlackjackObservation"("modelVersionId", "predictedAt");

-- CreateIndex
CREATE INDEX "BlackjackObservation_source_idx" ON "BlackjackObservation"("source");

-- CreateIndex
CREATE INDEX "BlackjackObservation_dealerUpcard_idx" ON "BlackjackObservation"("dealerUpcard");

-- CreateIndex
CREATE INDEX "BlackjackEvaluationRun_modelVersionId_createdAt_idx" ON "BlackjackEvaluationRun"("modelVersionId", "createdAt");

-- AddForeignKey
ALTER TABLE "BlackjackObservation" ADD CONSTRAINT "BlackjackObservation_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "BlackjackModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackjackEvaluationRun" ADD CONSTRAINT "BlackjackEvaluationRun_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "BlackjackModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A forecast is only evidence if it cannot be revised once the result is known. Observations and
-- the evaluations computed from them are therefore append-only, as the football tables are.
CREATE OR REPLACE FUNCTION nexora_blackjack_observation_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BlackjackObservation rows are immutable; a forecast is not evidence if it can be revised after the outcome';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blackjack_observation_immutable
  BEFORE UPDATE OR DELETE ON "BlackjackObservation"
  FOR EACH ROW EXECUTE FUNCTION nexora_blackjack_observation_immutable();

CREATE OR REPLACE FUNCTION nexora_blackjack_evaluation_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BlackjackEvaluationRun rows are immutable; run a new evaluation instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blackjack_evaluation_immutable
  BEFORE UPDATE OR DELETE ON "BlackjackEvaluationRun"
  FOR EACH ROW EXECUTE FUNCTION nexora_blackjack_evaluation_immutable();

-- A model version may be activated or retired, but one that has observations behind it is never
-- removed: deleting it would cascade away the record of what it predicted.
CREATE OR REPLACE FUNCTION nexora_blackjack_model_version_keep() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BlackjackObservation" WHERE "modelVersionId" = OLD."id") THEN
    RAISE EXCEPTION 'Blackjack model version % has observations; retire it instead of deleting it', OLD."version";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blackjack_model_version_keep
  BEFORE DELETE ON "BlackjackModelVersion"
  FOR EACH ROW EXECUTE FUNCTION nexora_blackjack_model_version_keep();
