'use strict';

// NCAAB D1-vs-D1 filter (Kevin Oct 30 2026: men's college basketball starts with D1-vs-D1 games only).
// Kalshi KXNCAAMBGAME also lists D1 vs non-D1 games (Fisk, Bethesda, Reinhardt, Willamette ...). A game is
// kept only when BOTH team names resolve to a team in ncaab-d1-teams.json (ESPN groups=50, regenerate
// with scripts/gen-ncaab-crosswalk.js). Unknown names fail closed: the game is dropped, never guessed.

let D1 = require('./ncaab-d1-teams.json');
// Canonical NCAAB team table (ESPN id = identity, every venue's names as aliases): ncaab-teams.js / ncaab-teams.json.
const CANON = require('./ncaab-teams');

function normName(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019.]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').map((t) => (t === 'st' ? 'state' : t)).join(' ');
}

// Kalshi / Underdog / Polymarket spelling -> ESPN location (normalized both sides). Only names that differ.
const ALIASES = {
  'appalachian state': 'app state',
  'central connecticut state': 'central connecticut',
  'grambling state': 'grambling',
  liu: 'long island university',
  'long island': 'long island university',
  'louisiana monroe': 'ul monroe',
  'miami fl': 'miami',
  'miami florida': 'miami',
  'miami oh': 'miami oh',
  'miami ohio': 'miami oh',
  'new orleans': 'lsu new orleans',
  'queens university': 'queens university',
  queens: 'queens university',
  seattle: 'seattle u',
  'southern university': 'southern',
  'tennessee martin': 'ut martin',
  'usc upstate': 'south carolina upstate',
  'sc upstate': 'south carolina upstate',
  uconn: 'uconn',
  'connecticut': 'uconn',
  'ole miss': 'ole miss',
  'mississippi': 'ole miss',
  'nc state': 'nc state',
  'north carolina state': 'nc state',
  'texas a and m corpus christi': 'texas a and m corpus christi',
  'ualbany': 'ualbany',
  albany: 'ualbany',
  'university at albany': 'ualbany',
  'umass': 'massachusetts',
  'massachusetts lowell': 'umass lowell',
  'saint marys': 'saint marys',
  'st marys': 'saint marys',
  'saint marys ca': 'saint marys',
  'st johns': 'st johns',
  'saint johns': 'st johns',
  'loyola chicago': 'loyola chicago',
  'loyola il': 'loyola chicago',
  'southern miss': 'southern miss',
  'southern mississippi': 'southern miss',
  'utsa': 'utsa',
  'ut san antonio': 'utsa',
  'utep': 'utep',
  'ut el paso': 'utep',
  'unc wilmington': 'unc wilmington',
  'uncw': 'unc wilmington',
  'pitt': 'pittsburgh',
  'detroit': 'detroit mercy',
  'purdue fort wayne': 'purdue fort wayne',
  'fort wayne': 'purdue fort wayne',
  'iupui': 'iu indianapolis',
  'iu indy': 'iu indianapolis',
  'omaha': 'omaha',
  'nebraska omaha': 'omaha',
  'little rock': 'little rock',
  'arkansas little rock': 'little rock',
  'texas rio grande valley': 'ut rio grande valley',
  utrgv: 'ut rio grande valley',
  'cal state northridge': 'cal state northridge',
  csun: 'cal state northridge',
  'southeast missouri state': 'southeast missouri state',
  'semo': 'southeast missouri state',
  'texas a and m commerce': 'east texas a and m',
  'mcneese state': 'mcneese',
  'nicholls state': 'nicholls',
  'sam houston state': 'sam houston',
  'saint francis pa': 'saint francis',
  'st francis pa': 'saint francis',
  'st thomas minnesota': 'st thomas',
  'st thomas mn': 'st thomas',
  'william and mary': 'william and mary',
  'hawaii': 'hawaii',
  'k state': 'kansas state',
  'la tech': 'louisiana tech',
  'nm state': 'new mexico state',
  'southeastern louisiana': 'se louisiana',
};
// Keys and values go through normName too ("st" -> "state"), so "St. Thomas (MN)" finds 'st thomas mn'.
const ALIAS_N = new Map(Object.entries(ALIASES).map(([k, v]) => [normName(k), normName(v)]));

let INDEX = null;
function buildIndex(teams) {
  const names = new Map();
  const abbrs = new Map();
  const ids = new Map();
  for (const t of teams || []) {
    ids.set(String(t.espnId), t);
    for (const v of [t.location, t.short, t.display, t.location && t.name ? `${t.location} ${t.name}` : '']) {
      const n = normName(v);
      if (n && !names.has(n)) names.set(n, t);
    }
    if (t.abbr) abbrs.set(t.abbr, t);
  }
  return { names, abbrs, ids };
}
function index() {
  if (!INDEX) INDEX = buildIndex(D1.teams);
  return INDEX;
}
// The generator swaps in a freshly fetched list before building the crosswalk (and then skips the canonical
// table, so the old generator's output depends on its own inputs only).
let useCanon = true;
function useTeams(teams) { D1 = { teams }; INDEX = null; useCanon = false; }
function canonTeam(id) {
  const t = CANON.team(id); if (!t) return null;
  return { espnId: t.espnId, abbr: t.abbr, location: t.location, short: t.short, display: t.display, name: t.mascot };
}

// The D1 team for a display name ("Grambling St.", "Miami (FL)", "Villanova Wildcats"), or null.
function d1Team(name) {
  const { names } = index();
  const n = normName(name);
  if (!n) return null;
  const direct = names.get(n) || names.get(ALIAS_N.get(n) || '');
  if (direct) return direct;
  // Canonical table: any venue's known spelling of a D1 school (exact alias, never fuzzy). A name two schools
  // share, or a non-D1 school's name, stays null (fail closed).
  if (useCanon) {
    const r = CANON.resolveTeam('any', { name });
    if (r.espnId) return index().ids.get(r.espnId) || canonTeam(r.espnId);
  }
  return null;
}

function isD1Team(name) {
  return !!d1Team(name);
}

// Both sides D1 (by name). Any unknown side = not D1-vs-D1.
function isD1Game(away, home) {
  const a = d1Team(away);
  const h = d1Team(home);
  return !!(a && h && a.espnId !== h.espnId);
}

const teamById = (id) => index().ids.get(String(id || '')) || null;

module.exports = { normName, ALIASES, d1Team, isD1Team, isD1Game, teamById, useTeams, buildIndex, D1_TEAM_COUNT: (D1.teams || []).length };
