// Zio TV — shared proxy core (used by BOTH the Worker and the Pages Function)
//
// Solves the Televizo/ExoPlayer black-screen problem WITHOUT a local PC:
//   JioTV ClearKey DASH segments are gated by an Akamai `__hdnea__` token.
//   Players like Televizo don't forward auth headers to segments -> HTTP 403 ->
//   black screen. A browser works because Akamai sets the token as a cookie.
//
//   This core reproduces the browser: it serves a rewritten manifest whose
//   segments point back at this origin, then proxies each segment upstream WITH
//   the token injected. The player only ever sees plain URLs, so it plays in
//   EVERY player (Televizo, VLC, TiviMate, Kodi...). ClearKey decryption still
//   happens in the player.
//
// Routes (origin-agnostic — works on *.workers.dev and *.pages.dev):
//   GET /                     help text
//   GET /p/<key>.m3u          proxied playlist (english|hindi|all|kids-hindi)
//   GET /mpd/<id>             rewritten manifest for a channel
//   GET /seg/<id>/<path...>   segment proxied with the Akamai token

const API_BASE = 'https://livetgtv.lovable.app/api/public';
const UA = 'Mozilla/5.0';

// ---- Playlist definitions (ported from src/playlists.config.js) ----
const OTHER_LANGUAGE_CATEGORIES = new Set([
  'Tamil', 'Telugu', 'Malayalam', 'Malyalam', 'Bengali', 'Punjabi', 'Gujarati',
  'Kannada', 'Marathi', 'Assamese', 'Odia', 'Urdu', 'Bhojpuri', 'Nepali',
  'French', 'English',
]);
const nameHasHindi = (n) => /\bhindi\b/i.test(n || '');
const nameHasOther = (n) =>
  /\b(tamil|telugu|malayalam|bengali|punjabi|gujarati|kannada|marathi|assamese|odia|urdu|bhojpuri|nepali|english|french|kokborok)\b/i.test(
    n || '',
  );
function isHindi(ch) {
  const name = ch.name || '';
  if (nameHasHindi(name)) return true;
  if (OTHER_LANGUAGE_CATEGORIES.has(ch.category || '')) return false;
  if (nameHasOther(name)) return false;
  return true;
}
const KIDS_HINDI_IDS = new Set([
  '3436', '816', '554', '1373', '1375', '1374', '3385', '1391', '545', '548',
  '559', '2774', '815', '872', '1392', '3321',
]);
const PLAYLISTS = {
  english: { title: 'Zio TV — English', match: (c) => (c.category || '').toLowerCase() === 'english' },
  hindi: { title: 'Zio TV — Hindi', match: isHindi },
  all: { title: 'Zio TV — All Channels', match: () => true },
  'kids-hindi': { title: 'Zio TV — Kids (Hindi)', match: (c) => KIDS_HINDI_IDS.has(String(c.id)) },
};

// ---- Helpers ----
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'zio-tv/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.json();
}
function tokenFromUrl(u) {
  try {
    const q = new URL(u).search.slice(1);
    return /__hdnea__=/.test(q) ? q : null;
  } catch {
    return null;
  }
}
function clearKeyPairs(drm) {
  if (!drm) return null;
  const type = (drm.type || '').toLowerCase();
  if (type && type !== 'clearkey') return { unsupported: true };
  if (drm.clearKeys && typeof drm.clearKeys === 'object') {
    const pairs = Object.entries(drm.clearKeys);
    if (pairs.length) return { pairs };
  }
  if (drm.keyId && drm.key) return { pairs: [[drm.keyId, drm.key]] };
  return null;
}

// Resolve a channel into { token, base, mpdText, drm, name, logo, category }.
async function resolveInfo(id) {
  const r = await getJson(`${API_BASE}/channels/${encodeURIComponent(id)}`);
  const mpdUrl = (r.sources && r.sources[0]) || '';
  if (!mpdUrl) throw new Error('no source for ' + id);
  const mr = await fetch(mpdUrl, { headers: { 'User-Agent': UA } });
  const mpdText = await mr.text();
  const relBase = (mpdText.match(/<BaseURL>([^<]*)<\/BaseURL>/i)?.[1] || '').trim();
  const base = new URL(relBase || './', mpdUrl).href;
  return {
    id: String(id),
    token: tokenFromUrl(mpdUrl),
    base,
    mpdText,
    drm: r.drm,
    name: r.name,
    logo: r.logo,
    category: r.category,
  };
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  };
}

