import type { PlayerPosition } from '@prisma/client';

export const RANDOM_SEED = 20260927;

// Matches kicking off before this instant are generated as FINISHED; later fixtures stay SCHEDULED.
export const SEED_REFERENCE_DATE = new Date('2026-09-27T10:00:00.000Z');

export const ROUND_INTERVAL_DAYS = 14;

export const COMPETITION = {
  id: 'comp_ndl',
  code: 'NDL',
  name: 'Nexora Development League',
  country: 'England',
} as const;

export interface SeasonProfile {
  id: string;
  name: string;
  firstRound: Date;
}

export const SEASONS: readonly SeasonProfile[] = [
  { id: 'season_2024_25', name: '2024/25', firstRound: new Date('2024-08-17T14:00:00.000Z') },
  { id: 'season_2025_26', name: '2025/26', firstRound: new Date('2025-08-16T14:00:00.000Z') },
  { id: 'season_2026_27', name: '2026/27', firstRound: new Date('2026-08-15T14:00:00.000Z') },
];

// Hidden generation parameters. They shape the synthetic data but are never stored or read by the analysis engine.
export interface TeamProfile {
  id: string;
  name: string;
  shortName: string;
  attack: number;
  defense: number;
  possessionBias: number;
  cornerBias: number;
  cardBias: number;
}

export const TEAMS: readonly TeamProfile[] = [
  { id: 'team_ash', name: 'Ashvale Rovers', shortName: 'ASH', attack: 1.3, defense: 0.8, possessionBias: 6, cornerBias: 1.15, cardBias: 0.9 },
  { id: 'team_bla', name: 'Blackmere Athletic', shortName: 'BLA', attack: 1.2, defense: 0.85, possessionBias: 4, cornerBias: 1.1, cardBias: 1.0 },
  { id: 'team_car', name: 'Carrowby United', shortName: 'CAR', attack: 1.1, defense: 0.95, possessionBias: 2, cornerBias: 1.0, cardBias: 1.15 },
  { id: 'team_dun', name: 'Dunmere City', shortName: 'DUN', attack: 1.05, defense: 1.0, possessionBias: 1, cornerBias: 0.95, cardBias: 1.0 },
  { id: 'team_eas', name: 'Eastbrook Wanderers', shortName: 'EAS', attack: 0.95, defense: 1.0, possessionBias: -1, cornerBias: 1.05, cardBias: 1.2 },
  { id: 'team_fen', name: 'Fenwick Albion', shortName: 'FEN', attack: 0.9, defense: 1.1, possessionBias: -2, cornerBias: 0.9, cardBias: 0.95 },
  { id: 'team_gre', name: 'Greyhaven Town', shortName: 'GRE', attack: 0.85, defense: 1.15, possessionBias: -4, cornerBias: 0.9, cardBias: 1.1 },
  { id: 'team_hol', name: 'Hollinsby Park', shortName: 'HOL', attack: 0.8, defense: 1.2, possessionBias: -6, cornerBias: 0.85, cardBias: 1.05 },
];

export const SQUAD_TEMPLATE: readonly PlayerPosition[] = [
  'GOALKEEPER', 'GOALKEEPER',
  'DEFENDER', 'DEFENDER', 'DEFENDER', 'DEFENDER', 'DEFENDER', 'DEFENDER',
  'MIDFIELDER', 'MIDFIELDER', 'MIDFIELDER', 'MIDFIELDER', 'MIDFIELDER', 'MIDFIELDER',
  'FORWARD', 'FORWARD', 'FORWARD', 'FORWARD',
];

export const FORMATION: Readonly<Record<PlayerPosition, number>> = {
  GOALKEEPER: 1,
  DEFENDER: 4,
  MIDFIELDER: 4,
  FORWARD: 2,
};

export const FIRST_NAMES: readonly string[] = [
  'Aaron', 'Ben', 'Callum', 'Daniel', 'Elliot', 'Finn', 'George', 'Harvey', 'Isaac', 'Jack',
  'Kieran', 'Liam', 'Mason', 'Nathan', 'Oliver', 'Patrick', 'Reece', 'Samuel', 'Tom', 'Tyler',
  'Adam', 'Bradley', 'Connor', 'Dylan', 'Ethan', 'Jamie', 'Joel', 'Kyle', 'Lewis', 'Marcus',
  'Noah', 'Owen', 'Ryan', 'Sean', 'Theo', 'Will', 'Zach', 'Lucas', 'Max', 'Jordan',
];

export const LAST_NAMES: readonly string[] = [
  'Adams', 'Barker', 'Carter', 'Dawson', 'Ellis', 'Fletcher', 'Graham', 'Hughes', 'Irving', 'Jennings',
  'Kerr', 'Lawson', 'Morgan', 'Norris', 'Owens', 'Parker', 'Quinn', 'Reid', 'Shaw', 'Turner',
  'Underwood', 'Vaughan', 'Walsh', 'Young', 'Bishop', 'Cole', 'Doyle', 'Foster', 'Gibson', 'Hayes',
  'Knight', 'Lambert', 'Marsh', 'Nolan', 'Palmer', 'Rowe', 'Stone', 'Tate', 'Webb', 'Wood',
];

export const INJURY_REASONS: readonly string[] = [
  'Hamstring strain',
  'Ankle sprain',
  'Calf strain',
  'Groin strain',
  'Knee ligament strain',
  'Thigh contusion',
];

export const INITIAL_MODEL_VERSION = {
  id: 'mv_1_0',
  version: 'v1.0',
  notes: 'Initial feature weights defined in the Nexora MVP brief.',
} as const;

export const INITIAL_FEATURE_WEIGHTS: Readonly<Record<string, number>> = {
  recentForm: 0.25,
  shotsOnTarget: 0.2,
  goals: 0.15,
  availability: 0.15,
  homeAway: 0.1,
  h2h: 0.05,
  corners: 0.05,
  discipline: 0.05,
};
