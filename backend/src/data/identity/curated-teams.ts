export interface CuratedTeam {
  key: string;
  // The backbone competition this club plays in. A curated club belongs to exactly one, so the
  // importer syncs only the clubs of the competition it is importing.
  competitionSourceId: string;
  name: string;
  shortName: string;
  country: string;
  // Exact spellings each source uses. Add a spelling here only after confirming it refers to this club.
  aliases: Readonly<Record<string, readonly string[]>>;
}

export const CURATED_SOURCE = 'nexora-curated';

// Premier League clubs 2023/24–2026/27.
const EPL_TEAMS: readonly CuratedTeam[] = [
  { key: 'eng-arsenal', competitionSourceId: 'en.1', name: 'Arsenal', shortName: 'ARS', country: 'England', aliases: { openfootball: ['Arsenal FC'] } },
  { key: 'eng-aston-villa', competitionSourceId: 'en.1', name: 'Aston Villa', shortName: 'AVL', country: 'England', aliases: { openfootball: ['Aston Villa FC'] } },
  { key: 'eng-bournemouth', competitionSourceId: 'en.1', name: 'AFC Bournemouth', shortName: 'BOU', country: 'England', aliases: { openfootball: ['AFC Bournemouth'] } },
  { key: 'eng-brentford', competitionSourceId: 'en.1', name: 'Brentford', shortName: 'BRE', country: 'England', aliases: { openfootball: ['Brentford FC'] } },
  { key: 'eng-brighton', competitionSourceId: 'en.1', name: 'Brighton & Hove Albion', shortName: 'BHA', country: 'England', aliases: { openfootball: ['Brighton & Hove Albion FC'] } },
  { key: 'eng-burnley', competitionSourceId: 'en.1', name: 'Burnley', shortName: 'BUR', country: 'England', aliases: { openfootball: ['Burnley FC'] } },
  { key: 'eng-chelsea', competitionSourceId: 'en.1', name: 'Chelsea', shortName: 'CHE', country: 'England', aliases: { openfootball: ['Chelsea FC'] } },
  { key: 'eng-coventry', competitionSourceId: 'en.1', name: 'Coventry City', shortName: 'COV', country: 'England', aliases: { openfootball: ['Coventry City FC'] } },
  { key: 'eng-crystal-palace', competitionSourceId: 'en.1', name: 'Crystal Palace', shortName: 'CRY', country: 'England', aliases: { openfootball: ['Crystal Palace FC'] } },
  { key: 'eng-everton', competitionSourceId: 'en.1', name: 'Everton', shortName: 'EVE', country: 'England', aliases: { openfootball: ['Everton FC'] } },
  { key: 'eng-fulham', competitionSourceId: 'en.1', name: 'Fulham', shortName: 'FUL', country: 'England', aliases: { openfootball: ['Fulham FC'] } },
  { key: 'eng-hull', competitionSourceId: 'en.1', name: 'Hull City', shortName: 'HUL', country: 'England', aliases: { openfootball: ['Hull City AFC'] } },
  { key: 'eng-ipswich', competitionSourceId: 'en.1', name: 'Ipswich Town', shortName: 'IPS', country: 'England', aliases: { openfootball: ['Ipswich Town FC'] } },
  { key: 'eng-leeds', competitionSourceId: 'en.1', name: 'Leeds United', shortName: 'LEE', country: 'England', aliases: { openfootball: ['Leeds United FC'] } },
  { key: 'eng-leicester', competitionSourceId: 'en.1', name: 'Leicester City', shortName: 'LEI', country: 'England', aliases: { openfootball: ['Leicester City FC'] } },
  { key: 'eng-liverpool', competitionSourceId: 'en.1', name: 'Liverpool', shortName: 'LIV', country: 'England', aliases: { openfootball: ['Liverpool FC'] } },
  { key: 'eng-luton', competitionSourceId: 'en.1', name: 'Luton Town', shortName: 'LUT', country: 'England', aliases: { openfootball: ['Luton Town FC'] } },
  { key: 'eng-man-city', competitionSourceId: 'en.1', name: 'Manchester City', shortName: 'MCI', country: 'England', aliases: { openfootball: ['Manchester City FC'] } },
  { key: 'eng-man-united', competitionSourceId: 'en.1', name: 'Manchester United', shortName: 'MUN', country: 'England', aliases: { openfootball: ['Manchester United FC'] } },
  { key: 'eng-newcastle', competitionSourceId: 'en.1', name: 'Newcastle United', shortName: 'NEW', country: 'England', aliases: { openfootball: ['Newcastle United FC'] } },
  { key: 'eng-nottingham-forest', competitionSourceId: 'en.1', name: 'Nottingham Forest', shortName: 'NFO', country: 'England', aliases: { openfootball: ['Nottingham Forest FC'] } },
  { key: 'eng-sheffield-united', competitionSourceId: 'en.1', name: 'Sheffield United', shortName: 'SHU', country: 'England', aliases: { openfootball: ['Sheffield United FC'] } },
  { key: 'eng-southampton', competitionSourceId: 'en.1', name: 'Southampton', shortName: 'SOU', country: 'England', aliases: { openfootball: ['Southampton FC'] } },
  { key: 'eng-sunderland', competitionSourceId: 'en.1', name: 'Sunderland', shortName: 'SUN', country: 'England', aliases: { openfootball: ['Sunderland AFC'] } },
  { key: 'eng-tottenham', competitionSourceId: 'en.1', name: 'Tottenham Hotspur', shortName: 'TOT', country: 'England', aliases: { openfootball: ['Tottenham Hotspur FC'] } },
  { key: 'eng-west-ham', competitionSourceId: 'en.1', name: 'West Ham United', shortName: 'WHU', country: 'England', aliases: { openfootball: ['West Ham United FC'] } },
  { key: 'eng-wolves', competitionSourceId: 'en.1', name: 'Wolverhampton Wanderers', shortName: 'WOL', country: 'England', aliases: { openfootball: ['Wolverhampton Wanderers FC'] } },
];

