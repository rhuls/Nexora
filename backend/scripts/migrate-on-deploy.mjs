// Applies pending migrations when the build has a database to apply them to.
//
// This runs from `npm run build`, which happens in two very different places. On the deployment
// host the database is configured, and the code being built expects its tables to exist, so the
// migrations must run first. When a container image is built there is no database — the image is
// not for any one environment — and migrating is neither possible nor meaningful.
//
// Deciding by whether DATABASE_URL is set keeps that difference explicit. What it must never do is
// swallow a real failure: a configured database that cannot be migrated fails the build, because
// shipping code whose tables are missing only moves the error somewhere harder to read.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;

if (!url) {
  console.log('[migrate] No DATABASE_URL: skipping migrations. Expected when building an image, which belongs to no environment.');
  process.exit(0);
}

// Host only, never the credentials, so a build log can be shared.
let target = 'an unparseable DATABASE_URL';
try {
  target = new URL(url).host;
} catch {
  // Left as the fallback above; prisma will report a malformed URL far better than this could.
}
console.log(`[migrate] Applying pending migrations to ${target}`);

// npm puts node_modules/.bin on PATH, but this should not depend on being started by npm.
const local = fileURLToPath(new URL('../node_modules/.bin/prisma', import.meta.url));
const binary = existsSync(local) ? local : 'prisma';
const result = spawnSync(binary, ['migrate', 'deploy'], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('[migrate] Migrations failed. Refusing to build code whose tables may be missing.');
  process.exit(result.status ?? 1);
}
console.log('[migrate] Database is up to date.');
