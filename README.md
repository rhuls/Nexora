# Nexora

Football intelligence and model-evaluation platform. Nexora explains matches with data and measures how
well its forecasts hold up against real results.

Nexora's core is a forecasting and evaluation pipeline. On top of it sits a **four-agent debate layer**
(Step 4) that compares a forecast with the betting market, attacks it, and sizes a stake when — and only
when — the evidence survives. That layer reads bookmaker odds, computes an edge against the de-vigged
market, and suggests a fractional-Kelly stake, so Nexora *does* now produce staking output. It is a
research instrument, not advice: every figure carries its sample size, thin samples are labelled
`NOT SIGNIFICANT`, and the default verdict is no pick. The forecasting core itself is unchanged and still
quotes no odds.

## Run it

Everything runs in Docker. Node is not required on the host.

```sh
cp .env.example .env            # set POSTGRES_PASSWORD and NEXORA_API_TOKEN (compose fails fast without either)
docker compose up -d --build    # db, backend (runs migrations on start), sync worker, frontend
```

Reading is open; every endpoint that writes state or runs heavy computation requires
`NEXORA_API_TOKEN`, and the API refuses to start in production without one. Generate it with
`openssl rand -base64 32`, and paste it into the **Token** control in the app header to use the
Run buttons. `GET /health` reports whether the guard is active. See
[DEPLOYMENT.md](DEPLOYMENT.md) for running this anywhere but your own machine.

| Service  | URL                              |
|----------|----------------------------------|
| Frontend | http://127.0.0.1:5173            |
| API      | http://127.0.0.1:4000 (`/docs` for Swagger, `/health`, `/metrics`) |

Load data and run the model tooling inside the backend container:

```sh
docker compose exec -T backend npm run import:data                     # real EPL history + current season
docker compose exec -T backend npm run simulate-learning -- --env HISTORICAL   # or SYNTHETIC; add --adopt-live
docker compose exec -T backend npm run evaluate:model -- --include-simulations
docker compose exec -T backend npm run compare:models   # read-only side-by-side backtest of both model sets

docker compose exec -T backend npm run debate -- --match=<id>        # four-agent debate for one fixture
docker compose exec -T backend npm run debate -- --upcoming --days=7 # the next LIVE fixtures
docker compose exec -T backend npm run debate:settle                 # score debate picks whose match has finished
docker compose exec -T backend npm run debate -- --report            # running accuracy, calibration, ROI
```

Tests:

```sh
docker compose exec -T backend npx vitest run                          # unit (no database, network or API key needed)
docker compose exec -T backend npm run --silent test:integration      # integration (rolls back; needs imported data; API mocked)
```

## Data providers

Nexora uses two real-data sources with distinct roles:

| Source | Role | Supplies |
|--------|------|----------|
| **OpenFootball** (no key) | **Fixture/result backbone.** Creates and owns every real match record. | Fixtures, kick-off times, results, half-time scores |
| **API-Football** (key) | **Enrichment only.** Never creates, deletes, re-dates or re-scores a match. | Team statistics, events, line-ups, player statistics, injuries and suspensions |

Both sit behind the provider contracts in `backend/src/providers/types.ts` (`IDataProvider`, and
`IEnrichmentProvider` for sources that add detail to existing fixtures). The rest of Nexora talks to those
interfaces through the registry in `backend/src/config/providers.ts`, never to a provider directly.

### API-Football configuration

Put the key in the local `.env` only (gitignored), then recreate the containers:

```sh
API_FOOTBALL_KEY=<your key>
API_FOOTBALL_DAILY_BUDGET=90   # optional; Nexora's own ceiling under the 100/day free plan
docker compose up -d backend sync
```

The key is read in one place (`src/config/api-football.ts`) and held in a `Secret` wrapper, so logs, JSON,
errors and `util.inspect` print `[redacted]`. It travels only in the `x-apisports-key` header: never in a URL,
a cache key, a log line, an API response or the database. Without a key, startup and OpenFootball work
normally and API-Football reports **not configured** (`GET /api/data/providers`, CLI exit code 2).

### Request budget, caching and coverage

