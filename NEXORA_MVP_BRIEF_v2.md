# NEXORA MVP BRIEF — v2 (supersedes v1 where they differ)

## Candidate data sources
- openfootball/football.json — https://github.com/openfootball/football.json — public domain (CC0) fixtures/results, no API key, many seasons and leagues. Historical/backtesting source.
- openfootball/world — https://github.com/openfootball/world — extends openfootball to more regions, including African competitions.
- livescoreFootball — https://github.com/rezarahiminia/livescoreFootball — open-source REST API: fixtures, results, standings, summaries, events (strongest in England and Spain).
- football-api-examples — https://github.com/Abdulnasserh/football-api-examples — examples for a free-tier API: fixtures, results, timelines, injuries, suspensions.
- football-live-api — https://github.com/Ryzellx/football-live-api — match stats, xG, lineups, H2H, player ratings, standings.
- StatsBomb Open Data — https://github.com/statsbomb/open-data — event-level data, selective coverage.

Principle: no single source is responsible for everything. openfootball for history; everything else pluggable through IDataProvider.
PostgreSQL is Nexora's permanent source of truth, even when data originates from GitHub/API sources, so the full history can be replayed for every new model version.

---

Build **Nexora**, a football data intelligence and model-evaluation platform.

Nexora is NOT a betting, gambling, bookmaker, odds, or wagering application.

Its purpose is to:

- collect football data
- analyse historical and current match statistics
- compare teams and players
- identify statistical patterns
- generate transparent match insights
- evaluate its own previous forecasts against actual results
- improve its models through controlled, measurable learning
- provide researchers/developers with a dashboard showing how the models perform over time

TECH STACK

Backend:
- Node.js
- TypeScript
- Express (DECISION: Fastify is used instead — agreed with Rhulani)
- PostgreSQL
- Prisma
- Zod
- Vitest
- Pino logging

Frontend:
- React
- TypeScript
- Vite
- Tailwind CSS
- Recharts

Infrastructure:
- Docker
- Docker Compose

Architecture:
- frontend and backend completely separated
- REST API
- provider abstraction
- repository/service architecture
- strongly typed interfaces
- environment variables
- no secrets committed to Git
- deterministic tests
- no future-data leakage

# 1. CORE SYSTEM
The system has five major layers:

DATA PROVIDERS
↓
DATA NORMALIZATION
↓
FEATURE ENGINEERING
↓
ANALYSIS / MODELS
↓
EVALUATION + LEARNING

The system must never couple the analysis engine directly to an external football API.

Create IDataProvider with methods such as:
getCompetitions(), getTeams(), getPlayers(), getMatches(), getMatch(), getMatchStats(), getPlayerStats(), getPlayerAvailability(), getStandings()

Create a provider registry so different data sources can be plugged in. Example:
OpenFootballProvider, LiveFootballProvider, MockFootballProvider

The application should work with MockFootballProvider during development.

# 2. DATA SOURCES
Use open football datasets where possible.

The first historical provider should support the openfootball football.json data format.

Create an importer capable of downloading/importing historical competition data into PostgreSQL.

Do not depend on the external repository being available every time the application performs an analysis. Import the data into PostgreSQL and analyse the local database.

The provider architecture must allow another live/current-data source to be added later.

IMPORTANT: Never scrape or import data blindly. Normalize external data into Nexora's own schema.

Keep source, sourceId, lastUpdated on imported records where appropriate.

# 3. DATABASE
Use Prisma. Create:

Competition, Season, Team, Player, Match, MatchTeamStats, PlayerMatchStats, PlayerAvailability, HeadToHead, FeatureSnapshot, AnalysisRun, Prediction, PredictionResult, ModelVersion, FeatureWeight, LearningEvent, ModelMetric

# 4. MATCH DATA
Match: id, source, sourceId, competitionId, seasonId, homeTeamId, awayTeamId, matchDate, status, homeScore, awayScore, createdAt, updatedAt

MatchTeamStats: matchId, teamId, possession, shots, shotsOnTarget, corners, yellowCards, redCards, fouls, offsides, goals

All statistics must be nullable. Missing data must remain NULL. Never replace missing statistics with zero.

# 5. PLAYER DATA
Player: id, teamId, source, sourceId, name, position, createdAt, updatedAt

