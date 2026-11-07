-- Finished results are historical fact: block edits to scores/status of FINISHED matches.
CREATE OR REPLACE FUNCTION nexora_protect_finished_match() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'FINISHED' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."homeScore" IS DISTINCT FROM OLD."homeScore"
    OR NEW."awayScore" IS DISTINCT FROM OLD."awayScore"
    OR NEW."matchDate" IS DISTINCT FROM OLD."matchDate"
    OR NEW."homeTeamId" IS DISTINCT FROM OLD."homeTeamId"
    OR NEW."awayTeamId" IS DISTINCT FROM OLD."awayTeamId"
  ) THEN
    RAISE EXCEPTION 'Match % is FINISHED; historical results are immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER match_protect_finished
  BEFORE UPDATE ON "Match"
  FOR EACH ROW EXECUTE FUNCTION nexora_protect_finished_match();

CREATE OR REPLACE FUNCTION nexora_block_delete_finished_match() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'FINISHED' THEN
    RAISE EXCEPTION 'Match % is FINISHED; historical results cannot be deleted', OLD."id";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER match_block_delete_finished
  BEFORE DELETE ON "Match"
  FOR EACH ROW EXECUTE FUNCTION nexora_block_delete_finished_match();

-- Model versions are never silently overwritten: weights are append-only per version.
CREATE OR REPLACE FUNCTION nexora_feature_weight_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'FeatureWeight rows are immutable; create a new ModelVersion instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feature_weight_immutable
  BEFORE UPDATE OR DELETE ON "FeatureWeight"
  FOR EACH ROW EXECUTE FUNCTION nexora_feature_weight_immutable();

-- Evaluations are recorded once; re-evaluation must not rewrite past outcomes.
CREATE OR REPLACE FUNCTION nexora_prediction_result_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PredictionResult rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prediction_result_immutable
  BEFORE UPDATE OR DELETE ON "PredictionResult"
  FOR EACH ROW EXECUTE FUNCTION nexora_prediction_result_immutable();