- **Budget.** Every request is counted per UTC day in `ProviderUsage`, together with the provider's own
  `x-ratelimit-requests-remaining` figure, cache hits and misses, errors and 429s. Nexora stops before its
  daily budget is reached, or when the provider reports 5 or fewer requests left. It also spaces requests at
  least 6.5 s apart (the free plan allows 10 per minute).
- **Failure handling.** An HTTP 429, an exhausted quota or a rejected key (401/403) stops the run; nothing is
  retried in a loop. Requests not made are listed as *planned* in the run report.
- **Batching.** One `fixtures?ids=` request returns statistics, events, line-ups and player statistics for up
  to 20 fixtures. A full season is therefore about 19 requests plus 1–2 for discovery.
- **Cache.** Responses are stored in `ExternalSourceCache`, keyed by endpoint plus sorted parameters, and
  batch results are stored per fixture. Error responses are never cached. Freshness rules:

  | Data | Kept for |
  |------|----------|
  | Coverage | 24 h |
  | Current-season fixture list | 6 h |
  | Closed-season fixture list | Permanently |
  | Finished-match details | Permanently, after a 72 h correction window in which they refresh every 6 h |
  | Injuries | 6 h |
  | Squads | 7 days |
- **Coverage first.** Before requesting anything for a league-season, Nexora reads API-Football's coverage
  flags. Datasets flagged unavailable are not requested. A plan refusal (for example, a season outside the
  free plan) is stored in `ProviderCoverage` and not retried for 7 days.
- **No high-frequency live polling.** Enrichment follows the sync worker's interval and relies on the cache.

### Sync behaviour

The `sync` worker runs OpenFootball first, then API-Football enrichment for the LIVE season. Enrichment is
isolated: if it fails, the OpenFootball results already stored are unaffected. Past seasons are enriched
only on request, through the CLI. For each league-season, enrichment:

1. Discovers the provider's fixtures.
2. Maps teams through curated `TeamAlias` spellings. The provider's team ID is bound on first use and must
   agree afterwards; names are never fuzzy-matched.
3. Matches each fixture to one existing match in the same season: same home and away team, kick-off within
   36 h. Existing links take precedence. Unmapped, ambiguous or rescheduled fixtures are reported, not merged.
4. Records every mapping in `ExternalMatchLink`: provider fixture ID, how it matched, kick-off delta, and the
   provider's status and score.
5. Imports post-match data only when both sources agree the match is finished with the same score. A
   disagreement is recorded as a conflict, and the canonical OpenFootball result is kept.
6. Writes an `ImportRun` with the provider, competition and season, request/cache counts, fixtures
   discovered/matched/unresolved, rows imported, skips, conflicts and errors.

### Provenance and missing data

- Every imported row carries `source` (`api-football`), `sourceId` (the fixture ID, or a deterministic event
  key) and `lastUpdated`. `GET /api/matches/:id/sources` shows the fixture mapping.
- **Missing is never zero.** A statistic the provider leaves `null` is stored as `null` and shown as
  `DATA UNAVAILABLE`. `"78%"` becomes `78`, and a real `0` stays `0`.
- **Card and null semantics (decision).** The official API-Football schema could not be consulted (its
  documentation site blocks automated access) and no real response has been inspected yet. So the null
  policy is *"null means unknown"* for every statistic (Case B), recorded as
  `nullPolicy: api-football-null-policy/1 (all UNKNOWN)` on each row. Three things make this reversible on
  evidence:
  - The provider's raw statistics are stored verbatim in `MatchTeamStats.additional.providerRaw`.
  - Card counts derived from the same fixture's event log are stored in `additional.derivedFromEvents`,
    beside `redCards` and never replacing it.
  - Each import reports `RED_CARDS_NULL_NO_DISMISSAL_EVENTS` (consistent with "null means zero") and
    `RED_CARDS_NULL_WITH_DISMISSAL_EVENTS` (proof that null is not zero there).

  Switching a statistic to "null means zero" is a one-entry, tested change to `STAT_NULL_MEANING` in
  `backend/src/providers/api-football/normalize.ts`. Make it only after real responses support it.