PlayerMatchStats: matchId, playerId, minutes, started, goals, assists, shots, shotsOnTarget, passes, tackles, interceptions, createdAt

PlayerAvailability: matchId, playerId, status, reason, expectedReturn, createdAt

Statuses: AVAILABLE, INJURED, SUSPENDED, DOUBTFUL, UNKNOWN

# 6. TEAM FORM
Build a FormAnalyzer.

For a selected match, calculate the previous five completed matches for each team.

Calculate: wins, draws, losses, goalsScored, goalsConceded, averageGoalsScored, averageGoalsConceded, averagePossession, averageShots, averageShotsOnTarget, averageCorners, averageYellowCards, averageRedCards

Also calculate homeForm and awayForm when enough data exists.

Never use matches occurring after the selected match.

# 7. PLAYER IMPACT
Build PlayerImpactAnalyzer.

Calculate an explainable impact score from available historical information.

Potential inputs: minutes, starts, goals, assists, shots, shotsOnTarget, defensive contribution, team performance when player participated, team performance when player did not participate

Do NOT claim causation from simple correlations. Use language such as "associated with" rather than "caused".

If insufficient data exists: impactConfidence = LOW. Do not invent an impact score.

# 8. AVAILABILITY
For every upcoming match, retrieve unavailable players.

Calculate: number of unavailable players, combined availability impact, attacking impact, defensive impact, confidence in availability assessment

Display the actual players responsible for the calculation. Example:

PLAYER AVAILABILITY
Player A — INJURED — Impact: HIGH
Player B — SUSPENDED — Impact: MEDIUM

Do not simply say "3 injuries = bad." The system must consider who is unavailable.

# 9. HEAD-TO-HEAD
Create H2HAnalyzer.

Retrieve previous meetings between the two teams. Default: last 5 completed meetings.

Calculate: results, goals, average goals, corners, yellow cards, red cards, shots, shots on target

Use time weighting. Recent meetings should generally carry more weight than very old meetings.

Do not allow H2H to dominate the complete analysis.

# 10. FEATURE ENGINEERING
Create FeatureEngineeringService. Generate a MatchFeatureVector. Example:

recentFormHome, recentFormAway,
goalsHomeAverage, goalsAwayAverage,
shotsHomeAverage, shotsAwayAverage,
shotsOnTargetHomeAverage, shotsOnTargetAwayAverage,
cornersHomeAverage, cornersAwayAverage,
possessionHomeAverage, possessionAwayAverage,
cardsHomeAverage, cardsAwayAverage,
availabilityHomeImpact, availabilityAwayImpact,
h2hGoalsAverage, h2hCornersAverage,
homeAdvantage

All features must include metadata describing: source, calculation window, sample size, timestamp

# 11. EXISTING MODELS
The project must support two existing models:
1. Mathematics Model
2. Data Analysis Model

Create interfaces IMathematicalModel and IDataAnalysisModel:
IMathematicalModel.calculate(features)
IDataAnalysisModel.analyze(features)

Create adapters: MathematicalModelAdapter, DataAnalysisModelAdapter

For now create mock implementations.

DO NOT replace these models with an LLM. The architecture must allow the real models to be connected later.

# 12. ANALYSIS ENGINE
Create MatchAnalysisEngine.

It receives: Match, MatchFeatureVector, MathematicalModelOutput, DataAnalysisModelOutput

and produces MatchAnalysis:

{
matchId,
modelVersion,
featureSnapshotId,
insights,
confidence,
supportingFactors,
conflictingFactors,
dataLimitations,
generatedAt
}

The system must explain the evidence behind every important insight.

# 13. PREDICTION / FORECAST RECORD
For model research purposes, store the model's forecast before the match occurs.

Prediction: id, matchId, modelVersionId, analysisRunId, target, predictedValue, confidence, createdAt

Examples of neutral targets: matchResult, goals, corners, cards, shots, shotsOnTarget

Do not store bookmaker odds or gambling recommendations.

# 14. RESULT EVALUATION
When a match finishes, retrieve actual results.

Create PredictionResult: predictionId, actualValue, absoluteError, squaredError, wasCorrect, evaluatedAt

Different target types require different evaluation metrics.
- Numerical targets: MAE, RMSE
- Classification: accuracy, precision, recall, F1 where appropriate
- Probabilistic outputs: Brier score, calibration

