// Runs the four-agent debate from the command line and prints the per-fixture JSON.
//
//   npm run debate -- --match=<id>
//   npm run debate -- --upcoming --days=7 [--limit=10]
//   npm run debate -- --settle [--env=HISTORICAL]
//   npm run debate -- --report [--env=LIVE]

import { PrismaClient } from '@prisma/client';
import { createOddsProvider } from '../config/providers.js';
import { DebateService } from '../services/debate.service.js';
import { DebateSettlementService } from '../services/debate-settlement.service.js';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
};
const has = (name: string) => flag(name) !== undefined;

type Env = 'SYNTHETIC' | 'HISTORICAL' | 'LIVE';
const envArg = flag('env') as Env | undefined;

async function debateOne(matchId: string, oddsConfigured: boolean): Promise<void> {
  const { transcript } = await prisma.$transaction((tx) => new DebateService(tx, undefined, oddsConfigured).run(matchId), { timeout: 120_000 });
  const result = transcript.verdicts.find((v) => v.market === 'MATCH_RESULT');
  const ou = transcript.verdicts.find((v) => v.market === 'OVER_UNDER_25');
  const btts = transcript.verdicts.find((v) => v.market === 'BTTS');

  console.log(
    JSON.stringify(
      {
        fixture: transcript.fixture,
        kickoff: transcript.kickoff,
        probabilities: {
          home: result?.probabilities?.home ?? null,
          draw: result?.probabilities?.draw ?? null,
          away: result?.probabilities?.away ?? null,
          over25: ou?.probabilities?.over ?? null,
          btts: btts?.probabilities?.yes ?? null,
        },
        market_baseline: result?.marketBaseline ?? null,
        edge_vs_market: result?.edge ?? null,
        confidence: (result?.confidence ?? 'LOW').toLowerCase(),
        key_evidence: transcript.rounds.one.evidence.facts.filter((f) => !f.unavailable).slice(0, 8).map((f) => `${f.label}: ${f.value}`),
        skeptic_objections_unresolved: result?.unresolvedObjections ?? [],
        recommendation: (result?.recommendation ?? 'NO_PICK').toLowerCase().replace('_', ' '),
        suggested_stake_pct: result?.stakePct ?? null,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<number> {
  const oddsConfigured = createOddsProvider(prisma)?.isConfigured() ?? false;
  if (!oddsConfigured) {
    console.error('Note: no odds provider is configured. COPYCAT reports no market baseline, every edge is null and no stake is suggested.\n');
  }

  if (has('settle')) {
    const summary = await new DebateSettlementService(prisma).settlePending({ dataEnvironment: envArg });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (has('report')) {
    const report = await new DebateSettlementService(prisma).report({ dataEnvironment: envArg });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const matchId = flag('match');
  if (matchId) {
    await debateOne(matchId, oddsConfigured);
    return 0;
  }

  if (has('upcoming')) {
    const days = Number(flag('days') ?? 7);
    const limit = Number(flag('limit') ?? 10);
    const now = new Date();
    const to = new Date(now.getTime() + days * 86_400_000);
    const matches = await prisma.match.findMany({
      where: { status: 'SCHEDULED', matchDate: { gt: now, lte: to }, ...(envArg ? { dataEnvironment: envArg } : { dataEnvironment: 'LIVE' }) },
      orderBy: { matchDate: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (matches.length === 0) {
      console.error(`No scheduled matches in the next ${days} day(s).`);
      return 1;
    }
    for (const m of matches) await debateOne(m.id, oddsConfigured);
    return 0;
  }

  console.error('Usage: debate --match=<id> | --upcoming [--days=N] [--limit=N] | --settle | --report [--env=ENV]');
  return 1;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await prisma.$disconnect();
    process.exit(1);
  });