- **xG** is stored as `additional.expectedGoals` (no dedicated column, no feature yet).
- **Stored values are never wiped.** An incoming `null` never replaces a stored value. After the correction
  window, a changed value is reported as a conflict instead of overwriting.
- **Events** are append-only and idempotent. API-Football events have no ID, so the key is derived from
  fixture, minute, team, type, detail, players and occurrence number. Identical events in the same minute
  stay distinct.
- **Availability** reports are append-only. `Missing Fixture` becomes `INJURED` or `SUSPENDED` according to
  the reason; `Questionable` becomes `DOUBTFUL`; any other absence reason becomes `UNKNOWN`, with the
  provider's wording kept in `sourceStatus`. A player with no report has no row, so their availability is
  **UNKNOWN**, never assumed `AVAILABLE`.
- **No back-dating.** API-Football gives no publication time for injuries, so `reportedAt` is when Nexora
  fetched the report. Injury lists fetched after a match therefore never inform that match's forecast, and
  no historical injury record is manufactured.
- **Future-data protection is unchanged.** LIVE statistics and player statistics count for a cutoff only if
  Nexora held them, unchanged, before it. A statistic imported at 15:00 cannot inform a 12:00 forecast.
- **Assumption for backfilled past seasons.** Statistics imported later for HISTORICAL matches are treated as
  publicly known 3 hours after kick-off, the same moment as the result. A match's own statistics are never
  visible to its pre-kick-off snapshot.

### Step 3A isolation: enriched data does not change result forecasts yet

The 21 features only an enrichment provider can fill are listed in `ENRICHMENT_ONLY_FEATURES` in
`backend/src/models/adapters.ts`: shots, shots on target, corners, possession, cards, the four head-to-head
stat averages, goals per shot on target, and the six availability features.

- **What they can affect:** on real data they may feed only the corners, cards and shots forecasts. The model
  adapters hide them from home/draw/away and total-goals forecasts, in every model set. Synthetic data keeps
  its original behaviour.
- **Baseline check:** `npm run compare:models` still reproduces the pre-enrichment baseline exactly (51.6%,
  Brier 0.5943).
- **When that changes:** only in Step 3B, after strict walk-forward validation.
- **Known side effect:** the confidence score counts populated features, so it will rise as enrichment fills
  them, even though result forecasts do not change. This is flagged for a later design decision.

### Importing

```sh
# Current (LIVE) Premier League season, everything covered:
docker compose exec -T backend npm run import:api-football
# A past season, statistics and events only, within a date range:
docker compose exec -T backend npm run import:api-football -- --league=39 --season=2023 --env=HISTORICAL \
  --only=stats,events --from=2023-08-01 --to=2023-09-30
# Dry-run: lists fixtures and plans detail requests; writes nothing to the database:
docker compose exec -T backend npm run import:api-football -- --season=2026 --dry-run
# Fully offline dry-run from cache only (no network at all):
docker compose exec -T backend npm run import:api-football -- --season=2026 --dry-run --offline
```

**First run with a new key: verify on a tiny sample before any broad import.**

```sh
# 1. Coverage and fixture discovery only (about 2 requests); nothing written:
docker compose exec -T backend npm run import:api-football -- --season=2023 --dry-run
# 2. One completed past fixture, with provider values printed beside the normalised values (about 1 request):
docker compose exec -T backend npm run import:api-football -- --season=2023 --env=HISTORICAL --limit=1 --show-mapping
# 3. One current-season fixture plus upcoming fixtures and injuries:
docker compose exec -T backend npm run import:api-football -- --season=2026 --limit=1 --show-mapping
```

Check the mapping output, especially the `RED_CARDS_NULL_*` warnings, before removing `--limit`.

- **Scope.** Only league 39 (Premier League) and the seasons the backbone holds (2023–2026) are accepted.
  The command cannot import anything else.
- **Dry-run.** It makes at most the 1–3 discovery requests needed to list fixtures. It reports fixtures
  discovered, matched and unresolved; statistics available or cached; injuries and suspensions; the requests
  it would make; cache hits and misses; and conflicts.
