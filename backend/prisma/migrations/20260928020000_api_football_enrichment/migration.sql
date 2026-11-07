-- Step 3: API-Football enrichment. Purely additive: new nullable columns, new tables, no data removed or relabelled.

CREATE TYPE "MatchEventType" AS ENUM ('GOAL', 'OWN_GOAL', 'PENALTY_GOAL', 'MISSED_PENALTY', 'YELLOW_CARD', 'SECOND_YELLOW', 'RED_CARD', 'SUBSTITUTION', 'VAR', 'OTHER');

ALTER TABLE "MatchTeamStats" ADD COLUMN "blockedShots" INTEGER,
ADD COLUMN "goalkeeperSaves" INTEGER,
ADD COLUMN "passAccuracy" DOUBLE PRECISION,
ADD COLUMN "passes" INTEGER,
ADD COLUMN "passesAccurate" INTEGER,
ADD COLUMN "shotsOffTarget" INTEGER,
ADD COLUMN "sourceId" TEXT;

-- Existing rows were last changed when created, so createdAt is their true lastUpdated.
ALTER TABLE "PlayerMatchStats" ADD COLUMN "fouls" INTEGER,
ADD COLUMN "lastUpdated" TIMESTAMP(3),
ADD COLUMN "rating" DOUBLE PRECISION,
ADD COLUMN "sourceId" TEXT;
UPDATE "PlayerMatchStats" SET "lastUpdated" = "createdAt" WHERE "lastUpdated" IS NULL;
ALTER TABLE "PlayerMatchStats" ALTER COLUMN "lastUpdated" SET NOT NULL;

ALTER TABLE "TeamAlias" ADD COLUMN "sourceTeamId" TEXT;

ALTER TABLE "PlayerAvailability" ADD COLUMN "sourceId" TEXT,
ADD COLUMN "sourceStatus" TEXT;

CREATE TABLE "ExternalMatchLink" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "matchedBy" TEXT NOT NULL,
    "kickoffDeltaMinutes" INTEGER NOT NULL,
    "sourceKickoff" TIMESTAMP(3) NOT NULL,
    "sourceStatus" TEXT NOT NULL,
    "sourceHomeScore" INTEGER,
    "sourceAwayScore" INTEGER,
    "conflict" JSONB,
    "detailsFetchedAt" TIMESTAMP(3),
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalMatchLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MatchEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "type" "MatchEventType" NOT NULL,
    "detail" TEXT,
    "minute" INTEGER NOT NULL,
    "extraMinute" INTEGER,
    "playerSourceId" TEXT,
    "playerName" TEXT,
    "relatedPlayerSourceId" TEXT,
    "relatedPlayerName" TEXT,
    "comments" TEXT,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MatchLineup" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "formation" TEXT,
    "coachName" TEXT,
    "startXI" JSONB NOT NULL,
    "substitutes" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchLineup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderCoverage" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "competitionSourceId" TEXT NOT NULL,
    "seasonSourceId" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "reason" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCoverage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderUsage" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "rateLimited" INTEGER NOT NULL DEFAULT 0,
    "cacheHits" INTEGER NOT NULL DEFAULT 0,
    "cacheMisses" INTEGER NOT NULL DEFAULT 0,
    "dailyLimit" INTEGER,
    "remaining" INTEGER,
    "lastRequestAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalMatchLink_source_sourceId_key" ON "ExternalMatchLink"("source", "sourceId");
CREATE UNIQUE INDEX "ExternalMatchLink_source_matchId_key" ON "ExternalMatchLink"("source", "matchId");
CREATE INDEX "MatchEvent_matchId_minute_idx" ON "MatchEvent"("matchId", "minute");
CREATE UNIQUE INDEX "MatchEvent_source_sourceId_key" ON "MatchEvent"("source", "sourceId");
CREATE UNIQUE INDEX "MatchLineup_matchId_teamId_source_key" ON "MatchLineup"("matchId", "teamId", "source");
CREATE UNIQUE INDEX "ProviderCoverage_source_competitionSourceId_seasonSourceId__key" ON "ProviderCoverage"("source", "competitionSourceId", "seasonSourceId", "dataset");
CREATE UNIQUE INDEX "ProviderUsage_source_day_key" ON "ProviderUsage"("source", "day");
CREATE UNIQUE INDEX "TeamAlias_source_sourceTeamId_key" ON "TeamAlias"("source", "sourceTeamId");

ALTER TABLE "ExternalMatchLink" ADD CONSTRAINT "ExternalMatchLink_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchLineup" ADD CONSTRAINT "MatchLineup_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Imported events are facts as reported; a provider correction arrives as a new row, never an edit.
CREATE TRIGGER match_event_immutable BEFORE UPDATE OR DELETE ON "MatchEvent"
  FOR EACH ROW EXECUTE FUNCTION nexora_block_modification();