Do not use one universal metric for everything.

# 15. SELF-EVALUATION
Create EvaluationEngine. The engine should answer:
- What did the model predict?
- What actually happened?
- How large was the error?
- How confident was the model?
- Was the model appropriately calibrated?
- Which features were influential?
- Did the model consistently make this type of error?

The system must distinguish: random error, systematic error, data-quality error, model error, sample-size uncertainty

# 16. SELF-LEARNING
Create LearningEngine.

The learning engine must NOT rewrite source code. It can modify controlled model parameters.

FeatureWeight: feature, modelVersion, weight, previousWeight, newWeight, reason, confidence, createdAt

Example: recentForm 0.25 → 0.28
Reason: "Historical evaluation indicates improved performance over the defined validation window."

Every modification creates a LearningEvent.

# 17. MODEL VERSIONING
Every change creates a new model version (v1.0, v1.1, v1.2 ...).

Never silently modify an existing model version.

ModelVersion: id, version, parentVersionId, createdAt, status, trainingWindowStart, trainingWindowEnd, evaluationWindowStart, evaluationWindowEnd

Statuses: EXPERIMENTAL, ACTIVE, RETIRED

# 18. WALK-FORWARD VALIDATION
This is critical.

The system must simulate historical operation as if it were living in the past.

For every historical match: ONLY use data available before that match. Generate analysis. Store prediction. Then reveal actual result. Evaluate. Then allow learning. Then move to the next match.

Example:
Training: January → June — Evaluation: July
Training: January → July — Evaluation: August
Training: January → August — Evaluation: September

Never allow September data to influence a July prediction.

# 19. LEARNING SIMULATOR
Create `npm run simulate-learning`. The simulator should:

1. Load historical matches chronologically.
2. Select the next match.
3. Create a historical-information cutoff timestamp.
4. Generate features using only information before that timestamp.
5. Run both models.
6. Generate the analysis.
7. Store the prediction.
8. Reveal the actual result.
9. Evaluate the prediction.
10. Aggregate model performance.
11. Generate learning signals.
12. Propose a new model version.
13. Evaluate the proposed version.
14. Accept or reject it according to predefined validation rules.
15. Continue chronologically.

At the end print:

NEXORA LEARNING SIMULATION
Matches processed: N
Starting model: v1.0
Final model: v1.x
Initial performance: ...
Final performance: ...
Changes: ...
Rejected changes: ...
Reasons: ...

# 20. LEARNING GUARDRAILS
The learning engine must not change weights after a single bad match.

Require a minimum evaluation sample. Example: minimumEvaluationSamples = 50

Use rolling evaluation windows.

Never allow a new model version to replace the active version merely because of a small improvement. Require:
- minimum sample size
- statistically meaningful improvement where applicable
- no severe degradation in other metrics

If a new model performs worse: mark it RETIRED or EXPERIMENTAL and keep the previous active model.

# 21. MODEL PERFORMANCE
ModelMetric: modelVersion, metric, value, sampleSize, evaluationWindow, createdAt

Dashboard displays: Version, Matches evaluated, MAE, RMSE, Accuracy, Calibration, Sample size

Also show performance by: competition, target, home/away, sample size

Never hide the sample size.

# 22. DATA QUALITY
Create DataQualityService. Check: missing statistics, duplicate matches, duplicate players, invalid scores, future timestamps, team mismatches, missing player IDs, inconsistent team names

Every analysis should contain DATA QUALITY: Good or Warnings.
Example: "Possession unavailable for 2 of the last 5 matches."

# 23. API
GET /api/competitions
GET /api/teams
GET /api/teams/:id
GET /api/players/:id
GET /api/matches
GET /api/matches/:id
GET /api/matches/:id/stats
GET /api/matches/:id/form
GET /api/matches/:id/h2h
GET /api/matches/:id/availability
GET /api/matches/:id/analysis
POST /api/analysis/:matchId/run
GET /api/models
GET /api/models/:version
GET /api/models/:version/metrics
GET /api/learning-events
POST /api/model/evaluate
POST /api/model/learn
POST /api/import/football-data

# 24. FRONTEND
Dashboard called NEXORA. Tagline: "Understand the game through data."