- **Status endpoints.** `GET /api/data/providers` and `GET /api/data/freshness` show whether a key is
  configured, today's usage, coverage, the last run and link counts. They never expose the key.
- **Match endpoints.** `/api/matches/:id/stats`, `/events`, `/lineups`, `/availability/reports` and
  `/sources` expose the data with provenance.

## Architecture

```
openfootball (backbone) ─► import + live sync worker ─► PostgreSQL 16 (Prisma) ◄─ api-football (enrichment, cached, budgeted)
                                                              │
     knowledge cutoff ─► feature engineering (41 features) ─► models ─► forecast (stored, immutable)
                                                              │
                          actual result ─► evaluation ─► learning signal ─► candidate model version
                                                              │
                         Fastify 5 API ◄──────────────────────┘ ◄── React 19 frontend (nginx, /api proxy)
                                                              │
      debate layer (read-only): scout + copycat ─► skeptic ─► verdict ─► bookkeeper ─► debate pick
```

- `backend/src/providers` – source adapters (`IDataProvider`), registered in `src/config/providers.ts`.
- `backend/src/data` – import, live sync, team identity, knowledge cutoff, synthetic generator.
- `backend/src/analysis`, `src/features` – form, home/away, head-to-head, availability; feature vectors.
- `backend/src/models` – the two model slots and their validating adapters.
- `backend/src/evaluation`, `src/learning` – metrics, error analysis, guarded learning, model registry.
- `backend/src/debate` – the four agents, the debate engine, de-vig, derived markets and staking.
- `frontend/src` – pages: Dashboard, Matches, Match, Teams, Debate, Model Performance, Model Evolution, Data Quality.

## The four-agent debate (Step 4)

Four agents argue each fixture so that only well-supported positions survive. Every agent is a pure,
deterministic TypeScript function — the same inputs always produce the same claims, so a debate can be
replayed and backtested exactly like a model. There is no LLM in the loop and no network call.

| Agent | Job | Refuses to |
|-------|-----|------------|
| **SCOUT** | Gathers evidence: form and home/away splits, ratings, head-to-head, availability, rest days. Facts only, each with a source and a date. | State a number it cannot source, or call missing data zero. |
| **COPYCAT** | Converts bookmaker odds to margin-free probabilities (Shin, with a multiplicative fallback) for 1X2, over/under 2.5 and BTTS. | Substitute the model's own numbers when no price exists. |
| **SKEPTIC** | Attacks Scout, Copycat and the proposed pick with coded rules. Every objection names a specific weakness and the number behind it. | Say "uncertain" without a measurement. |
| **BOOKKEEPER** | Logs each pick, scores settled ones (Brier, log loss, calibration by bucket, hit rate, ROI at flat stake) and sizes a stake via fractional Kelly. | Suggest a stake on a thin history or an unpriced pick. |

**The debate cannot move a forecast.** It reads the pipeline and writes only `DebateRun`,
`DebateAgentClaim`, `DebatePick` and `DebatePickResult`. It creates no `FeatureSnapshot`, no
`AnalysisRun`, no `Prediction`, no `ModelVersion` and no `LearningEvent`, which an integration test
asserts by counting rows before and after a run. `npm run compare:models` is unchanged.

### How a verdict is reached

Round 1 Scout presents evidence; Copycat presents the baseline. Round 2 the Skeptic challenges both, and
Scout or Copycat must answer with data — an objection that is not rebutted **stands**, because silence is
not a rebuttal. Round 3 produces a probability per market with a one-line reason. Round 4 the Bookkeeper
checks it against how picks at that confidence have actually settled, and sizes or refuses a stake.

Severity decides the outcome, not rhetoric:

- a **VETO** forces `NO_PICK` and `LOW` confidence;
- each standing **CONCERN** downgrades the verdict one step, so a pick becomes a lean;
- a **NOTE** is recorded and nothing more.

That is what makes the Skeptic and the Bookkeeper override the Scout structurally rather than by
convention.

### What the Skeptic attacks