// The names API-Football prints for these clubs. A name the provider spells differently is reported as unresolved
// by the importer (never guessed); add the new spelling here once confirmed. The team's API-Football ID is bound
// to the alias on first resolution and must agree from then on.
const API_FOOTBALL_NAMES: Readonly<Record<string, string>> = {
  'eng-arsenal': 'Arsenal',
  'eng-aston-villa': 'Aston Villa',
  'eng-bournemouth': 'Bournemouth',
  'eng-brentford': 'Brentford',
  'eng-brighton': 'Brighton',
  'eng-burnley': 'Burnley',
  'eng-chelsea': 'Chelsea',
  'eng-coventry': 'Coventry',
  'eng-crystal-palace': 'Crystal Palace',
  'eng-everton': 'Everton',
  'eng-fulham': 'Fulham',
  'eng-hull': 'Hull City',
  'eng-ipswich': 'Ipswich',
  'eng-leeds': 'Leeds',
  'eng-leicester': 'Leicester',
  'eng-liverpool': 'Liverpool',
  'eng-luton': 'Luton',
  'eng-man-city': 'Manchester City',
  'eng-man-united': 'Manchester United',
  'eng-newcastle': 'Newcastle',
  'eng-nottingham-forest': 'Nottingham Forest',
  'eng-sheffield-united': 'Sheffield Utd',
  'eng-southampton': 'Southampton',
  'eng-sunderland': 'Sunderland',
  'eng-tottenham': 'Tottenham',
  'eng-west-ham': 'West Ham',
  'eng-wolves': 'Wolves',
};

