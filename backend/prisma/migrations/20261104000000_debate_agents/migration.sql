-- Step 4: four-agent debate layer. Purely additive: new enums and new tables only.
-- No existing table gains, loses or changes a column, so every stored forecast and metric is untouched.

CREATE TYPE "DebateAgent" AS ENUM ('SCOUT', 'COPYCAT', 'SKEPTIC', 'BOOKKEEPER');
CREATE TYPE "DebateMarket" AS ENUM ('MATCH_RESULT', 'OVER_UNDER_25', 'BTTS');
CREATE TYPE "DebateRecommendation" AS ENUM ('PICK', 'LEAN', 'NO_PICK');
CREATE TYPE "ObjectionSeverity" AS ENUM ('NOTE', 'CONCERN', 'VETO');
CREATE TYPE "DebateRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "ClaimStance" AS ENUM ('SUPPORTS', 'OPPOSES', 'NEUTRAL');

CREATE TABLE "OddsSnapshot" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "market" "DebateMarket" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "prices" JSONB NOT NULL,
    "overround" DOUBLE PRECISION NOT NULL,
    "implied" JSONB NOT NULL,
    "method" TEXT NOT NULL,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OddsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DebateRun" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "analysisRunId" TEXT,
    "dataEnvironment" "DataEnvironment" NOT NULL,
    "status" "DebateRunStatus" NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "transcript" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DebateRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DebateAgentClaim" (
    "id" TEXT NOT NULL,
    "debateRunId" TEXT NOT NULL,
    "agent" "DebateAgent" NOT NULL,
    "round" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "stance" "ClaimStance" NOT NULL,
    "severity" "ObjectionSeverity",
    "targetAgent" "DebateAgent",
    "market" "DebateMarket",
    "evidence" JSONB NOT NULL,
    "wasCorrect" BOOLEAN,
    "scoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebateAgentClaim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DebatePick" (
    "id" TEXT NOT NULL,
    "debateRunId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "market" "DebateMarket" NOT NULL,
    "probabilities" JSONB NOT NULL,
    "marketBaseline" JSONB,
    "edge" DOUBLE PRECISION,
    "confidence" "ConfidenceLevel" NOT NULL,
    "recommendation" "DebateRecommendation" NOT NULL,
    "stakePct" DOUBLE PRECISION,
    "stakeReason" TEXT NOT NULL,
    "oddsAtPick" JSONB,
    "oddsSnapshotId" TEXT,
    "reasoning" TEXT NOT NULL,
    "unresolvedObjections" JSONB NOT NULL,
    "kickoff" TIMESTAMP(3) NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebatePick_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DebatePickResult" (
    "id" TEXT NOT NULL,
    "debatePickId" TEXT NOT NULL,
    "actualLabel" TEXT NOT NULL,
    "probabilityOfActual" DOUBLE PRECISION NOT NULL,
    "brier" DOUBLE PRECISION NOT NULL,
    "logLoss" DOUBLE PRECISION NOT NULL,
    "wasCorrect" BOOLEAN NOT NULL,
    "profitUnits" DOUBLE PRECISION,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebatePickResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OddsSnapshot_matchId_source_bookmaker_market_capturedAt_key" ON "OddsSnapshot"("matchId", "source", "bookmaker", "market", "capturedAt");
CREATE INDEX "OddsSnapshot_matchId_market_capturedAt_idx" ON "OddsSnapshot"("matchId", "market", "capturedAt");

CREATE INDEX "DebateRun_matchId_startedAt_idx" ON "DebateRun"("matchId", "startedAt");
CREATE INDEX "DebateRun_dataEnvironment_startedAt_idx" ON "DebateRun"("dataEnvironment", "startedAt");

CREATE INDEX "DebateAgentClaim_debateRunId_round_idx" ON "DebateAgentClaim"("debateRunId", "round");
CREATE INDEX "DebateAgentClaim_agent_code_idx" ON "DebateAgentClaim"("agent", "code");

CREATE UNIQUE INDEX "DebatePick_debateRunId_market_key" ON "DebatePick"("debateRunId", "market");
CREATE INDEX "DebatePick_matchId_market_idx" ON "DebatePick"("matchId", "market");

CREATE UNIQUE INDEX "DebatePickResult_debatePickId_key" ON "DebatePickResult"("debatePickId");

ALTER TABLE "OddsSnapshot" ADD CONSTRAINT "OddsSnapshot_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DebateRun" ADD CONSTRAINT "DebateRun_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DebateRun" ADD CONSTRAINT "DebateRun_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DebateAgentClaim" ADD CONSTRAINT "DebateAgentClaim_debateRunId_fkey" FOREIGN KEY ("debateRunId") REFERENCES "DebateRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DebatePick" ADD CONSTRAINT "DebatePick_debateRunId_fkey" FOREIGN KEY ("debateRunId") REFERENCES "DebateRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebatePick" ADD CONSTRAINT "DebatePick_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DebatePickResult" ADD CONSTRAINT "DebatePickResult_debatePickId_fkey" FOREIGN KEY ("debatePickId") REFERENCES "DebatePick"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A debate pick must not claim to know more than its own cutoff allows. The backtest cutoff IS kickoff
-- (informationCutoff returns matchDate) and everything inside it is filtered with a strict "<", so a pick
-- may sit at kickoff but never after it.
ALTER TABLE "DebatePick" ADD CONSTRAINT "DebatePick_asOf_not_after_kickoff" CHECK ("asOf" <= "kickoff");
