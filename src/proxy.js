// Universal segment proxy for JioTV/Akamai ClearKey DASH.
//
// Why this exists:
//   The streams are ClearKey-encrypted DASH whose SEGMENTS are gated by an
//   Akamai `__hdnea__` token. Players like Televizo (ExoPlayer) do NOT forward
//   `inputstream.adaptive.stream_headers` to segment requests, so segments
//   return HTTP 403 -> black screen / "No data" even though the manifest and
//   ClearKey license are accepted.
//
//   A browser works because Akamai sets `__hdnea__` as a cookie that the
//   browser auto-attaches to every segment. This proxy reproduces that: it
//   rewrites the manifest so every segment points back at us, then fetches the
//   real segment upstream WITH the token. The player therefore only ever sees
//   plain, unauthenticated-looking HTTP URLs — so it works in EVERY player.
//
//   ClearKey decryption still happens in the player (unchanged). We only solve
//   the 403 segment-auth problem.

import { resolveChannel, listChannels } from './api.js';
import { extractClearKeys } from './m3u.js';
import { PLAYLISTS } from './playlists.config.js';

const UA = 'Mozilla/5.0';

// channelId -> { token, upstreamBase, mpdUrl, drm, name, logo, category, at }
const chCache = new Map();
const CH_TTL = 4 * 60 * 1000; // re-resolve token every 4 min (tokens are short-lived)

function tokenFromUrl(u) {
  try {
    const q = new URL(u).search.slice(1);
    return /__hdnea__=/.test(q) ? q : null;
  } catch {
    return null;
  }
}

/** Resolve a channel (cached) into { token, upstreamBase, mpdUrl, drm, ... }. */
export async function getChannelInfo(id, { force = false } = {}) {
  const hit = chCache.get(id);
  if (!force && hit && Date.now() - hit.at < CH_TTL) return hit;

  const r = await resolveChannel(id);
  const mpdUrl = (r.sources && r.sources[0]) || '';
  if (!mpdUrl) throw new Error('no source for channel ' + id);

  // Fetch the manifest to learn its BaseURL so we know the real segment base.
  const mr = await fetch(mpdUrl, { headers: { 'User-Agent': UA } });
  const mpdText = await mr.text();
  const baseM = mpdText.match(/<BaseURL>([^<]*)<\/BaseURL>/i);
  const relBase = baseM ? baseM[1].trim() : '';
  // Real absolute base the player would use for segments.
  const upstreamBase = new URL(relBase || '.', mpdUrl).href.replace(/[^/]*$/, (m) =>
    relBase ? m : '',
  );
  // Prefer a precise join: directory of mpd + relBase.
  const resolvedBase = new URL(relBase || './', mpdUrl).href;

  const info = {
    id: String(id),
    token: tokenFromUrl(mpdUrl),
    upstreamBase: resolvedBase, // e.g. https://.../WDVLive/dash/
    mpdUrl,
    mpdText,
    drm: r.drm,
    name: r.name,
    logo: r.logo,
    category: r.category,
    at: Date.now(),
  };
  void upstreamBase;
  chCache.set(id, info);
  return info;
}

/** Build the rewritten manifest whose segments point at `${selfBase}/seg/<id>/`. */
export async function buildProxiedManifest(id, selfBase) {
  const info = await getChannelInfo(id);
  let mpd = info.mpdText;
  const proxiedBase = `${selfBase}/seg/${encodeURIComponent(id)}/`;

  if (/<BaseURL>[^<]*<\/BaseURL>/i.test(mpd)) {
    mpd = mpd.replace(/<BaseURL>[^<]*<\/BaseURL>/i, `<BaseURL>${proxiedBase}</BaseURL>`);
  } else {
    // Insert a BaseURL right after the <MPD ...> open tag.
    mpd = mpd.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${proxiedBase}</BaseURL>`);
  }
  return mpd;
}

/** Proxy a single segment: fetch upstream with the token, stream bytes back. */
export async function fetchSegment(id, segPath) {
  let info = await getChannelInfo(id);
  const target = new URL(segPath, info.upstreamBase).href;

  async function tryFetch(cookie) {
    return fetch(target, {
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
    });
  }

  let resp = await tryFetch(info.token);
  if (resp.status === 403) {
    // Token likely expired — force re-resolve once and retry.
    info = await getChannelInfo(id, { force: true });
    const retryTarget = new URL(segPath, info.upstreamBase).href;
    resp = await fetch(retryTarget, {
      headers: { 'User-Agent': UA, ...(info.token ? { Cookie: info.token } : {}) },
    });
  }
  return resp;
}

/** Playlist line block for a proxied channel (manifest served by us). */
export function proxiedChannelBlock(info, selfBase) {
  const ck = extractClearKeys(info.drm);
  if (ck && ck.unsupported) return null;
  const lines = ['#KODIPROP:inputstream.adaptive.manifest_type=mpd'];
  if (ck && ck.pairs) {
    const keyStr = ck.pairs.map(([kid, key]) => `${kid}:${key}`).join(',');
    lines.push('#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey');
    lines.push(`#KODIPROP:inputstream.adaptive.license_key=${keyStr}`);
  }
  lines.push(
    `#EXTINF:-1 tvg-id="${info.id}" tvg-logo="${info.logo || ''}" group-title="${
      info.category || 'Live'
    }",${info.name || info.id}`,
  );
  lines.push(`${selfBase}/mpd/${encodeURIComponent(info.id)}`);
  return lines;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

/**
 * Build a proxied M3U for a playlist key. Each channel's manifest URL points at
 * our own server (`/mpd/<id>`); segments are proxied too, so NO player needs to
 * forward auth headers. Works in Televizo/ExoPlayer, VLC, TiviMate, etc.
 */
export async function buildProxiedPlaylist(key, selfBase, { concurrency = 8 } = {}) {
  const def = PLAYLISTS.find((p) => p.key === key);
  if (!def) throw new Error('unknown playlist key ' + key);
  const catalog = await listChannels();
  const channels = catalog.filter(def.match);

  const blocks = await mapLimit(channels, concurrency, async (ch) => {
    try {
      const info = await getChannelInfo(ch.id);
      return proxiedChannelBlock(info, selfBase);
    } catch {
      return null;
    }
  });

  const lines = ['#EXTM3U'];
  let ok = 0;
  for (const b of blocks) {
    if (b) {
      lines.push(...b);
      ok++;
    }
  }
  return { text: lines.join('\n') + '\n', ok, total: channels.length };
}
