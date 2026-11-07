-- Live/current-season ingestion: append-only availability history, fixture revision log, reschedule-safe evaluation.

-- Availability becomes a history: each (player, match, reportedAt) report is kept, so what was known at any cutoff can be rebuilt.
DROP INDEX "PlayerAvailability_playerId_matchId_key";
CREATE UNIQUE INDEX "PlayerAvailability_playerId_matchId_reportedAt_key" ON "PlayerAvailability"("playerId", "matchId", "reportedAt");
CREATE INDEX "PlayerAvailability_matchId_reportedAt_idx" ON "PlayerAvailability"("matchId", "reportedAt");

CREATE TRIGGER player_availability_immutable BEFORE UPDATE OR DELETE ON "PlayerAvailability"
  FOR EACH ROW EXECUTE FUNCTION nexora_block_modification();

-- Every change an import makes to an existing fixture is recorded with before/after values.
CREATE TABLE "MatchRevision" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "importRunId" TEXT,
    "source" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MatchRevision_matchId_createdAt_idx" ON "MatchRevision"("matchId", "createdAt");
ALTER TABLE "MatchRevision" ADD CONSTRAINT "MatchRevision_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchRevision" ADD CONSTRAINT "MatchRevision_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "ImportRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER match_revision_immutable BEFORE UPDATE OR DELETE ON "MatchRevision"
  FOR EACH ROW EXECUTE FUNCTION nexora_block_modification();

-- Evaluation requires a finished match AND a forecast made no later than the (possibly rescheduled) kickoff.
CREATE OR REPLACE FUNCTION nexora_check_prediction_result() RETURNS trigger AS $$
DECLARE
  m_status "MatchStatus";
  m_date TIMESTAMP(3);
  p_asof TIMESTAMP(3);
BEGIN
  SELECT m."status", m."matchDate", p."asOf" INTO m_status, m_date, p_asof
    FROM "Prediction" p JOIN "Match" m ON m."id" = p."matchId" WHERE p."id" = NEW."predictionId";
  IF m_status IS DISTINCT FROM 'FINISHED' THEN
    RAISE EXCEPTION 'Prediction % cannot be evaluated: match is %', NEW."predictionId", m_status;
  END IF;
  IF p_asof > m_date THEN
    RAISE EXCEPTION 'Prediction % was made at % but the match kicked off at %; it cannot be evaluated', NEW."predictionId", p_asof, m_date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
