# Deploying Nexora

Two supported shapes. The Docker Compose stack is unchanged and remains the way to run Nexora
locally; nothing below replaces it.

| | Local | Vercel + Neon |
|---|---|---|
| Frontend | nginx container | Vercel static build |
| API | Fastify container | one Vercel function (`api/index.ts`) |
| Database | `postgres:16-alpine` container | Neon |
| Live sync | `sync` container, hourly loop | Vercel Cron → `GET /api/sync/run` |
| Model tooling | `npm run compare:models` etc. | run locally or in CI against the same database |

Both run the same code. The serverless entry point builds the same Fastify app; the cron calls the
same sync pass the worker loops over.

## Before anything is public: the token

Every endpoint that writes state or runs heavy computation is guarded:

```
POST /analysis/:id/run     POST /model/evaluate    POST /import/football-data
POST /debate/:id/run       POST /model/learn       GET|POST /sync/run
POST /debate/settle        POST /model/rollback
```

Reading is open — the dashboard, match pages, the derived strategy chart, the solver. Blackjack
simulation is open up to 200,000 rounds and needs the token beyond that, because past that point it
is real compute on a metered host.

`NEXORA_API_TOKEN` must be at least 16 characters, and **the API refuses to start when
`NODE_ENV=production` without one**. That is deliberate: the alternative is a public
`POST /model/rollback`.

```sh
openssl rand -base64 32
```

Present it as `Authorization: Bearer <token>` or `x-nexora-token: <token>`. In the browser, the
**Token** control in the header stores it for that browser only; it is never part of the build.

`GET /health` reports `guardedRoutesProtected: true|false` so a deployment can be checked without
revealing anything.

## Vercel + Neon

### 1. Database

Create a Neon project and take the **pooled** connection string (it contains `-pooler`). A
serverless function is re-entered constantly, and an unpooled URL will exhaust Postgres.

### 2. Migrations

Vercel has no boot step, so migrations do not run on deploy. Apply them from a machine that has the
connection string:

```sh
cd backend
DATABASE_URL='postgres://…neon.tech/neondb?sslmode=require' npx prisma migrate deploy
```

Re-run this after any migration is added. It is idempotent.

### 3. Import the data

The backbone is public files, so this costs nothing and needs no API key:

```sh
cd backend && npm ci && npm run build
DATABASE_URL='…' node dist/data/import/cli.js --competition=en.1 --seasons=2026-27
# repeat for es.1, de.1, it.1, fr.1 — and any historical season you want backtests over
DATABASE_URL='…' npm run db:seed    # synthetic development league, optional
```

### 4. Environment variables

In the Vercel project, set:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon **pooled** string |
| `NEXORA_API_TOKEN` | the token from above |
| `CRON_SECRET` | **the same value as `NEXORA_API_TOKEN`** |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `API_FOOTBALL_KEY` | optional; omit and enrichment reports not-configured |
| `API_FOOTBALL_BATCH_FIXTURES` | `false` on a free API-Football plan |

`CRON_SECRET` matching the token is what lets the scheduled trigger through the existing guard:
Vercel sends `Authorization: Bearer $CRON_SECRET`, which is exactly what the guard expects. No
separate code path, and no second secret to rotate.

`CORS_ORIGIN` is not needed. The frontend calls `/api/...` on its own origin and `vercel.json`
rewrites it to the function, so there is no cross-origin request to allow.

### 5. Deploy

`vercel.json` already carries the build, the rewrites, the function size and the hourly cron. Push
the repository and connect it; no further configuration.

## What does not run on Vercel

The model tooling is batch work, not request handling: `compare:models` takes about 105 seconds and
`simulate-learning` far longer. They are CLIs and should stay CLIs — run them locally or in CI
against the same `DATABASE_URL`. Nothing in the deployed app depends on them; they write model
versions the API then reads.

## Keeping the Docker stack

Unchanged, and still the easiest way to develop:

```sh
cp .env.example .env     # set POSTGRES_PASSWORD and NEXORA_API_TOKEN
docker compose up -d --build
```

The local stack also sets `NODE_ENV=production`, so it requires the token too. That is intentional:
local behaves exactly like the deployment, and a guarded route cannot pass locally and fail in
production.