`SYNTHETIC_ENV` (veto — a verdict on generated data is not evidence) · `MISSING_FEATURES` (veto below 40%
coverage) · `EDGE_WITHIN_NOISE` (veto — an edge smaller than the model's own calibration error cannot be
told apart from miscalibration) · `MODEL_FAILED` · `SMALL_SAMPLE` · `THIN_H2H` · `STALE_AVAILABILITY` ·
`NO_AVAILABILITY_DATA` · `EARLY_SEASON_FALLBACK` (fewer than 100 known results, the documented ratings
warm-up) · `MODEL_DISAGREEMENT` · `DRAW_BLINDSPOT` (the documented weakness on draws) ·
`ENRICHMENT_CONFIDENCE_INFLATION` (the documented defect where confidence counts features the result
forecast is forbidden to use) · `NO_CALIBRATION_HISTORY` · `NO_MARKET_BASELINE` · `WIDE_MARKET`.

### Odds: the contract exists, no source is wired

`IOddsProvider` (`backend/src/providers/types.ts`), the `OddsSnapshot` table and the de-vig, edge and
Kelly maths are all implemented and unit-tested against fixture prices. **No live odds source is
connected**, because neither OpenFootball nor API-Football publishes prices.

Until one is, every debate runs without a baseline, and that has visible consequences by design:

- `market_baseline` and `edge_vs_market` are `null`;
- `suggested_stake_pct` is `null` — Kelly has no price to size against;
- the Skeptic raises `NO_MARKET_BASELINE` as a **CONCERN**, so a market can reach `LEAN` but never `PICK`.

To switch it on: implement `IOddsProvider`, return it from `createOddsProvider()` in
`backend/src/config/providers.ts`, and store its quotes as `OddsSnapshot` rows. Odds published after a
match's knowledge cutoff are ignored, exactly like every other input.

### Staking and returns

Stakes are **0.25 Kelly, capped at 2% of bankroll**, and are suppressed entirely unless a pick has a
recorded price, an edge of at least 0.02, and at least 30 settled picks in its confidence bucket. ROI is
reported at flat stakes over priced picks only; unpriced picks are counted and excluded rather than
treated as break-even, and fewer than 100 priced picks is reported as not a measurement of edge.

`GET /api/debate/bookkeeper` also reports **which agent has been right**: a standing objection is credited
when the verdict it attacked turned out wrong, and marked wrong when that verdict was right — an objection
that talked Nexora out of a correct call cost something.

### Markets

`MATCH_RESULT` is the ensemble the existing models already produce; it is never recomputed here.
`OVER_UNDER_25` and `BTTS` are derived read-only from the Dixon-Coles expectation in the feature vector,
over the same score grid the result model uses. They are not `PredictionTarget`s, are never written to
`Prediction`, and take no part in evaluation or learning. Where the Dixon-Coles expectation is null — early
in a dataset, before the ratings settle — both markets report unavailable instead of guessing, and a
fixture with no history at all yields no probability on any market rather than a dressed-up even split.

### Endpoints

`POST /api/debate/:matchId/run` · `GET /api/debate/:matchId` (`?full=true` for the transcript) ·
`GET /api/debate/runs` · `GET /api/debate/bookkeeper` · `POST /api/debate/settle` ·
`GET /api/debate/odds/:matchId`

## Data environments

Every competition, match and model version is tagged `SYNTHETIC`, `HISTORICAL` or `LIVE`, and the three
are never mixed:

- **SYNTHETIC** – generated development data. Results on it are not evidence of anything.
- **HISTORICAL** – finished real seasons, used for walk-forward backtests.
- **LIVE** – the current season. Its performance figures count only forecasts made before kickoff;
  backtests are excluded unless explicitly requested.

A model version is only usable in its own environment. A HISTORICAL version reaches LIVE only through an
explicit, audited adoption (`--adopt-live`), which creates a new LIVE version.

## Data-leakage protection

- Features are built from information published **before** the forecast's `asOf` time (the knowledge
  cutoff); results, statistics and availability reports after it are invisible.