// La Liga clubs appearing in 2023/24-2026/27.
const ESP_TEAMS: readonly CuratedTeam[] = [
  { key: 'esp-athletic-bilbao', competitionSourceId: 'es.1', name: "Athletic Bilbao", shortName: 'ATH', country: 'Spain', aliases: { openfootball: ["Athletic Club"] } },
  { key: 'esp-osasuna', competitionSourceId: 'es.1', name: "Osasuna", shortName: 'OSA', country: 'Spain', aliases: { openfootball: ["CA Osasuna"] } },
  { key: 'esp-leganes', competitionSourceId: 'es.1', name: "Leganés", shortName: 'LEG', country: 'Spain', aliases: { openfootball: ["CD Leganés"] } },
  { key: 'esp-atletico-madrid', competitionSourceId: 'es.1', name: "Atlético Madrid", shortName: 'ATM', country: 'Spain', aliases: { openfootball: ["Club Atlético de Madrid"] } },
  { key: 'esp-cadiz', competitionSourceId: 'es.1', name: "Cádiz", shortName: 'CAD', country: 'Spain', aliases: { openfootball: ["Cádiz CF"] } },
  { key: 'esp-alaves', competitionSourceId: 'es.1', name: "Alavés", shortName: 'ALA', country: 'Spain', aliases: { openfootball: ["Deportivo Alavés"] } },
  { key: 'esp-elche', competitionSourceId: 'es.1', name: "Elche", shortName: 'ELC', country: 'Spain', aliases: { openfootball: ["Elche CF"] } },
  { key: 'esp-barcelona', competitionSourceId: 'es.1', name: "Barcelona", shortName: 'BAR', country: 'Spain', aliases: { openfootball: ["FC Barcelona"] } },
  { key: 'esp-getafe', competitionSourceId: 'es.1', name: "Getafe", shortName: 'GET', country: 'Spain', aliases: { openfootball: ["Getafe CF"] } },
  { key: 'esp-girona', competitionSourceId: 'es.1', name: "Girona", shortName: 'GIR', country: 'Spain', aliases: { openfootball: ["Girona FC"] } },
  { key: 'esp-granada', competitionSourceId: 'es.1', name: "Granada", shortName: 'GRA', country: 'Spain', aliases: { openfootball: ["Granada CF"] } },
  { key: 'esp-levante', competitionSourceId: 'es.1', name: "Levante", shortName: 'LEV', country: 'Spain', aliases: { openfootball: ["Levante UD"] } },
  { key: 'esp-malaga', competitionSourceId: 'es.1', name: "Málaga", shortName: 'MAL', country: 'Spain', aliases: { openfootball: ["Málaga CF"] } },
  { key: 'esp-celta-vigo', competitionSourceId: 'es.1', name: "Celta Vigo", shortName: 'CEL', country: 'Spain', aliases: { openfootball: ["RC Celta de Vigo"] } },
  { key: 'esp-deportivo', competitionSourceId: 'es.1', name: "Deportivo", shortName: 'DEP', country: 'Spain', aliases: { openfootball: ["RC Deportivo La Coruña"] } },
  { key: 'esp-espanyol', competitionSourceId: 'es.1', name: "Espanyol", shortName: 'ESP', country: 'Spain', aliases: { openfootball: ["RCD Espanyol de Barcelona"] } },
  { key: 'esp-mallorca', competitionSourceId: 'es.1', name: "Mallorca", shortName: 'MLL', country: 'Spain', aliases: { openfootball: ["RCD Mallorca"] } },
  { key: 'esp-rayo-vallecano', competitionSourceId: 'es.1', name: "Rayo Vallecano", shortName: 'RAY', country: 'Spain', aliases: { openfootball: ["Rayo Vallecano de Madrid"] } },
  { key: 'esp-real-betis', competitionSourceId: 'es.1', name: "Real Betis", shortName: 'BET', country: 'Spain', aliases: { openfootball: ["Real Betis Balompié"] } },
  { key: 'esp-real-madrid', competitionSourceId: 'es.1', name: "Real Madrid", shortName: 'RMA', country: 'Spain', aliases: { openfootball: ["Real Madrid CF"] } },
  { key: 'esp-real-oviedo', competitionSourceId: 'es.1', name: "Real Oviedo", shortName: 'REO', country: 'Spain', aliases: { openfootball: ["Real Oviedo"] } },
  { key: 'esp-racing-santander', competitionSourceId: 'es.1', name: "Racing Santander", shortName: 'RAC', country: 'Spain', aliases: { openfootball: ["Real Racing Club de Santander"] } },
  { key: 'esp-real-sociedad', competitionSourceId: 'es.1', name: "Real Sociedad", shortName: 'RSO', country: 'Spain', aliases: { openfootball: ["Real Sociedad de Fútbol"] } },
  { key: 'esp-real-valladolid', competitionSourceId: 'es.1', name: "Real Valladolid", shortName: 'VLL', country: 'Spain', aliases: { openfootball: ["Real Valladolid CF"] } },
  { key: 'esp-sevilla', competitionSourceId: 'es.1', name: "Sevilla", shortName: 'SEV', country: 'Spain', aliases: { openfootball: ["Sevilla FC"] } },
  { key: 'esp-almeria', competitionSourceId: 'es.1', name: "Almería", shortName: 'ALM', country: 'Spain', aliases: { openfootball: ["UD Almería"] } },
  { key: 'esp-las-palmas', competitionSourceId: 'es.1', name: "Las Palmas", shortName: 'LPA', country: 'Spain', aliases: { openfootball: ["UD Las Palmas"] } },
  { key: 'esp-valencia', competitionSourceId: 'es.1', name: "Valencia", shortName: 'VAL', country: 'Spain', aliases: { openfootball: ["Valencia CF"] } },
  { key: 'esp-villarreal', competitionSourceId: 'es.1', name: "Villarreal", shortName: 'VIL', country: 'Spain', aliases: { openfootball: ["Villarreal CF"] } },
];

