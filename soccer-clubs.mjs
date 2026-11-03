// UEFA Champions League club identity. Books, Kalshi, Novig and Polymarket US
// spell the same club differently ("Bayern Munich" / "FC Bayern München",
// "PSG" / "Paris Saint-Germain", "Inter" / "Internazionale"). Matching is by
// club id, then by kickoff. "Inter Miami" is its own club and never Inter.
//
// Kalshi codes are this week's KXUCLGAME slate (Nov 3–4 2026) plus the short
// names those markets print. ESPN abbreviations are NOT the same codes
// (Kalshi Man United is MUN; ESPN uses MUN for Bayern), so schedule matching
// goes through the club id, not the raw abbreviation.

const CLUBS = [
  { id: 'psg', name: 'Paris Saint-Germain', aliases: ['psg', 'paris saint germain', 'paris sg', 'paris st germain'] },
  { id: 'bayern', name: 'Bayern Munich', aliases: ['bayern', 'bayern munich', 'bayern munchen', 'fc bayern', 'fc bayern munchen', 'fc bayern munich'] },
  { id: 'inter', name: 'Inter', aliases: ['inter', 'inter milan', 'internazionale', 'internazionale milano', 'fc internazionale', 'fc internazionale milano'] },
  { id: 'inter-miami', name: 'Inter Miami', aliases: ['inter miami', 'inter miami cf'] },
  { id: 'villarreal', name: 'Villarreal', aliases: ['villarreal', 'villarreal cf'] },
  { id: 'atletico', name: 'Atletico Madrid', aliases: ['atletico', 'atletico madrid', 'atletico de madrid', 'club atletico de madrid', 'club atletico madrid'] },
  { id: 'barcelona', name: 'Barcelona', aliases: ['barcelona', 'fc barcelona', 'barca'] },
  { id: 'astonvilla', name: 'Aston Villa', aliases: ['aston villa', 'aston villa fc'] },
  { id: 'manutd', name: 'Manchester United', aliases: ['manchester united', 'manchester utd', 'man utd', 'man united', 'manchester united fc'] },
  { id: 'mancity', name: 'Manchester City', aliases: ['manchester city', 'manchester city fc', 'man city'] },
  { id: 'roma', name: 'Roma', aliases: ['roma', 'as roma'] },
  { id: 'feyenoord', name: 'Feyenoord', aliases: ['feyenoord', 'feyenoord rotterdam'] },
  { id: 'galatasaray', name: 'Galatasaray', aliases: ['galatasaray', 'galatasaray spor kulubu'] },
  { id: 'stuttgart', name: 'Stuttgart', aliases: ['stuttgart', 'vfb stuttgart', 'vfb stuttgart 1893'] },
  { id: 'shakhtar', name: 'Shakhtar Donetsk', aliases: ['shakhtar', 'shakhtar donetsk', 'fc shakhtar donetsk'] },
  { id: 'sporting', name: 'Sporting CP', aliases: ['sporting', 'sporting cp', 'sporting lisbon', 'sporting portugal', 'sporting clube de portugal'] },
  { id: 'lask', name: 'LASK', aliases: ['lask', 'lask linz', 'linzer athletik sport klub'] },
  { id: 'slovan', name: 'Slovan Bratislava', aliases: ['slovan', 'slovan bratislava', 'sk slovan bratislava'] },
  { id: 'bodoglimt', name: 'Bodo/Glimt', aliases: ['bodo glimt', 'bodoe glimt', 'fk bodo glimt', 'fk bodoe glimt', 'bodo/glimt', 'bodoe/glimt'] },
  { id: 'lille', name: 'Lille', aliases: ['lille', 'lille osc', 'losc lille'] },
  { id: 'aek', name: 'AEK Athens', aliases: ['aek', 'aek athens', 'aek athens fc'] },
  { id: 'realmadrid', name: 'Real Madrid', aliases: ['real madrid', 'real madrid cf'] },
  { id: 'fenerbahce', name: 'Fenerbahce', aliases: ['fenerbahce', 'fenerbahce spor kulubu'] },
  { id: 'liverpool', name: 'Liverpool', aliases: ['liverpool', 'liverpool fc'] },
  { id: 'dortmund', name: 'Dortmund', aliases: ['dortmund', 'borussia dortmund', 'bv borussia dortmund', 'bv borussia 09 dortmund'] },
  { id: 'betis', name: 'Real Betis', aliases: ['betis', 'real betis', 'real betis balompie'] },
  { id: 'porto', name: 'Porto', aliases: ['porto', 'fc porto'] },
  { id: 'napoli', name: 'Napoli', aliases: ['napoli', 'ssc napoli'] },
  { id: 'psv', name: 'PSV Eindhoven', aliases: ['psv', 'psv eindhoven', 'eindhoven'] },
  { id: 'brugge', name: 'Club Brugge', aliases: ['brugge', 'club brugge', 'club brugge kv'] },
  { id: 'leipzig', name: 'RB Leipzig', aliases: ['leipzig', 'rb leipzig', 'rasenballsport leipzig'] },
  { id: 'lens', name: 'Lens', aliases: ['lens', 'rc lens', 'racing club de lens', 'racing lens'] },
  { id: 'como', name: 'Como', aliases: ['como', 'calcio como', 'calcio como 1907'] },
  { id: 'slavia', name: 'Slavia Prague', aliases: ['slavia', 'slavia prague', 'slavia praha', 'sk slavia praha'] },
  { id: 'arsenal', name: 'Arsenal', aliases: ['arsenal', 'arsenal fc'] },
  { id: 'viking', name: 'Viking', aliases: ['viking', 'viking fk'] },
  { id: 'sabah', name: 'Sabah', aliases: ['sabah', 'sabah fk', 'sabah masazir'] },
];