Pages: Dashboard, Matches, Match Details, Teams, Players, Model Performance, Model Evolution, Data Quality

# 25. DASHBOARD
Display: Today's matches, Recent analyses, Model status, Active model version, Number of matches analysed, Data freshness, Model performance, Learning events

# 26. MATCH PAGE
HOME TEAM / AWAY TEAM / MATCH DATE

RECENT FORM
Team A: W W D L W
Team B: W D W W L

STATISTICAL COMPARISON (Metric | Team A | Team B): Goals, Shots, Shots on Target, Corners, Possession, Yellow Cards

PLAYER AVAILABILITY (Player | Status | Impact)

HEAD TO HEAD — previous meetings

NEXORA INSIGHT — Key factors, Supporting evidence, Conflicting evidence, Confidence, Data limitations

# 27. MODEL EVOLUTION PAGE
v1.0 ↓ v1.1 ↓ v1.2 ↓ v1.3

For each version: performance, sample size, evaluation period, feature changes, reason for changes.

Example — FEATURE WEIGHT CHANGE: Recent Form 0.25 → 0.28
Reason: "Improved validation performance across the evaluation window."

# 28. VISUALIZATION
Use Recharts for: team form, statistical comparison, model performance over time, prediction error over time, feature weight changes, confidence calibration

Do not create misleading charts. Always display sample size.

# 29. DATA IMPORTER
Create FootballDataImporter. Responsibilities: download source data, validate data, normalize team names, normalize dates, create/update teams, create/update players, create matches, create statistics where available, store source IDs

Never overwrite historical data blindly. Use upsert operations.

# 30. TEAM NAME NORMALIZATION
Different providers may use "Manchester United", "Man United", "Manchester Utd".

Create TeamIdentityResolver to map external names to one internal Team record.

Do not use fuzzy matching without safeguards. Provide manual aliases in the database.

# 31. CACHING
Cache external API requests. Never repeatedly download the same historical data.

Use PostgreSQL/local storage for imported historical data. The analysis engine should read from the internal database.

# 32. TESTING
Tests for: last-five form, home/away form, H2H, player impact, availability, feature engineering, model outputs, prediction evaluation, MAE, RMSE, accuracy, calibration, learning events, model versioning, rollback, data quality, team normalization, chronological validation

Create a specific test proving: a match cannot use information from a future match.

# 33. PROJECT STRUCTURE
backend/
  src/ config/ controllers/ routes/ services/ repositories/ analysis/ models/ providers/ learning/ evaluation/ features/ data/ types/ utils/ app.ts server.ts
  prisma/ schema.prisma seed.ts
  tests/
frontend/
  src/ components/ pages/ layouts/ hooks/ services/ types/ charts/ App.tsx main.tsx
docker-compose.yml
.env.example
README.md

# 34. SEED DATA
Deterministic seed data for development. At minimum: 8 teams, 100+ historical matches, players, player statistics, match statistics, availability records, H2H relationships.

The seed must be deterministic. Do not use Math.random() for data required by tests.

# 35. DEVELOPMENT COMMANDS
npm run dev
npm run build
npm run test
npm run lint
npm run db:migrate
npm run db:seed
npm run import:data
npm run simulate-learning
npm run evaluate:model

# 36. README
Explain: what Nexora is, architecture, database schema, how to install, start PostgreSQL, run migrations, seed, import data, start backend, start frontend, run the learning simulator, connect the two existing models, how model versioning works, how data leakage is prevented, how to add a new data provider.

# 37. FINAL MVP REQUIREMENT
The finished application must demonstrate this complete loop:

FOOTBALL DATA
↓
POSTGRESQL
↓
FEATURE ENGINEERING
↓
MATHEMATICS MODEL + DATA ANALYSIS MODEL
↓
NEXORA ANALYSIS
↓
ACTUAL MATCH RESULT
↓
ERROR EVALUATION
↓
LEARNING SIGNAL
↓
NEW MODEL VERSION
↓
VALIDATION
↓
ACTIVE MODEL

The MVP is successful only if this loop can be demonstrated end-to-end using historical data.

Do not build a fake "AI learns" button. The learning process must be measurable, versioned, reproducible and protected against future-data leakage.

Build the backend first, verify the learning simulator, then build the frontend.

Return the complete runnable project and exact setup instructions.
