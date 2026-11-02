// Builds TiviMate/OTT Navigator-compatible M3U text from resolved channels.

import { resolveChannel } from './api.js';

// EPG (XMLTV) source advertised in the #EXTM3U header via `url-tvg`, so players
// (TiviMate / OTT Navigator) auto-load the guide and map it by tvg-id. Our
// tvg-id values are the livetgtv/JioTV numeric channel IDs, which match these
// JioTV XMLTV guides. Default is the compact avkb mirror (~1.6 MB gzipped,
// matches ~85% of our channels); override with ZIO_EPG_URL. Multiple URLs can
// be comma-separated.
export const EPG_URL =
  process.env.ZIO_EPG_URL || 'https://avkb.short.gy/jioepg.xml.gz';

/** Normalise DRM into { type, pairs:[[kid,key],...] } or null. */
export function extractClearKeys(drm) {
  if (!drm) return null;
  const type = (drm.type || '').toLowerCase();
  if (type && type !== 'clearkey') return { type, unsupported: true };
  if (drm.clearKeys && typeof drm.clearKeys === 'object') {
    const pairs = Object.entries(drm.clearKeys);
    if (pairs.length) return { type: 'clearkey', pairs };
  }
  if (drm.keyId && drm.key) return { type: 'clearkey', pairs: [[drm.keyId, drm.key]] };
  return null;
}

/**
 * JioTV/Akamai protects segments with an `__hdnea__` token. Placed only on the
 * manifest URL's query string it authorises the .mpd but NOT the relative
 * segment URLs (which drop the query) -> every segment returns HTTP 403, so the
 * manifest loads but nothing plays. The token's ACL is `/*`, and Akamai also
 * accepts it as a Cookie, so sending it as a Cookie header on ALL requests
 * (manifest + segments) fixes playback. We emit it via inputstream.adaptive
 * stream/manifest headers so TiviMate/OTT Navigator/Kodi attach it everywhere.
 */
function extractHdneaToken(src) {
  try {
    const q = new URL(src).search.slice(1); // e.g. __hdnea__=st=...~exp=...~acl=/*~hmac=...
    if (/__hdnea__=/.test(q)) return q;
  } catch {
    /* ignore */
  }
  return null;
}

const PLAYBACK_USER_AGENT = 'ExoPlayerLib/2.19.1';

function base64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Convert a Jio URL into the restricted relay URL used by Node/Worker proxies. */
export function proxyStreamUrl(src, proxyBase) {
  if (!proxyBase) return null;
  const parsed = new URL(src);
  const token = extractHdneaToken(src);
  if (parsed.hostname !== 'jiotvmblive.cdn.jio.com' || !token) return null;
  return `${proxyBase.replace(/\/+$/, '')}/jio/${base64Url(token)}${parsed.pathname}`;
}

/**
 * Build one #EXTINF block (array of lines) for an already-resolved channel.
 * @param {object} resolved  resolved channel from the API
 * @param {object} fallback  base channel (name/category/logo fallbacks)
 * @param {object} options   optional { proxyBase }
 */
export function channelBlock(resolved, fallback = {}, { proxyBase = process.env.ZIO_PROXY_BASE || '' } = {}) {
  const name = resolved.name || fallback.name || resolved.id;
  const group = resolved.category || fallback.category || 'Live';
  const logo = resolved.logo || fallback.logo || '';
  const src = (resolved.sources && resolved.sources[0]) || '';
  if (!src) return null;

  const ck = extractClearKeys(resolved.drm);
  if (ck && ck.unsupported) return null; // Widevine/PlayReady -> not playable in IPTV players

  const lines = [];
  lines.push('#KODIPROP:inputstream.adaptive.manifest_type=mpd');
  if (ck && ck.pairs) {
    const keyStr = ck.pairs.map(([kid, key]) => `${kid}:${key}`).join(',');
    lines.push('#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey');
    lines.push(`#KODIPROP:inputstream.adaptive.license_key=${keyStr}`);
  }

  // Forward the Akamai token as a Cookie on manifest AND segment requests.
  // Works in TiviMate/OTT Navigator/Kodi (which honour stream_headers).
  const token = extractHdneaToken(src);
  if (token) {
    // Kodi syntax: include both required headers in manifest and segment calls.
    const headers = `User-Agent=${encodeURIComponent(PLAYBACK_USER_AGENT)}&Cookie=${encodeURIComponent(token)}`;
    lines.push(`#KODIPROP:inputstream.adaptive.manifest_headers=${headers}`);
    lines.push(`#KODIPROP:inputstream.adaptive.stream_headers=${headers}`);
  }

  lines.push(
    `#EXTINF:-1 tvg-id="${resolved.id}" tvg-name="${name}" tvg-logo="${logo}" group-title="${group}",${name}`,
  );
  lines.push(`#EXTVLCOPT:http-user-agent=${PLAYBACK_USER_AGENT}`);
  lines.push(`#EXTHTTP:{"User-Agent":"${PLAYBACK_USER_AGENT}"}`);

  const proxied = proxyStreamUrl(src, proxyBase);
  if (proxied) {
    // The relay is required by HTML5/Shaka clients, which cannot override the
    // browser User-Agent, and by players that ignore M3U header directives.
    lines.push(proxied);
  } else {
    // ffmpeg/OTT-style pipe headers provide compatibility beyond EXTVLCOPT.
    lines.push(`${src}|User-Agent=${encodeURIComponent(PLAYBACK_USER_AGENT)}`);
  }
  return lines;
}

/** Simple concurrency-limited map. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Resolve a list of base channels and build M3U text.
 * Each channel is resolved ONCE.
 *
 * Returns { text, ok, failed, skipped, total }.
 */
export async function buildM3U(channels, { concurrency = 8, onProgress, proxyBase = process.env.ZIO_PROXY_BASE || '' } = {}) {
  let done = 0;
  const results = await mapLimit(channels, concurrency, async (ch) => {
    try {
      const resolved = await resolveChannel(ch.id);
      const direct = channelBlock(resolved, ch, { proxyBase });
      done++;
      if (onProgress) onProgress(done, channels.length);
      if (!direct) return { status: 'skipped', id: ch.id, name: ch.name };
      return { status: 'ok', id: ch.id, name: ch.name, direct };
    } catch (e) {
      done++;
      if (onProgress) onProgress(done, channels.length);
      return { status: 'failed', id: ch.id, name: ch.name, error: e.message };
    }
  });

  const lines = [EPG_URL ? `#EXTM3U url-tvg="${EPG_URL}"` : '#EXTM3U'];
  let ok = 0;
  const failed = [];
  const skipped = [];
  for (const r of results) {
    if (r.status === 'ok') {
      lines.push(...r.direct);
      ok++;
    } else if (r.status === 'failed') {
      failed.push(r);
    } else {
      skipped.push(r);
    }
  }
  return {
    text: lines.join('\n') + '\n',
    ok,
    failed,
    skipped,
    total: channels.length,
  };
}
