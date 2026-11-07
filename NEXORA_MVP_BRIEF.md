Build the MVP of a sports intelligence platform called **Nexora**.

The platform must analyse football matches using historical data, player availability, recent team performance, head-to-head statistics, and mathematical/data-analysis models. It must also evaluate its previous analyses against actual match results and use those results to improve its future analysis.

IMPORTANT:
This is a sports intelligence/research platform. Do NOT build the UI around betting, odds, bookmakers, gambling, or "tips". Use neutral terminology such as "analysis", "insight", "forecast", "confidence", "trend", and "model performance".

## TECH STACK
Backend:

- Node.js
- TypeScript
- Express.js
- PostgreSQL
- Prisma ORM
- Zod for validation
- REST API
- dotenv
- Jest/Vitest for testing
Frontend:

- React
- TypeScript
- Vite
- Tailwind CSS
Architecture:

- Separate frontend and backend
- Clean modular architecture
- Strong TypeScript typing
- Environment variables
- Error handling
- Logging
- No hardcoded secrets
- Docker-ready PostgreSQL configuration

---

# 1. MVP OBJECTIVE
A user selects a football match.

Nexora should analyse:

1. Player injuries
2. Suspended players
3. Red/yellow-card situations
4. Importance/impact of unavailable players
5. Each team's last 5 matches
6. Goals
7. Corners
8. Yellow cards
9. Red cards
10. Possession
11. Shots
12. Shots on target
13. Head-to-head matches
14. Home/away performance
15. Recent form
16. Other useful statistical features available in the database
It then produces a structured Match Insight.

Example:

MATCH INSIGHT

Manchester United vs Liverpool

Recent Form
Manchester United: 3W 1D 1L
Liverpool: 4W 0D 1L

Attacking Metrics
Shots
Shots on Target
Goals

Set Pieces
Corners

Discipline
Yellow Cards
Red Cards

Possession

Availability
Manchester United:

- 2 injured
- 1 suspended
Liverpool:

- 1 injured
Key Factors:

- Liverpool has produced more shots on target over the last five matches.
- Manchester United has averaged more corners at home.
- One unavailable player has historically had a significant impact on team performance.
The system must explain WHY an insight was produced rather than returning unexplained numbers.

---

# 2. DATABASE
Create the PostgreSQL schema using Prisma.

Tables/models should include at minimum:

User

Team

Player

Competition

Season

Match

MatchStats

PlayerMatchStats

PlayerAvailability

HeadToHead

Prediction

PredictionResult

ModelVersion

ModelMetric

LearningEvent

FeatureWeight

AnalysisRun

---

# 3. TEAM
Team:

- id
- name
- shortName
- country
- competitionId
- createdAt
- updatedAt
Player:

- id
- teamId
- name
- position
- createdAt
- updatedAt

---

# 4. MATCH
Match:

- id
- competitionId
- seasonId
- homeTeamId
- awayTeamId
- matchDate
- status
- homeScore
- awayScore
- createdAt
- updatedAt
Status:

SCHEDULED
LIVE
FINISHED
POSTPONED
CANCELLED

---

# 5. MATCH STATISTICS
Store:

- possession
- shots
- shotsOnTarget
- corners
- yellowCards
- redCards
- fouls
- offsides
- goals
The schema must allow statistics to be added later without redesigning the whole application.

---

# 6. PLAYER AVAILABILITY
Track:

- player
- match
- status
- reason
- expectedReturn
- importanceScore
Statuses:

AVAILABLE
INJURED
SUSPENDED
DOUBTFUL

Do not simply count injuries.

The system must calculate the potential impact of missing players.

---

# 7. PLAYER IMPACT
Create an initial player impact calculation.

Consider:

- minutes played
- starts
- goals
- assists
- shots
- shots on target
- defensive statistics where available
- team results when the player participates
- team results when the player does not participate
Create:

PlayerImpactScore

This should be explainable.

Example:

Player X:

Impact Score: 82/100

Factors:

- High minutes played
- Important attacking contribution
- Strong team performance when available
- Significant reduction in attacking output when absent
Do NOT claim causation when the data only shows correlation.

