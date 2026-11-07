// Contracts for the four-agent debate. Every agent is a pure function of what it is given: the same
// inputs always produce the same claims, so a debate can be replayed offline and backtested like a model.

import { z } from 'zod';
import type { ClaimStance, DebateAgent, DebateMarket, DebateRecommendation, ObjectionSeverity } from '@prisma/client';
import type { DataQuality, MatchFeatureVector } from '../features/feature-engineering.service.js';
import type { FeatureBuild } from '../features/feature-engineering.service.js';
import type { MatchAnalysis } from '../analysis/engine.js';

export const DEBATE_ENGINE_VERSION = '1.0.0';

export const DEBATE_MARKETS = ['MATCH_RESULT', 'OVER_UNDER_25', 'BTTS'] as const;

// ---- Shared value shapes ----

// Every fact Scout states carries where it came from and when it was known. A fact without provenance
// is not a fact Nexora will use.
export const FactSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.union([z.number(), z.string(), z.null()]),
  unit: z.string().nullable(),
  // "openfootball", "api-football", "nexora-knowledge" — the origin of the underlying rows.
  source: z.string().min(1),
  // The most recent input that fed this fact, or null when nothing was available.
  asOf: z.string().nullable(),
  sampleSize: z.number().int().min(0).nullable(),
  // true when the value could not be established at the cutoff; value is then null, never 0.
  unavailable: z.boolean(),
  // Set when the newest input is old enough that the fact may no longer hold.
  staleHours: z.number().nullable(),
});
export type Fact = z.infer<typeof FactSchema>;

export const MarketProbabilitiesSchema = z.object({
  MATCH_RESULT: z.object({ home: z.number(), draw: z.number(), away: z.number() }).nullable(),
  OVER_UNDER_25: z.object({ over: z.number(), under: z.number() }).nullable(),
  BTTS: z.object({ yes: z.number(), no: z.number() }).nullable(),
});
export type MarketProbabilities = z.infer<typeof MarketProbabilitiesSchema>;

// ---- Round 1: Scout ----

export interface EvidenceBundle {
  matchId: string;
  asOf: string;
  facts: Fact[];
  // Named gaps, so the Skeptic can attack them and the output can admit them.
  missing: string[];
  stale: string[];
  dataQuality: DataQuality;
}

export interface ScoutInput {
  build: FeatureBuild;
  analysis: MatchAnalysis;
  now: Date;
}

export interface IScout {
  readonly id: 'SCOUT';
  gather(input: ScoutInput): EvidenceBundle;
}

// ---- Round 1: Copycat ----

export type BaselineStatus = 'AVAILABLE' | 'NOT_CONFIGURED' | 'NO_ODDS_BEFORE_CUTOFF' | 'STALE';

export interface MarketBaseline {
  status: BaselineStatus;
  reason: string;
  // Null for every market when status is not AVAILABLE. Never guessed.
  probabilities: MarketProbabilities;
  bookmaker: string | null;
  capturedAt: string | null;
  overround: Record<string, number>;
  method: string | null;
  oddsSnapshotIds: string[];
  prices: Record<string, Record<string, number>>;
}

// Odds already read from storage and filtered to the cutoff; Copycat does not query.
export interface StoredOdds {
  id: string;
  market: DebateMarket;
  source: string;
  bookmaker: string;
  capturedAt: Date;
  prices: Record<string, number>;
}

export interface CopycatInput {
  odds: StoredOdds[];
  asOf: Date;
  // A provider that is not configured is reported as such, distinct from "configured but no prices".
  providerConfigured: boolean;
}

export interface ICopycat {
  readonly id: 'COPYCAT';
  baseline(input: CopycatInput): MarketBaseline;
}

// ---- Round 2: Skeptic ----

export interface Objection {
  code: string;
  // The specific weakness, with the number behind it. Never "uncertain".
  summary: string;
  severity: ObjectionSeverity;
  targetAgent: DebateAgent;
  market: DebateMarket | null;
  evidence: Record<string, unknown>;
}

export interface SkepticInput {
  evidence: EvidenceBundle;
  baseline: MarketBaseline;
  model: MarketProbabilities;
  analysis: MatchAnalysis;
  vector: MatchFeatureVector;
  dataEnvironment: 'SYNTHETIC' | 'HISTORICAL' | 'LIVE';
  // Expected calibration error of the active model in this environment, if enough settled forecasts exist.
  calibration: { expectedCalibrationError: number | null; sampleSize: number };
  knownResults: number;
  // Total-variation agreement between the two models, straight from the ensemble. Null with fewer than two.
  ensembleAgreement: number | null;
}

export interface ISkeptic {
  readonly id: 'SKEPTIC';
  challenge(input: SkepticInput): Objection[];
}

// ---- Round 4: Bookkeeper ----

export interface CalibrationCheck {
  bucket: string;
  // Historical hit rate of picks made at this confidence, or null when too few have settled.
  observed: number | null;
  expected: number | null;
  sampleSize: number;
  trustworthy: boolean;
  note: string;
}

export interface StakeDecision {
  stakePct: number | null;
  reason: string;
}

export interface BookkeeperInput {
  market: DebateMarket;
  probabilities: Record<string, number>;
  baseline: Record<string, number> | null;
  prices: Record<string, number> | null;
  recommendation: DebateRecommendation;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  history: CalibrationCheck;
}

export interface IBookkeeper {
  readonly id: 'BOOKKEEPER';
  check(input: BookkeeperInput): { stake: StakeDecision; calibration: CalibrationCheck };
}

// ---- Verdict ----

export interface MarketVerdict {
  market: DebateMarket;
  probabilities: Record<string, number> | null;
  marketBaseline: Record<string, number> | null;
  // Model probability minus market probability on the model's leading outcome. Null without a baseline.
  edge: number | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  recommendation: DebateRecommendation;
  reasoning: string;
  unresolvedObjections: string[];
  stakePct: number | null;
  stakeReason: string;
  calibration: CalibrationCheck;
  prices: Record<string, number> | null;
  oddsSnapshotId: string | null;
}

export interface DebateClaim {
  agent: DebateAgent;
  round: number;
  code: string;
  summary: string;
  stance: ClaimStance;
  severity: ObjectionSeverity | null;
  targetAgent: DebateAgent | null;
  market: DebateMarket | null;
  evidence: Record<string, unknown>;
}

export interface DebateTranscript {
  matchId: string;
  fixture: string;
  kickoff: string;
  asOf: string;
  engineVersion: string;
  dataEnvironment: 'SYNTHETIC' | 'HISTORICAL' | 'LIVE';
  modelVersion: string;
  rounds: {
    one: { evidence: EvidenceBundle; baseline: MarketBaseline };
    two: { objections: Objection[]; responses: Array<{ code: string; agent: DebateAgent; response: string; conceded: boolean }> };
    three: { verdicts: MarketVerdict[]; lastObjections: Objection[] };
    four: { calibration: CalibrationCheck[]; notes: string[] };
  };
  claims: DebateClaim[];
  verdicts: MarketVerdict[];
}