// Kalshi KXUCLGAME team code → club id. ESPN's abbreviation is often different.
const UCL_CODE_CLUB = {
  GAL: 'galatasaray', VFB: 'stuttgart', SHA: 'shakhtar', SPO: 'sporting',
  ASK: 'lask', SLO: 'slovan', ATM: 'atletico', BMU: 'bayern',
  BAR: 'barcelona', AVL: 'astonvilla', BOG: 'bodoglimt', LIL: 'lille',
  FEY: 'feyenoord', INT: 'inter', MUN: 'manutd', ROM: 'roma',
  VIL: 'villarreal', PSG: 'psg', AEK: 'aek', RMA: 'realmadrid',
  FEN: 'fenerbahce', LFC: 'liverpool', BVB: 'dortmund', RBB: 'betis',
  FCP: 'porto', NAP: 'napoli', PSV: 'psv', BRU: 'brugge',
  RBL: 'leipzig', MCI: 'mancity', RCL: 'lens', COM: 'como',
  SLA: 'slavia', ARS: 'arsenal', VIK: 'viking', SBH: 'sabah',
};

const UCL_CODES = Object.keys(UCL_CODE_CLUB).sort((a, b) => b.length - a.length);

const FILLER = new Set([
  'fc', 'cf', 'sc', 'afc', 'ac', 'sk', 'fk', 'kv', 'osc', 'ssc', 'bv', 'vfb', 'as',
  'de', 'the', 'club', 'spor', 'kulubu', 'calcio', 'balompie', 'clube',
]);

const BY_ALIAS = new Map();
const BY_ID = new Map();
for (const club of CLUBS) {
  BY_ID.set(club.id, club);
  for (const alias of club.aliases) {
    const key = stripName(alias);
    if (key && !BY_ALIAS.has(key)) BY_ALIAS.set(key, club.id);
  }
}

