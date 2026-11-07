import { z } from 'zod';
import { zonedLocalToUtc } from '../../utils/time.js';
import type { ProviderMatch, SourceWarning } from '../types.js';
import type { OpenFootballDataset } from './datasets.js';

const RawMatchSchema = z.object({
  round: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  team1: z.string().min(1),
  team2: z.string().min(1),
  score: z.unknown().optional(),
});

const RawFileSchema = z.object({
  name: z.string().min(1),
  matches: z.array(RawMatchSchema),
});

export type RawOpenFootballMatch = z.infer<typeof RawMatchSchema>;

type Pair = [number, number];

const GoalsSchema = z.tuple([z.number().int().min(0), z.number().int().min(0)]);

export interface ParsedScore {
  fullTime: Pair | null;
  halfTime: Pair | null;
  shape: 'labelled' | 'bare-array' | 'missing';
  unknownKeys: string[];
}

export function parseScore(raw: unknown): ParsedScore {
  if (raw === undefined || raw === null) return { fullTime: null, halfTime: null, shape: 'missing', unknownKeys: [] };

  // Some files give an unlabelled [home, away]; it is the final score, and no half-time is implied.
  if (Array.isArray(raw)) {
    const parsed = GoalsSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid score array ${JSON.stringify(raw)}`);
    return { fullTime: parsed.data, halfTime: null, shape: 'bare-array', unknownKeys: [] };
  }

  if (typeof raw !== 'object') throw new Error(`Invalid score ${JSON.stringify(raw)}`);
  const record = raw as Record<string, unknown>;
  const read = (key: 'ft' | 'ht'): Pair | null => {
    if (record[key] === undefined) return null;
    const parsed = GoalsSchema.safeParse(record[key]);
    if (!parsed.success) throw new Error(`Invalid ${key} score ${JSON.stringify(record[key])}`);
    return parsed.data;
  };
  const fullTime = read('ft');
  const halfTime = read('ht');
  if (fullTime && halfTime && (halfTime[0] > fullTime[0] || halfTime[1] > fullTime[1])) {
    throw new Error(`Half-time score ${JSON.stringify(halfTime)} exceeds full-time ${JSON.stringify(fullTime)}`);
  }
  const unknownKeys = Object.keys(record).filter((k) => k !== 'ft' && k !== 'ht');
  return { fullTime, halfTime, shape: fullTime || halfTime ? 'labelled' : 'missing', unknownKeys };
}

export interface ParsedDataset {
  name: string;
  matches: ProviderMatch[];
  warnings: SourceWarning[];
}

export function matchSourceId(dataset: Pick<OpenFootballDataset, 'competitionSourceId' | 'seasonSourceId'>, raw: Pick<RawOpenFootballMatch, 'team1' | 'team2'>): string {
  // A league season has exactly one meeting per ordered pair, so this key survives postponements and date changes.
  return `${dataset.competitionSourceId}/${dataset.seasonSourceId}/${raw.team1}~${raw.team2}`;
}

export function parseOpenFootballFile(body: string, dataset: OpenFootballDataset, now: Date): ParsedDataset {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`openfootball ${dataset.seasonSourceId}/${dataset.competitionSourceId}: file is not valid JSON`);
  }
  const file = RawFileSchema.parse(json);
  const warnings: SourceWarning[] = [];
  const matches: ProviderMatch[] = [];
  const seen = new Set<string>();

  for (const raw of file.matches) {
    const sourceId = matchSourceId(dataset, raw);
    if (raw.team1 === raw.team2) throw new Error(`${sourceId}: a team cannot play itself`);
    if (seen.has(sourceId)) throw new Error(`${sourceId}: duplicate fixture in source file`);
    seen.add(sourceId);

    const score = parseScore(raw.score);
    if (score.shape === 'bare-array') {
      warnings.push({ code: 'SCORE_UNLABELLED', sourceId, message: 'Score given as an unlabelled [home, away] array; imported as full-time, half-time left unavailable.' });
    } else if (score.fullTime && !score.halfTime) {
      warnings.push({ code: 'HALF_TIME_MISSING', sourceId, message: 'Source gives a full-time score without a half-time score; half-time left unavailable.' });
    }
    if (score.unknownKeys.length > 0) {
      warnings.push({ code: 'SCORE_UNKNOWN_KEYS', sourceId, message: `Ignored unrecognised score keys: ${score.unknownKeys.join(', ')}` });
    }

    const kickoffTimeKnown = raw.time !== undefined;
    const kickoff = zonedLocalToUtc(raw.date, raw.time ?? '00:00', dataset.timeZone);
    if (!kickoffTimeKnown) {
      warnings.push({ code: 'KICKOFF_TIME_UNKNOWN', sourceId, message: 'Source gives a date only; kickoff stored as local midnight and treated as unknown.' });
    }

    let status: ProviderMatch['status'];
    if (score.fullTime) status = 'FINISHED';
    else {
      // No result yet: stays SCHEDULED whether it is upcoming or awaiting a result the source has not published.
      status = 'SCHEDULED';
      if (kickoff.getTime() <= now.getTime()) {
        warnings.push({ code: 'RESULT_PENDING', sourceId, message: 'Kickoff has passed but the source has not published a result; kept as SCHEDULED.' });
      }
    }

    matches.push({
      sourceId,
      competitionSourceId: dataset.competitionSourceId,
      seasonSourceId: dataset.seasonSourceId,
      round: raw.round ?? null,
      homeTeam: { sourceId: null, name: raw.team1 },
      awayTeam: { sourceId: null, name: raw.team2 },
      kickoff,
      kickoffTimeKnown,
      sourceMatchDate: raw.time ? `${raw.date} ${raw.time}` : raw.date,
      status,
      homeScore: score.fullTime?.[0] ?? null,
      awayScore: score.fullTime?.[1] ?? null,
      homeHalfTimeScore: score.halfTime?.[0] ?? null,
      awayHalfTimeScore: score.halfTime?.[1] ?? null,
    });
  }

  return { name: file.name, matches, warnings };
}