function buildManifest(info, selfOrigin) {
  const proxiedBase = `${selfOrigin}/seg/${encodeURIComponent(info.id)}/`;
  let mpd = info.mpdText;
  if (/<BaseURL>[^<]*<\/BaseURL>/i.test(mpd)) {
    mpd = mpd.replace(/<BaseURL>[^<]*<\/BaseURL>/i, `<BaseURL>${proxiedBase}</BaseURL>`);
  } else {
    mpd = mpd.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${proxiedBase}</BaseURL>`);
  }
  return mpd;
}

function channelBlock(info, selfOrigin) {
  const ck = clearKeyPairs(info.drm);
  if (ck && ck.unsupported) return null;
  const lines = ['#KODIPROP:inputstream.adaptive.manifest_type=mpd'];
  if (ck && ck.pairs) {
    const keyStr = ck.pairs.map(([k, v]) => `${k}:${v}`).join(',');
    lines.push('#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey');
    lines.push(`#KODIPROP:inputstream.adaptive.license_key=${keyStr}`);
  }
  lines.push(
    `#EXTINF:-1 tvg-id="${info.id}" tvg-logo="${info.logo || ''}" group-title="${
      info.category || 'Live'
    }",${info.name || info.id}`,
  );
  lines.push(`${selfOrigin}/mpd/${encodeURIComponent(info.id)}`);
  return lines;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/**
 * Origin-agnostic request handler shared by the Worker and Pages Function.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const selfOrigin = url.origin;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    // Help page
    if (path === '/' || path === '/index.html') {
      const body =
        'Zio TV — token-injection proxy (always-on).\n\n' +
        'Playlists are hosted on GitHub and already point here:\n' +
        Object.keys(PLAYLISTS).map((k) => `  /p/${k}.m3u  (small playlists only)`).join('\n') +
        '\n\nEndpoints used by players:\n' +
        `  ${selfOrigin}/mpd/<channelId>\n  ${selfOrigin}/seg/<channelId>/<path>\n`;
      return new Response(body, { headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }) });
    }

    // Rewritten manifest
    if (path.startsWith('/mpd/')) {
      const id = decodeURIComponent(path.slice('/mpd/'.length));
      const info = await resolveInfo(id);
      const mpd = buildManifest(info, selfOrigin);
      return new Response(mpd, {
        headers: corsHeaders({ 'Content-Type': 'application/dash+xml', 'Cache-Control': 'no-store' }),
      });
    }

    // Segment proxy (inject token upstream)
    if (path.startsWith('/seg/')) {
      const rest = path.slice('/seg/'.length);
      const slash = rest.indexOf('/');
      const id = decodeURIComponent(rest.slice(0, slash));
      const segPath = rest.slice(slash + 1);
      let info = await resolveInfo(id);
      let target = new URL(segPath, info.base).href;
      let up = await fetch(target, {
        headers: { 'User-Agent': UA, ...(info.token ? { Cookie: info.token } : {}) },
      });
      if (up.status === 403) {
        info = await resolveInfo(id);
        target = new URL(segPath, info.base).href;
        up = await fetch(target, {
          headers: { 'User-Agent': UA, ...(info.token ? { Cookie: info.token } : {}) },
        });
      }
      return new Response(up.body, {
        status: up.status,
        headers: corsHeaders({
          'Content-Type': up.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'no-store',
        }),
      });
    }

    // Proxied playlist
    if (path.startsWith('/p/')) {
      const key = path.slice('/p/'.length).replace(/\.m3u$/, '');
      const def = PLAYLISTS[key];
      if (!def) return new Response('not found', { status: 404, headers: corsHeaders() });
      const data = await getJson(`${API_BASE}/channels`);
      const channels = (data.channels || []).filter(def.match);
      const blocks = await mapLimit(channels, 12, async (ch) => {
        try {
          const info = await resolveInfo(ch.id);
          return channelBlock(info, selfOrigin);
        } catch {
          return null;
        }
      });
      const lines = ['#EXTM3U'];
      for (const b of blocks) if (b) lines.push(...b);
      return new Response(lines.join('\n') + '\n', {
        headers: corsHeaders({
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store',
        }),
      });
    }

    return new Response('not found', { status: 404, headers: corsHeaders() });
  } catch (e) {
    return new Response('error: ' + (e?.message || e), {
      status: 502,
      headers: corsHeaders({ 'Content-Type': 'text/plain' }),
    });
  }
}