// Bundesliga clubs appearing in 2023/24-2026/27.
const GER_TEAMS: readonly CuratedTeam[] = [
  { key: 'ger-heidenheim', competitionSourceId: 'de.1', name: "Heidenheim", shortName: 'HDH', country: 'Germany', aliases: { openfootball: ["1. FC Heidenheim 1846"] } },
  { key: 'ger-koln', competitionSourceId: 'de.1', name: "Köln", shortName: 'KOE', country: 'Germany', aliases: { openfootball: ["1. FC Köln"] } },
  { key: 'ger-union-berlin', competitionSourceId: 'de.1', name: "Union Berlin", shortName: 'FCU', country: 'Germany', aliases: { openfootball: ["1. FC Union Berlin"] } },
  { key: 'ger-mainz', competitionSourceId: 'de.1', name: "Mainz", shortName: 'M05', country: 'Germany', aliases: { openfootball: ["1. FSV Mainz 05"] } },
  { key: 'ger-bayer-leverkusen', competitionSourceId: 'de.1', name: "Bayer Leverkusen", shortName: 'B04', country: 'Germany', aliases: { openfootball: ["Bayer 04 Leverkusen"] } },
  { key: 'ger-dortmund', competitionSourceId: 'de.1', name: "Dortmund", shortName: 'BVB', country: 'Germany', aliases: { openfootball: ["Borussia Dortmund"] } },
  { key: 'ger-m-gladbach', competitionSourceId: 'de.1', name: "M'gladbach", shortName: 'BMG', country: 'Germany', aliases: { openfootball: ["Borussia Mönchengladbach"] } },
  { key: 'ger-eintracht-frankfurt', competitionSourceId: 'de.1', name: "Eintracht Frankfurt", shortName: 'SGE', country: 'Germany', aliases: { openfootball: ["Eintracht Frankfurt"] } },
  { key: 'ger-augsburg', competitionSourceId: 'de.1', name: "Augsburg", shortName: 'AUG', country: 'Germany', aliases: { openfootball: ["FC Augsburg"] } },
  { key: 'ger-bayern-munich', competitionSourceId: 'de.1', name: "Bayern Munich", shortName: 'BAY', country: 'Germany', aliases: { openfootball: ["FC Bayern München"] } },
  { key: 'ger-schalke', competitionSourceId: 'de.1', name: "Schalke", shortName: 'S04', country: 'Germany', aliases: { openfootball: ["FC Schalke 04"] } },
  { key: 'ger-st-pauli', competitionSourceId: 'de.1', name: "St. Pauli", shortName: 'STP', country: 'Germany', aliases: { openfootball: ["FC St. Pauli 1910"] } },
  { key: 'ger-hamburg', competitionSourceId: 'de.1', name: "Hamburg", shortName: 'HSV', country: 'Germany', aliases: { openfootball: ["Hamburger SV"] } },
  { key: 'ger-holstein-kiel', competitionSourceId: 'de.1', name: "Holstein Kiel", shortName: 'KIE', country: 'Germany', aliases: { openfootball: ["Holstein Kiel"] } },
  { key: 'ger-rb-leipzig', competitionSourceId: 'de.1', name: "RB Leipzig", shortName: 'RBL', country: 'Germany', aliases: { openfootball: ["RB Leipzig"] } },
  { key: 'ger-freiburg', competitionSourceId: 'de.1', name: "Freiburg", shortName: 'FRE', country: 'Germany', aliases: { openfootball: ["SC Freiburg"] } },
  { key: 'ger-paderborn', competitionSourceId: 'de.1', name: "Paderborn", shortName: 'SCP', country: 'Germany', aliases: { openfootball: ["SC Paderborn 07"] } },
  { key: 'ger-elversberg', competitionSourceId: 'de.1', name: "Elversberg", shortName: 'SVE', country: 'Germany', aliases: { openfootball: ["SV 07 Elversberg"] } },
  { key: 'ger-darmstadt', competitionSourceId: 'de.1', name: "Darmstadt", shortName: 'SVD', country: 'Germany', aliases: { openfootball: ["SV Darmstadt 98"] } },
  { key: 'ger-werder-bremen', competitionSourceId: 'de.1', name: "Werder Bremen", shortName: 'SVW', country: 'Germany', aliases: { openfootball: ["SV Werder Bremen"] } },
  { key: 'ger-hoffenheim', competitionSourceId: 'de.1', name: "Hoffenheim", shortName: 'TSG', country: 'Germany', aliases: { openfootball: ["TSG 1899 Hoffenheim"] } },
  { key: 'ger-stuttgart', competitionSourceId: 'de.1', name: "Stuttgart", shortName: 'STU', country: 'Germany', aliases: { openfootball: ["VfB Stuttgart"] } },
  { key: 'ger-bochum', competitionSourceId: 'de.1', name: "Bochum", shortName: 'BOC', country: 'Germany', aliases: { openfootball: ["VfL Bochum 1848"] } },
  { key: 'ger-wolfsburg', competitionSourceId: 'de.1', name: "Wolfsburg", shortName: 'WOL', country: 'Germany', aliases: { openfootball: ["VfL Wolfsburg"] } },
];

