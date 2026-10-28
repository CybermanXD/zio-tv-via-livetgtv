// Definitions for the 4 playlists this project keeps up to date.
//
// The livetgtv API exposes `category` (e.g. "English", "Kids", "News", "Tamil"...)
// but it has NO dedicated "Hindi" category and no language field. Hindi channels
// are therefore detected heuristically from the channel name plus by EXCLUDING
// categories that are clearly another language/region.
//
// Each playlist has a `match(channel)` predicate run over the base channel list
// (id, name, category, logo). Keep predicates cheap — they run on ~1200 channels.

// Categories that denote a specific non-Hindi language/region. Used to keep the
// "Hindi" playlists clean (a channel in these categories is not treated as Hindi
// unless its name explicitly says Hindi).
const OTHER_LANGUAGE_CATEGORIES = new Set([
  'Tamil',
  'Telugu',
  'Malayalam',
  'Malyalam',
  'Bengali',
  'Punjabi',
  'Gujarati',
  'Kannada',
  'Marathi',
  'Assamese',
  'Odia',
  'Urdu',
  'Bhojpuri',
  'Nepali',
  'French',
  'English',
]);

const nameHasHindi = (name) => /\bhindi\b/i.test(name || '');

const nameHasOtherLanguage = (name) =>
  /\b(tamil|telugu|malayalam|bengali|punjabi|gujarati|kannada|marathi|assamese|odia|urdu|bhojpuri|nepali|english|french|kokborok)\b/i.test(
    name || '',
  );

/** Heuristic: is this channel a Hindi channel? */
export function isHindi(ch) {
  const cat = ch.category || '';
  const name = ch.name || '';
  if (nameHasHindi(name)) return true; // explicit "Hindi" in the name wins
  if (OTHER_LANGUAGE_CATEGORIES.has(cat)) return false; // clearly another language
  if (nameHasOtherLanguage(name)) return false; // name says another language
  // Remaining: generic Indian categories (News, Entertainment, Movies, Music,
  // Devotional, Kids, Infotainment, Lifestyle, Sports, Business News, Unknown...)
  // These are predominantly Hindi/Hindustani on JioTV, so treat as Hindi.
  return true;
}

// Curated Hindi-Kids set (explicit IDs). The API's "Kids" category misses a few
// (e.g. "ZB Cartoon" is categorised "Unknown"), so we pin the exact line-up.
export const KIDS_HINDI_IDS = [
  '3436', // Cartoon Network HD+ Hindi
  '816', // Cartoon Network Hindi
  '554', // Discovery Kids Hindi
  '1373', // Disney Channel
  '1375', // Disney International HD
  '1374', // Disney Junior
  '3385', // Gubbare
  '1391', // Hungama
  '545', // Nick Hindi
  '548', // Nickelodeon Jr.
  '559', // Pogo Hindi
  '2774', // Power Kids TV
  '815', // Sonic Hindi
  '872', // Sony Yay Hindi
  '1392', // Super Hungama
  '3321', // ZB Cartoon
];
const KIDS_HINDI_SET = new Set(KIDS_HINDI_IDS);

export const PLAYLISTS = [
  {
    key: 'english',
    file: 'english.m3u',
    title: 'Zio TV — English',
    match: (ch) => (ch.category || '').toLowerCase() === 'english',
  },
  {
    key: 'hindi',
    file: 'hindi.m3u',
    title: 'Zio TV — Hindi',
    match: (ch) => isHindi(ch),
  },
  {
    key: 'all',
    file: 'all.m3u',
    title: 'Zio TV — All Channels',
    match: () => true,
  },
  {
    key: 'kids-hindi',
    file: 'kids-hindi.m3u',
    title: 'Zio TV — Kids (Hindi)',
    // Curated explicit line-up (16 channels) rather than category heuristic.
    match: (ch) => KIDS_HINDI_SET.has(String(ch.id)),
  },
];

export function getPlaylistByKey(key) {
  return PLAYLISTS.find((p) => p.key === key);
}
