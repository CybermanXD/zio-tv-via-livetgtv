// Builds TiviMate/Televizo-compatible M3U text from resolved channels.

import { resolveChannel } from './api.js';

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

// Optional proxy base (e.g. a Cloudflare Worker) that injects the Akamai token
// into manifest + segment requests server-side. When set, a parallel "proxy"
// playlist is produced pointing each channel at `${PROXY_BASE}/mpd/<id>` instead
// of the raw JioTV manifest, so the stream plays in players that DON'T forward
// auth headers (Televizo/ExoPlayer, VLC). The stable ClearKey is still embedded
// for in-player decryption. The DIRECT playlist is always produced too.
export const PROXY_BASE = (process.env.ZIO_PROXY_BASE || '').replace(/\/+$/, '');

/**
 * Build one #EXTINF block (array of lines) for an already-resolved channel.
 * @param {object} resolved  resolved channel from the API
 * @param {object} fallback  base channel (name/category/logo fallbacks)
 * @param {object} [opts]
 * @param {'direct'|'proxy'} [opts.mode='direct']  URL style to emit
 * @param {string} [opts.proxyBase]  proxy origin for mode='proxy'
 */
export function channelBlock(resolved, fallback = {}, opts = {}) {
  const mode = opts.mode || 'direct';
  const proxyBase = (opts.proxyBase ?? PROXY_BASE) || '';
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

  if (mode === 'proxy') {
    if (!proxyBase) return null; // can't build a proxy block without a base
    // Point at the always-on proxy (Worker). It resolves a fresh token per play
    // and proxies segments, so NO player needs to forward auth headers.
    lines.push(
      `#EXTINF:-1 tvg-id="${resolved.id}" tvg-logo="${logo}" group-title="${group}",${name}`,
    );
    lines.push(`${proxyBase}/mpd/${encodeURIComponent(resolved.id)}`);
    return lines;
  }

  // Direct mode: forward the Akamai token as a Cookie on manifest AND segment
  // requests. Works in TiviMate/OTT Navigator (which honour stream_headers) but
  // NOT Televizo/ExoPlayer — use the proxy playlist for universal playback.
  const token = extractHdneaToken(src);
  if (token) {
    const cookie = 'Cookie=' + encodeURIComponent(token);
    lines.push(`#KODIPROP:inputstream.adaptive.manifest_headers=${cookie}`);
    lines.push(`#KODIPROP:inputstream.adaptive.stream_headers=${cookie}`);
  }

  lines.push(
    `#EXTINF:-1 tvg-id="${resolved.id}" tvg-logo="${logo}" group-title="${group}",${name}`,
  );
  lines.push('#EXTVLCOPT:http-user-agent=Mozilla/5.0');
  lines.push(src);
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
 *
 * Each channel is resolved ONCE. We always build the `direct` block, and — when
 * a proxy base is configured (opts.proxyBase or ZIO_PROXY_BASE) — the `proxy`
 * block too, so both playlists come from the same (short-lived) token fetch.
 *
 * Returns { text, proxyText, ok, failed, skipped, total }.
 * `proxyText` is null when no proxy base is set.
 */
export async function buildM3U(channels, { concurrency = 8, onProgress, proxyBase } = {}) {
  const base = (proxyBase ?? PROXY_BASE) || '';
  let done = 0;
  const results = await mapLimit(channels, concurrency, async (ch) => {
    try {
      const resolved = await resolveChannel(ch.id);
      const direct = channelBlock(resolved, ch, { mode: 'direct' });
      const proxy = base ? channelBlock(resolved, ch, { mode: 'proxy', proxyBase: base }) : null;
      done++;
      if (onProgress) onProgress(done, channels.length);
      if (!direct) return { status: 'skipped', id: ch.id, name: ch.name };
      return { status: 'ok', id: ch.id, name: ch.name, direct, proxy };
    } catch (e) {
      done++;
      if (onProgress) onProgress(done, channels.length);
      return { status: 'failed', id: ch.id, name: ch.name, error: e.message };
    }
  });

  const lines = ['#EXTM3U'];
  const proxyLines = ['#EXTM3U'];
  let ok = 0;
  const failed = [];
  const skipped = [];
  for (const r of results) {
    if (r.status === 'ok') {
      lines.push(...r.direct);
      if (base && r.proxy) proxyLines.push(...r.proxy);
      ok++;
    } else if (r.status === 'failed') {
      failed.push(r);
    } else {
      skipped.push(r);
    }
  }
  return {
    text: lines.join('\n') + '\n',
    proxyText: base ? proxyLines.join('\n') + '\n' : null,
    ok,
    failed,
    skipped,
    total: channels.length,
  };
}
