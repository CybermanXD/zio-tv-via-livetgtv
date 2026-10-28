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

/** Build one #EXTINF block (array of lines) for an already-resolved channel. */
export function channelBlock(resolved, fallback = {}) {
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
 * Returns { text, ok, failed, skipped }.
 */
export async function buildM3U(channels, { concurrency = 8, onProgress } = {}) {
  let done = 0;
  const results = await mapLimit(channels, concurrency, async (ch) => {
    try {
      const resolved = await resolveChannel(ch.id);
      const block = channelBlock(resolved, ch);
      done++;
      if (onProgress) onProgress(done, channels.length);
      if (!block) return { status: 'skipped', id: ch.id, name: ch.name };
      return { status: 'ok', id: ch.id, name: ch.name, block };
    } catch (e) {
      done++;
      if (onProgress) onProgress(done, channels.length);
      return { status: 'failed', id: ch.id, name: ch.name, error: e.message };
    }
  });

  const lines = ['#EXTM3U'];
  let ok = 0;
  const failed = [];
  const skipped = [];
  for (const r of results) {
    if (r.status === 'ok') {
      lines.push(...r.block);
      ok++;
    } else if (r.status === 'failed') {
      failed.push(r);
    } else {
      skipped.push(r);
    }
  }
  return { text: lines.join('\n') + '\n', ok, failed, skipped, total: channels.length };
}
