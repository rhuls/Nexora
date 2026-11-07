import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockFootballProvider } from '../src/providers/mock/mock-football.provider.js';
import { OpenFootballProvider } from '../src/providers/openfootball/openfootball.provider.js';

const SRC = join(import.meta.dirname, '..', 'src');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
}

describe('architecture boundaries', () => {
  it('keeps providers independent of Prisma, repositories, services, analysis and the knowledge layer', () => {
    const forbidden = [/^@prisma\/client$/, /repositories\//, /services\//, /analysis\//, /data\/knowledge\//, /data\/import\//, /features\//];
    const violations = filesUnder(join(SRC, 'providers')).flatMap((file) =>
      importsOf(file).filter((spec) => forbidden.some((re) => re.test(spec))).map((spec) => `${relative(SRC, file)} -> ${spec}`),
    );
    expect(violations).toEqual([]);
  });

  it('keeps the knowledge layer reading only from the database, never from providers', () => {
    const violations = filesUnder(join(SRC, 'data', 'knowledge')).flatMap((file) =>
      importsOf(file).filter((spec) => spec.includes('providers/')).map((spec) => `${relative(SRC, file)} -> ${spec}`),
    );
    expect(violations).toEqual([]);
  });
});

describe('provider capabilities are declared honestly', () => {
  const noFetch = { fetchText: async () => { throw new Error('network not expected'); } };

  it('openfootball declares only fixtures/results and reports the rest as unavailable', async () => {
    const provider = new OpenFootballProvider(noFetch);
    expect(provider.capabilities).toEqual({ matches: true, matchStats: false, players: false, playerStats: false, availability: false, standings: false });
    const ref = { competitionSourceId: 'en.1', seasonSourceId: '2023-24' };
    for (const result of [
      await provider.getMatchStats(),
      await provider.getPlayerStats(),
      await provider.getPlayerAvailability(),
      await provider.getPlayers(),
      await provider.getStandings(),
    ]) {
      expect(result.available).toBe(false);
    }
    await expect(provider.getMatches({ ...ref, seasonSourceId: '2019-20' })).rejects.toThrow(/allowlist/);
  });

  it('the mock provider serves the deterministic synthetic league with rounds populated', async () => {
    const provider = new MockFootballProvider();
    const matches = await provider.getMatches({ competitionSourceId: 'comp_ndl', seasonSourceId: 'season_2025_26' });
    expect(matches.available).toBe(true);
    if (!matches.available) return;
    expect(matches.data).toHaveLength(56);
    expect(matches.data.every((m) => m.round?.startsWith('Round '))).toBe(true);
    const stats = await provider.getMatchStats({ competitionSourceId: 'comp_ndl', seasonSourceId: 'season_2025_26' }, matches.data[0]!.sourceId);
    expect(stats.available && stats.data).toHaveLength(2);
  });
});