// Serie A clubs appearing in 2023/24-2026/27.
const ITA_TEAMS: readonly CuratedTeam[] = [
  { key: 'ita-ac-milan', competitionSourceId: 'it.1', name: "AC Milan", shortName: 'MIL', country: 'Italy', aliases: { openfootball: ["AC Milan"] } },
  { key: 'ita-monza', competitionSourceId: 'it.1', name: "Monza", shortName: 'MZA', country: 'Italy', aliases: { openfootball: ["AC Monza"] } },
  { key: 'ita-pisa', competitionSourceId: 'it.1', name: "Pisa", shortName: 'PIS', country: 'Italy', aliases: { openfootball: ["AC Pisa 1909"] } },
  { key: 'ita-fiorentina', competitionSourceId: 'it.1', name: "Fiorentina", shortName: 'FIO', country: 'Italy', aliases: { openfootball: ["ACF Fiorentina"] } },
  { key: 'ita-roma', competitionSourceId: 'it.1', name: "Roma", shortName: 'ROM', country: 'Italy', aliases: { openfootball: ["AS Roma"] } },
  { key: 'ita-atalanta', competitionSourceId: 'it.1', name: "Atalanta", shortName: 'ATA', country: 'Italy', aliases: { openfootball: ["Atalanta BC"] } },
  { key: 'ita-bologna', competitionSourceId: 'it.1', name: "Bologna", shortName: 'BOL', country: 'Italy', aliases: { openfootball: ["Bologna FC 1909"] } },
  { key: 'ita-cagliari', competitionSourceId: 'it.1', name: "Cagliari", shortName: 'CAG', country: 'Italy', aliases: { openfootball: ["Cagliari Calcio"] } },
  { key: 'ita-como', competitionSourceId: 'it.1', name: "Como", shortName: 'COM', country: 'Italy', aliases: { openfootball: ["Como 1907"] } },
  { key: 'ita-empoli', competitionSourceId: 'it.1', name: "Empoli", shortName: 'EMP', country: 'Italy', aliases: { openfootball: ["Empoli FC"] } },
  { key: 'ita-inter-milan', competitionSourceId: 'it.1', name: "Inter Milan", shortName: 'INT', country: 'Italy', aliases: { openfootball: ["FC Internazionale Milano"] } },
  { key: 'ita-frosinone', competitionSourceId: 'it.1', name: "Frosinone", shortName: 'FRO', country: 'Italy', aliases: { openfootball: ["Frosinone Calcio"] } },
  { key: 'ita-genoa', competitionSourceId: 'it.1', name: "Genoa", shortName: 'GEN', country: 'Italy', aliases: { openfootball: ["Genoa CFC"] } },
  { key: 'ita-verona', competitionSourceId: 'it.1', name: "Verona", shortName: 'VER', country: 'Italy', aliases: { openfootball: ["Hellas Verona FC"] } },
  { key: 'ita-juventus', competitionSourceId: 'it.1', name: "Juventus", shortName: 'JUV', country: 'Italy', aliases: { openfootball: ["Juventus FC"] } },
  { key: 'ita-parma', competitionSourceId: 'it.1', name: "Parma", shortName: 'PAR', country: 'Italy', aliases: { openfootball: ["Parma Calcio 1913"] } },
  { key: 'ita-lazio', competitionSourceId: 'it.1', name: "Lazio", shortName: 'LAZ', country: 'Italy', aliases: { openfootball: ["SS Lazio"] } },
  { key: 'ita-napoli', competitionSourceId: 'it.1', name: "Napoli", shortName: 'NAP', country: 'Italy', aliases: { openfootball: ["SSC Napoli"] } },
  { key: 'ita-torino', competitionSourceId: 'it.1', name: "Torino", shortName: 'TOR', country: 'Italy', aliases: { openfootball: ["Torino FC"] } },
  { key: 'ita-cremonese', competitionSourceId: 'it.1', name: "Cremonese", shortName: 'CRE', country: 'Italy', aliases: { openfootball: ["US Cremonese"] } },
  { key: 'ita-lecce', competitionSourceId: 'it.1', name: "Lecce", shortName: 'LEC', country: 'Italy', aliases: { openfootball: ["US Lecce"] } },
  { key: 'ita-salernitana', competitionSourceId: 'it.1', name: "Salernitana", shortName: 'SAL', country: 'Italy', aliases: { openfootball: ["US Salernitana 1919"] } },
  { key: 'ita-sassuolo', competitionSourceId: 'it.1', name: "Sassuolo", shortName: 'SAS', country: 'Italy', aliases: { openfootball: ["US Sassuolo Calcio"] } },
  { key: 'ita-udinese', competitionSourceId: 'it.1', name: "Udinese", shortName: 'UDI', country: 'Italy', aliases: { openfootball: ["Udinese Calcio"] } },
  { key: 'ita-venezia', competitionSourceId: 'it.1', name: "Venezia", shortName: 'VEN', country: 'Italy', aliases: { openfootball: ["Venezia FC"] } },
];