Use language such as:
"associated with"
rather than:
"caused".

---

# 8. LAST FIVE MATCH ANALYSIS
For every team calculate a rolling five-match window.

Calculate:

- wins
- draws
- losses
- goals scored
- goals conceded
- average possession
- average shots
- average shots on target
- average corners
- average yellow cards
- average red cards
Also calculate home and away splits where enough data exists.

The calculation must be dynamic.

Do not store a hardcoded "last five" result.

---

# 9. HEAD-TO-HEAD
Retrieve previous meetings between the two teams.

Calculate:

- results
- goals
- average goals
- corners
- cards
- shots
- shots on target
Allow configuration of the H2H sample size.

Default:

Last 5 meetings.

Do not allow old H2H data to dominate recent form.

Apply time weighting.

---

# 10. ANALYSIS ENGINE
Create:

src/analysis/

Inside it create modules for:

- form analyzer
- availability analyzer
- player impact analyzer
- attacking analyzer
- defensive analyzer
- corner analyzer
- discipline analyzer
- h2h analyzer
- homeAway analyzer
- feature-engineering module
- final analysis engine
The final engine combines the outputs.

Example:

MatchAnalysis:

{
matchId,
modelVersion,
resultTrend,
goalTrend,
cornerTrend,
cardTrend,
attackingComparison,
defensiveComparison,
availabilityComparison,
confidence,
keyFactors[],
warnings[],
generatedAt
}

---

# 11. FEATURE WEIGHTS
DO NOT hardcode every feature permanently.

Create FeatureWeight records.

Example:

FEATURE WEIGHT

recentForm 0.25
shotsOnTarget 0.20
goals 0.15
availability 0.15
homeAway 0.10
h2h 0.05
corners 0.05
discipline 0.05

These are only INITIAL values.

The learning system must eventually be able to adjust them based on historical performance.

---

# 12. YOUR TWO EXISTING MODELS
Design the architecture so that my existing mathematics model and data-analysis model can be plugged into the system.

Create interfaces:

IMathematicalModel

IDataAnalysisModel

Example:

interface IMathematicalModel {
calculate(features: MatchFeatures): ModelOutput;
}

interface IDataAnalysisModel {
analyze(features: MatchFeatures): ModelOutput;
}

Do not replace these models with a generic LLM.

The system must be able to call these models as independent components.

Create adapters so that the actual models can be connected later.

For the MVP, provide mock implementations if the actual models are not yet connected.

---

# 13. SELF-EVALUATION
This is a core feature.

Every time Nexora produces an analysis for a future match, store it in:

Prediction

Store:

- matchId
- modelVersion
- predictionType
- predictedValue
- confidence
- featuresUsed
- createdAt
When the match finishes, collect the actual result.

Create:

PredictionResult

Store:

- predictionId
- actualValue
- error
- absoluteError
- wasCorrect
- evaluatedAt
The system must automatically compare the analysis against reality.

---

# 14. ERROR ANALYSIS
Create:

ErrorAnalyzer

It should determine:

1. What did Nexora predict?
2. What actually happened?
3. How large was the error?
4. Which features influenced the analysis?
5. Which features were associated with the error?
6. Is this an isolated mistake or part of a pattern?
Example:

Prediction:

Expected corners = 10.2

Actual corners:

5

Error:

5.2

The system records:

Feature:
H2H corners

Historical weight:
0.15

Potential issue:
H2H may be overweighted for this competition/team combination.

Do not automatically conclude that the feature caused the error.

Record it as a learning signal.

---

# 15. SELF-LEARNING ENGINE
Create:

LearningEngine

The system must NOT rewrite its own source code.

Instead, it should learn by modifying controlled model parameters.

For example:

FeatureWeight

- feature
- weight
- modelVersion
- previousWeight
- updatedWeight
- reason
- confidence
- createdAt
The learning engine can propose:

Old:

H2H = 0.15

New:

H2H = 0.10

Reason:

"H2H feature has shown reduced predictive usefulness across the latest evaluation window."