function fold(s) {
  return String(s || '')
    // ø/æ do not decompose under NFD ("Bodø" would become "bod", not "bodo").
    .replace(/ø/gi, 'o')
    .replace(/æ/gi, 'ae')
    .replace(/œ/gi, 'oe')
    .replace(/ł/gi, 'l')
    .replace(/đ/gi, 'd')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripName(s) {
  return fold(s)
    .split(' ')
    .filter((t) => t && !FILLER.has(t) && !/^\d{2,4}$/.test(t))
    .join(' ');
}

function tokensOf(s) {
  return stripName(s).split(' ').filter(Boolean);
}

function soccerClubId(name) {
  const key = stripName(name);
  if (!key) return null;
  if (BY_ALIAS.has(key)) return BY_ALIAS.get(key);
  return null;
}

function soccerClubName(id) {
  const club = BY_ID.get(id);
  return club ? club.name : null;
}

function clubTokenUnion(id) {
  const club = BY_ID.get(id);
  const set = new Set();
  if (!club) return set;
  for (const alias of club.aliases) for (const t of tokensOf(alias)) set.add(t);
  return set;
}

// Longest alias that sits in `text`. A one-word alias ("inter", "psg") does not
// match when the next word makes a different club ("inter miami").
function clubMentioned(text, id) {
  if (!id || !BY_ID.has(id)) return false;
  const tokens = tokensOf(text);
  if (!tokens.length) return false;
  const aliases = [...(BY_ID.get(id).aliases || [])].map((a) => tokensOf(a).filter(Boolean)).filter((a) => a.length);
  aliases.sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    for (let i = 0; i <= tokens.length - alias.length; i += 1) {
      if (!alias.every((t, k) => tokens[i + k] === t)) continue;
      if (alias.length === 1) {
        const next = tokens[i + 1];
        const prev = tokens[i - 1];
        const longer = (n) => (n ? (soccerClubId(`${alias[0]} ${n}`) || soccerClubId(`${n} ${alias[0]}`)) : null);
        if ((longer(next) && longer(next) !== id) || (longer(prev) && longer(prev) !== id)) continue;
      }
      return true;
    }
  }
  return false;
}

// true / false when both names are known clubs; null when either is unknown
// so the caller keeps its fuzzy matcher.
function soccerSameClub(a, b) {
  const ia = soccerClubId(a);
  const ib = soccerClubId(b);
  if (ia && ib) return ia === ib;
  return null;
}

function uclClubFromCode(code) {
  return UCL_CODE_CLUB[String(code || '').toUpperCase()] || null;
}

function uclCodeName(code) {
  return soccerClubName(uclClubFromCode(code));
}

// "VILPSG" → ["VIL", "PSG"]. Known codes only, so MUN (Man United) never
// splits as a prefix of a Bayern code.
function splitUclCodes(blob) {
  const s = String(blob || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return null;
  for (const a of UCL_CODES) {
    if (!s.startsWith(a)) continue;
    const rest = s.slice(a.length);
    if (UCL_CODE_CLUB[rest]) return [a, rest];
  }
  return null;
}

const SOCCER_GAME_SERIES = new Set([
  'KXUCLGAME', 'KXMLSGAME', 'KXEPLGAME', 'KXLALIGAGAME', 'KXSERIEAGAME', 'KXBUNDESLIGAGAME', 'KXLIGUE1GAME',
]);

function isUclGameTicker(ticker) {
  return /^KXUCLGAME-/i.test(String(ticker || ''));
}

function isSoccerGameSeries(seriesOrTicker) {
  const head = String(seriesOrTicker || '').toUpperCase().split('-')[0];
  return SOCCER_GAME_SERIES.has(head);
}

export {
  CLUBS,
  UCL_CODE_CLUB,
  FILLER,
  fold,
  stripName,
  tokensOf,
  soccerClubId,
  soccerClubName,
  clubTokenUnion,
  clubMentioned,
  soccerSameClub,
  uclClubFromCode,
  uclCodeName,
  splitUclCodes,
  SOCCER_GAME_SERIES,
  isUclGameTicker,
  isSoccerGameSeries,
};