// Ligue 1 clubs appearing in 2023/24-2026/27.
const FRA_TEAMS: readonly CuratedTeam[] = [
  { key: 'fra-auxerre', competitionSourceId: 'fr.1', name: "Auxerre", shortName: 'AJA', country: 'France', aliases: { openfootball: ["AJ Auxerre"] } },
  { key: 'fra-monaco', competitionSourceId: 'fr.1', name: "Monaco", shortName: 'ASM', country: 'France', aliases: { openfootball: ["AS Monaco FC"] } },
  { key: 'fra-saint-etienne', competitionSourceId: 'fr.1', name: "Saint-Étienne", shortName: 'ASE', country: 'France', aliases: { openfootball: ["AS Saint-Étienne"] } },
  { key: 'fra-angers', competitionSourceId: 'fr.1', name: "Angers", shortName: 'ANG', country: 'France', aliases: { openfootball: ["Angers SCO"] } },
  { key: 'fra-clermont', competitionSourceId: 'fr.1', name: "Clermont", shortName: 'CF6', country: 'France', aliases: { openfootball: ["Clermont Foot 63"] } },
  { key: 'fra-troyes', competitionSourceId: 'fr.1', name: "Troyes", shortName: 'TRO', country: 'France', aliases: { openfootball: ["ES Troyes AC"] } },
  { key: 'fra-lorient', competitionSourceId: 'fr.1', name: "Lorient", shortName: 'FCL', country: 'France', aliases: { openfootball: ["FC Lorient"] } },
  { key: 'fra-metz', competitionSourceId: 'fr.1', name: "Metz", shortName: 'FCM', country: 'France', aliases: { openfootball: ["FC Metz"] } },
  { key: 'fra-nantes', competitionSourceId: 'fr.1', name: "Nantes", shortName: 'FCN', country: 'France', aliases: { openfootball: ["FC Nantes"] } },
  { key: 'fra-le-havre', competitionSourceId: 'fr.1', name: "Le Havre", shortName: 'HAC', country: 'France', aliases: { openfootball: ["Le Havre AC"] } },
  { key: 'fra-le-mans', competitionSourceId: 'fr.1', name: "Le Mans", shortName: 'LMN', country: 'France', aliases: { openfootball: ["Le Mans FC"] } },
  { key: 'fra-lille', competitionSourceId: 'fr.1', name: "Lille", shortName: 'LIL', country: 'France', aliases: { openfootball: ["Lille OSC"] } },
  { key: 'fra-montpellier', competitionSourceId: 'fr.1', name: "Montpellier", shortName: 'MTP', country: 'France', aliases: { openfootball: ["Montpellier HSC"] } },
  { key: 'fra-nice', competitionSourceId: 'fr.1', name: "Nice", shortName: 'OGC', country: 'France', aliases: { openfootball: ["OGC Nice"] } },
  { key: 'fra-lyon', competitionSourceId: 'fr.1', name: "Lyon", shortName: 'OL', country: 'France', aliases: { openfootball: ["Olympique Lyonnais"] } },
  { key: 'fra-marseille', competitionSourceId: 'fr.1', name: "Marseille", shortName: 'OM', country: 'France', aliases: { openfootball: ["Olympique de Marseille"] } },
  { key: 'fra-paris-fc', competitionSourceId: 'fr.1', name: "Paris FC", shortName: 'PFC', country: 'France', aliases: { openfootball: ["Paris FC"] } },
  { key: 'fra-paris-saint-germain', competitionSourceId: 'fr.1', name: "Paris Saint-Germain", shortName: 'PSG', country: 'France', aliases: { openfootball: ["Paris Saint-Germain FC"] } },
  { key: 'fra-strasbourg', competitionSourceId: 'fr.1', name: "Strasbourg", shortName: 'STR', country: 'France', aliases: { openfootball: ["RC Strasbourg Alsace"] } },
  { key: 'fra-lens', competitionSourceId: 'fr.1', name: "Lens", shortName: 'RCL', country: 'France', aliases: { openfootball: ["Racing Club de Lens"] } },
  { key: 'fra-brest', competitionSourceId: 'fr.1', name: "Brest", shortName: 'BRS', country: 'France', aliases: { openfootball: ["Stade Brestois 29"] } },
  { key: 'fra-rennes', competitionSourceId: 'fr.1', name: "Rennes", shortName: 'REN', country: 'France', aliases: { openfootball: ["Stade Rennais FC 1901"] } },
  { key: 'fra-reims', competitionSourceId: 'fr.1', name: "Reims", shortName: 'REI', country: 'France', aliases: { openfootball: ["Stade de Reims"] } },
  { key: 'fra-toulouse', competitionSourceId: 'fr.1', name: "Toulouse", shortName: 'TFC', country: 'France', aliases: { openfootball: ["Toulouse FC"] } },
];

export const CURATED_EPL_TEAMS: readonly CuratedTeam[] = EPL_TEAMS.map((t) =>
  API_FOOTBALL_NAMES[t.key] ? { ...t, aliases: { ...t.aliases, 'api-football': [API_FOOTBALL_NAMES[t.key]!] } } : t,
);

// Every club Nexora can identify, across all five competitions. The openfootball alias is the
// exact spelling that source prints; `name` and `shortName` are display only and never matched on.
// api-football spellings are curated for the Premier League only, so enrichment reports clubs in
// the other leagues as unresolved rather than binding them by guesswork.
export const CURATED_TEAMS: readonly CuratedTeam[] = [...CURATED_EPL_TEAMS, ...ESP_TEAMS, ...GER_TEAMS, ...ITA_TEAMS, ...FRA_TEAMS];