- A database trigger rejects any forecast whose model's training window ends at or after the forecast time.
- Forecasts are immutable once stored; evaluation compares them with results recorded later.
- Backtests replay matches chronologically, and every proposed weight change is validated on later matches
  it was not trained on. A change is promoted only if it clears the minimum improvement guardrail.
- Missing statistics stay `DATA UNAVAILABLE`; they are never filled with zeros or estimates.

## Plugging in a model

Implement one of the interfaces in `backend/src/models/types.ts`:

- `IMathematicalModel.calculate(features, context)`
- `IDataAnalysisModel.analyze(features, context)`

Both must be pure functions of the feature vector and return a `ModelOutput` (validated by Zod). Then swap
the implementation in `createModelAdapters()` in `backend/src/models/adapters.ts`. The adapters validate
output and isolate failures, so a broken model degrades the forecast rather than crashing it.

## Adding a data provider

Implement `IDataProvider` from `backend/src/providers/types.ts`. A source that only adds detail to existing
fixtures also implements `IEnrichmentProvider`. Declare honest `ProviderCapabilities`: anything the source
does not supply is reported as unavailable, not invented. Providers must not import Prisma (an architecture
test enforces this); persistent caches live in `backend/src/data/fetch`. Register the provider in
`backend/src/config/providers.ts`. Credentials go in `.env` (gitignored), are read through a config module,
and are never logged.

## Model versioning

- Versions are append-only; a change always creates a new version with a parent, a reason and its metrics.
- Statuses: a proposed change starts as `EXPERIMENTAL`; promotion makes it `ACTIVE` and moves the previous
  active version to `RETIRED`; a rejected candidate is also `RETIRED`. Each step is a learning event
  (`VERSION_PROMOTED`, `VERSION_REJECTED`, `ROLLBACK`).
- Rollback re-activates an earlier version and records a learning event.
- The Model Evolution page shows lineage, weights per version and the full learning history.

## Current results (HISTORICAL, walk-forward, EPL Aug 2023 – May 2026)

`npm run compare:models` is read-only. It scores every model on the same 1,105 matches, using the same
point-in-time features (cutoff = kick-off, only results already public).

| Model | Accuracy | Brier (lower is better) | Log loss | Calibration error |
|-------|----------|-------------------------|----------|-------------------|
| **Ratings (default): Dixon-Coles + calibrated Elo** | **51.6%** | **0.594** | **0.997** | **0.014** |
| Legacy: Poisson blend + rating differential | 49.0% | 0.621 | 1.034 | 0.038 |
| Base rates known at kick-off | 42.9% | 0.652 | 1.077 | 0.016 |
| Always home | 43.2% | 1.137 | — | 0.379 |

- **How the ratings models work.** Dixon-Coles fits a time-weighted attack/defence rating per club and
  corrects Poisson's under-counting of 0-0 and 1-1. Elo is mapped to outcome rates observed between
  similarly rated sides. Both use every known result, so strength carries over between seasons. Their
  parameters are fixed literature values, not tuned on these matches.
- **Significance.** Paired Brier difference is −0.027 (95% CI −0.040 to −0.015); the ratings models are
  better in each of the three seasons.
- **Realistic ceiling.** Result accuracy is bounded by football's randomness, at roughly 55–60% for the
  Premier League. A figure near 99% would indicate leaked future information.

Known limitations:

- **Draws.** The model still rarely calls a draw, though about 25% of matches are draws. A draw rule tuned
  on 2023/24 did not improve accuracy on later seasons, so draws are expressed only through probabilities.
- **Early season.** The ratings need about 100 known results; before that (early 2023/24) the models fall
  back to the legacy logic.
- **Learning.** No learned weight change has passed the guardrails. The weights steer the legacy parts only:
  corners, cards, shots and the fallback.
- **No market baseline.** No odds source is wired, so the debate layer cannot measure an edge and never
  returns a `PICK`. See "Odds: the contract exists, no source is wired".
- **Missing statistics.** OpenFootball provides no shots, corners, cards, possession or injury data.
  API-Football supplies them once `API_FOOTBALL_KEY` is set; until then those features stay
  `DATA UNAVAILABLE`. The results above were measured without them.