Every change must be recorded in:

LearningEvent

---

# 16. MODEL VERSIONING
Every analysis must belong to a ModelVersion.

Example:

v1.0
v1.1
v1.2

Each version stores:

- version
- createdAt
- feature weights
- evaluation period
- performance metrics
- status
Statuses:

ACTIVE
EXPERIMENTAL
RETIRED

Never silently overwrite a model.

If a new version performs worse, the previous version must remain available.

---

# 17. WALK-FORWARD VALIDATION
IMPORTANT:

Do not allow future data to influence past analysis.

Use chronological evaluation.

Example:

Train/learn from:

January → June

Evaluate on:

July

Then:

January → July

Evaluate on:

August

Then:

January → August

Evaluate on:

September

This prevents data leakage.

---

# 18. MODEL PERFORMANCE
Track:

- accuracy
- mean absolute error
- calibration
- confidence vs actual outcome
- performance by feature
- performance by competition
- performance by analysis type
Dashboard:

MODEL PERFORMANCE

Current Model: v1.4

Matches Evaluated: 438

Result Analysis:
...

Goal Analysis:
...

Corner Analysis:
...

Card Analysis:
...

Do not create a single arbitrary "AI score".

Show the underlying metrics.

---

# 19. CONFIDENCE
Confidence must be based on measurable evidence.

Do NOT produce:

"99% guaranteed."

Instead use:

Confidence:

LOW
MEDIUM
HIGH

And show why.

Example:

HIGH

Because:

- large historical sample
- strong recent data consistency
- low variance
- multiple independent indicators agree
If the evidence conflicts, confidence should decrease.

---

# 20. EXPLANATIONS
Every insight should contain:

KEY FACTORS

1. Recent form
2. Statistical difference
3. Player availability
4. H2H
5. Home/away context
Also include:

DATA LIMITATIONS

Example:

"Only three recent H2H matches were available."

"Player impact data is incomplete."

"Corner statistics were unavailable for two matches."

The system must never fabricate missing information.

---

# 21. API
Create:

GET /api/matches

GET /api/matches/:id

GET /api/matches/:id/analysis

GET /api/matches/:id/form

GET /api/matches/:id/h2h

GET /api/matches/:id/availability

GET /api/teams/:id

GET /api/teams/:id/form

GET /api/teams/:id/players

GET /api/model/performance

GET /api/model/versions

GET /api/model/learning-events

POST /api/analysis/:matchId/run

POST /api/model/evaluate

POST /api/model/learn

---

# 22. FRONTEND
Create a clean modern dashboard.

Brand:

NEXORA

Tagline:

"Understand the game through data."

Main pages:

Dashboard
Matches
Match Details
Model Performance
Learning History

---

# 23. MATCH PAGE
Create:

NEXORA

Manchester United
vs
Liverpool

Date

---
RECENT FORM

Manchester United
3W 1D 1L

Liverpool
4W 0D 1L

---
STATISTICAL COMPARISON

Metric Team A Team B

Goals
Shots
Shots on Target
Corners
Possession
Yellow Cards

---
PLAYER AVAILABILITY

Team A

Player
Status
Impact

Team B

Player
Status
Impact

---
HEAD TO HEAD

Last 5 meetings

---
NEXORA INSIGHT

Show the system's structured findings.

---
CONFIDENCE

MEDIUM

Why:

- ...
- ...
- ...

---
DATA LIMITATIONS

- ...

---

# 24. LEARNING DASHBOARD
Create a page showing:

MODEL EVOLUTION

v1.0
↓
v1.1
↓
v1.2
↓
v1.3

For each version show:

- evaluation period
- number of matches
- metrics
- feature changes
- whether performance improved or declined
Create a "What changed?" section.

Example:

MODEL v1.3

Changed:

Recent Form
0.25 → 0.29

H2H
0.15 → 0.10

Reason:

"Recent form demonstrated stronger historical usefulness over the evaluation window."

---

# 25. DATA INGESTION
Create a clean abstraction:

IDataProvider

