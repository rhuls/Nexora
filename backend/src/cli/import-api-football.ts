import { parseArgs } from 'node:util';
import { API_FOOTBALL_EPL_LEAGUE_ID } from '../config/api-football.js';
import { createPrismaClient } from '../config/prisma.js';
import { createApiFootballProvider } from '../config/providers.js';
import { ENRICHMENT_TYPES, EnrichmentService, type EnrichmentType, enrichableSeasons } from '../data/enrich/enrichment.service.js';

const USAGE = `Usage: npm run import:api-football -- [--league=39] [--season=2026] [--env=LIVE|HISTORICAL]
       [--from=YYYY-MM-DD --to=YYYY-MM-DD] [--only=stats,events,lineups,players,injuries] [--limit=N] [--max-squads=N] [--show-mapping]
       [--dry-run [--offline]]`;

const { values } = parseArgs({
  options: {
    league: { type: 'string', default: API_FOOTBALL_EPL_LEAGUE_ID },
    season: { type: 'string' },
    env: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    only: { type: 'string' },
    limit: { type: 'string' },
    'max-squads': { type: 'string' },
    'show-mapping': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(64);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const seasons = enrichableSeasons();
// Defaults to the current (LIVE) Premier League season; older seasons must be named explicitly.
const season = values.season ?? seasons.find((s) => s.dataEnvironment === 'LIVE')?.seasonSourceId;
if (!season) fail('No LIVE season is configured; pass --season');
if (!seasons.some((s) => s.competitionSourceId === values.league && s.seasonSourceId === season)) {
  fail(`League ${values.league} season ${season} is not enrichable. Allowed: ${seasons.map((s) => `${s.competitionSourceId}/${s.seasonSourceId}`).join(', ')}`);
}
const env = values.env?.toUpperCase();
if (env !== undefined && env !== 'LIVE' && env !== 'HISTORICAL') fail(`--env must be LIVE or HISTORICAL (SYNTHETIC is never enriched)`);
const isDate = (s: string | undefined) => s === undefined || /^\d{4}-\d{2}-\d{2}$/.test(s);
if (!isDate(values.from) || !isDate(values.to) || (values.from === undefined) !== (values.to === undefined)) fail('--from and --to must be given together as YYYY-MM-DD');
const types = values.only?.split(',').map((t) => t.trim()).filter(Boolean);
const invalid = types?.filter((t) => !(ENRICHMENT_TYPES as readonly string[]).includes(t));
if (invalid && invalid.length > 0) fail(`Unknown --only value(s): ${invalid.join(', ')}`);
if (values.offline && !values['dry-run']) fail('--offline is only meaningful with --dry-run');
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 0 || limit > 400)) fail('--limit must be an integer between 0 and 400');
const maxSquads = values['max-squads'] === undefined ? undefined : Number(values['max-squads']);
if (maxSquads !== undefined && (!Number.isInteger(maxSquads) || maxSquads < 0 || maxSquads > 200)) fail('--max-squads must be an integer between 0 and 200');

const prisma = createPrismaClient();
try {
  const dryRun = values['dry-run']!;
  const provider = createApiFootballProvider(prisma, { dryRun, network: dryRun ? (values.offline ? 'none' : 'discovery') : 'all' });
  const summary = await new EnrichmentService(prisma, provider).run(
    { competitionSourceId: values.league!, seasonSourceId: season, dataEnvironment: env as 'LIVE' | 'HISTORICAL' | undefined, from: values.from, to: values.to, types: types as EnrichmentType[] | undefined, maxDetails: limit, maxSquads },
    { dryRun },
  );

  console.log(`\n${summary.source} ${summary.dataset} [${summary.dataEnvironment ?? '-'}] -> ${summary.status}${summary.importRunId ? ` (run ${summary.importRunId})` : ''}`);
  if (summary.status === 'NOT_CONFIGURED') {
    console.log(`  ${summary.errorMessage}\n  Set API_FOOTBALL_KEY in .env (never commit it) and recreate the containers.`);
    process.exitCode = 2;
  } else {
    const r = summary.requests;
    console.log(`  requests: made ${r.made}, cache hits ${r.cacheHits}, cache misses ${r.cacheMisses}, errors ${r.errors}, rate-limited ${r.rateLimited}`);
    if (r.planned.length > 0) console.log(`  ${dryRun ? 'would request' : 'not requested (stopped)'}: ${r.planned.length}\n    ${r.planned.slice(0, 25).join('\n    ')}${r.planned.length > 25 ? `\n    … ${r.planned.length - 25} more` : ''}`);
    if (r.stoppedReason) console.log(`  stopped: ${r.stoppedReason}`);
    console.log(`  counts: ${JSON.stringify(summary.counts)}`);
    if (Object.keys(summary.unavailable).length > 0) console.log(`  unavailable: ${JSON.stringify(summary.unavailable)}`);
    if (summary.unresolvedTeams.length > 0) console.log(`  unresolved teams: ${summary.unresolvedTeams.map((t) => `${t.name} (${t.sourceTeamId ?? '-'}: ${t.reason})`).join(', ')}`);
    for (const u of summary.unresolvedFixtures.slice(0, 20)) console.log(`  unresolved fixture ${u.sourceId} ${u.home} v ${u.away} ${u.kickoff}: ${u.reason} — ${u.detail}`);
    if (summary.unresolvedFixtures.length > 20) console.log(`  … ${summary.unresolvedFixtures.length - 20} more unresolved fixtures`);
    for (const c of summary.conflicts) console.log(`  conflict fixture ${c.sourceId} ↔ match ${c.matchId}: ${JSON.stringify(c.detail)}`);
    if (values['show-mapping']) {
      for (const s of summary.samples) {
        console.log(`\n  MAPPING fixture ${s.sourceId} → match ${s.matchId ?? '-'}: ${s.fixture}`);
        console.log(`    events ${JSON.stringify(s.events)} · player rows ${s.players} · lineups ${s.lineups}`);
        for (const t of s.stats as Array<Record<string, unknown>>) console.log(`    ${t.team}\n      provider raw: ${JSON.stringify(t.raw)}\n      normalised:   ${JSON.stringify(t.normalized)}\n      additional:   ${JSON.stringify(t.additional)}\n      from events:  ${JSON.stringify(t.derivedFromEvents)}`);
      }
    }
    if (Object.keys(summary.warningCounts).length > 0) console.log(`  warnings: ${JSON.stringify(summary.warningCounts)}`);
    if (summary.errorMessage) console.log(`  error: ${summary.errorMessage}`);
    if (summary.status === 'FAILED') process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
