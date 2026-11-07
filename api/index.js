// Vercel serverless entry point.
//
// Plain JavaScript importing the compiled backend, deliberately. The alternative — TypeScript
// importing `../backend/src/app.js` — relies on the platform's bundler rewriting a `.js`
// specifier to a `.ts` file, which is a build-time gamble for no benefit. The backend is already
// compiled by `npm run build` during install, so this imports real files that exist.
//
// The app itself is untouched: this is the same Fastify instance the Docker image serves. Only the
// way it is started differs — instead of listening on a port, each invocation hands it one request.

import { buildApp } from '../backend/dist/app.js';
import { loadEnv } from '../backend/dist/config/env.js';
import { createPrismaClient } from '../backend/dist/config/prisma.js';

// Built once per process and reused. Rebuilding per request would re-register every plugin and
// open a new database pool each time.
let started = null;

function app() {
  started ??= (async () => {
    const instance = await buildApp(loadEnv(), createPrismaClient());
    // Fastify resolves its plugins before it can accept a raw request.
    await instance.ready();
    return instance;
  })();
  return started;
}

export default async function handler(req, res) {
  const instance = await app();
  instance.server.emit('request', req, res);
}