The application must NOT tightly couple the analysis engine to one external football API.

Example:

interface IDataProvider {
getMatches(): Promise<Match[]>;
getMatchStats(matchId: string): Promise;
getPlayers(teamId: string): Promise<Player[]>;
getPlayerAvailability(teamId: string): Promise<PlayerAvailability[]>;
}

Create a mock provider for development.

This allows a real football data provider to be connected later without rewriting the application.

---

# 26. MVP SEED DATA
Create realistic seed data for:

At least 8 teams.

At least 100 historical matches.

Player data.

Player availability.

Match statistics.

H2H relationships.

The application must work completely using the seed data.

Do NOT use fake random numbers during an actual analysis.

Use deterministic seeded data.

---

# 27. TESTING
Write tests for:

- last-five calculation
- form calculation
- player impact
- H2H calculation
- feature weighting
- confidence calculation
- prediction evaluation
- error calculation
- learning adjustment
- model version creation
- rollback
- chronological validation
Especially test against data leakage.

---

# 28. SAFETY / DATA INTEGRITY
Never:

- invent statistics
- invent injuries
- invent player availability
- invent match results
- claim certainty
- modify historical results
- overwrite model versions
- train on future information
If data is missing, explicitly return:

DATA UNAVAILABLE

rather than guessing.

---

# 29. PROJECT STRUCTURE
Use:

backend/
src/
analysis/
controllers/
services/
models/
repositories/
routes/
providers/
learning/
evaluation/
types/
utils/
config/
app.ts
server.ts

frontend/
src/
components/
pages/
services/
hooks/
types/
layouts/
App.tsx
main.tsx

prisma/
schema.prisma
seed.ts

tests/

docker-compose.yml

README.md

.env.example

---

# 30. BUILD ORDER
Build in this order:

PHASE 1
PostgreSQL + Prisma

PHASE 2
Teams, players, matches and statistics

PHASE 3
Last-five analysis

PHASE 4
Injury/suspension analysis

PHASE 5
Player impact

PHASE 6
H2H

PHASE 7
Mathematical model adapter

PHASE 8
Data-analysis model adapter

PHASE 9
Analysis engine

PHASE 10
Prediction storage

PHASE 11
Actual-result evaluation

PHASE 12
Error analysis

PHASE 13
Learning engine

PHASE 14
Model versioning

PHASE 15
Frontend dashboard

PHASE 16
Learning/performance dashboard

---

# 31. MOST IMPORTANT REQUIREMENT
The MVP must actually demonstrate the learning loop.

Create a development command:

npm run simulate-learning

It should:

1. Load historical matches.
2. Pretend Nexora is travelling through time.
3. Analyse each match using only information available before that match.
4. Store the analysis.
5. Reveal the actual result.
6. Calculate the error.
7. Aggregate errors.
8. Identify learning signals.
9. Generate a new model version.
10. Compare the new version against the previous version.
11. Keep the new version only if it passes predefined evaluation criteria.
12. Continue through the historical dataset.
At the end show:

NEXORA LEARNING SIMULATION

Matches processed: 100

Initial model: v1.0

Final model: v1.x

Changes made:

- ...
- ...
Performance before:
...

Performance after:
...

The system must be able to explain why each model change occurred.

---

# 32. DEVELOPMENT PRINCIPLE
Do not over-engineer the first version.

The MVP should prioritize:

DATA → ANALYSIS → RESULT → ERROR → LEARNING → NEW MODEL

over visual complexity.

Build the complete working backend first.

Then build the frontend.

Then connect the two existing mathematics/data-analysis models through adapters.

Every important calculation should be deterministic, testable, explainable, and reproducible.

Generate the complete project with:

- package.json
- tsconfig.json
- Prisma schema
- migrations
- seed script
- Express server
- routes
- controllers
- services
- analysis engine
- learning engine
- model versioning
- tests
- React frontend
- Tailwind setup
- Docker configuration
- .env.example
- README with exact setup commands
Do not give pseudocode where working TypeScript is possible.

Generate production-structured MVP code that can actually be run locally.
