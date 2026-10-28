// Core generation: fetch catalog, split into the 4 playlists, resolve & build M3U.

import { listChannels } from './api.js';
import { PLAYLISTS, getPlaylistByKey, sortByCategory } from './playlists.config.js';
import { buildM3U } from './m3u.js';

/**
 * Fetch the full channel catalog once, then compute each playlist's channel set.
 * Returns { catalog, sets: { key: channels[] } }.
 */
export async function planPlaylists() {
  const catalog = await listChannels();
  const sets = {};
  for (const p of PLAYLISTS) {
    const matched = catalog.filter(p.match);
    // Group by category (Entertainment, Kids, Infotainment, Lifestyle, ...) so the
    // numbering players assign follows CATEGORY_ORDER. The curated "kids-hindi"
    // playlist keeps its explicit hand-picked order instead.
    sets[p.key] = p.preserveOrder ? matched : sortByCategory(matched);
  }
  return { catalog, sets };
}

/**
 * Build M3U text for one playlist key.
 * Returns { key, title, file, text, stats }.
 */
export async function generateOne(key, channels, opts = {}) {
  const def = getPlaylistByKey(key);
  if (!def) throw new Error(`Unknown playlist key: ${key}`);
  const built = await buildM3U(channels, opts);
  return {
    key,
    title: def.title,
    file: def.file,
    text: built.text,
    stats: { ok: built.ok, failed: built.failed.length, skipped: built.skipped.length, total: built.total },
  };
}

/**
 * Build all playlists. Resolves each unique channel only once and reuses the
 * built block across playlists it belongs to (so "All" doesn't re-resolve).
 * Returns { outputs: [{key,title,file,text,stats}], catalogSize }.
 */
export async function generateAll({ concurrency = 8, log = () => {}, only } = {}) {
  const { catalog, sets } = await planPlaylists();
  log(`Catalog: ${catalog.length} channels`);

  const keys = only && only.length ? only : PLAYLISTS.map((p) => p.key);
  const outputs = [];
  for (const key of keys) {
    const channels = sets[key] || [];
    log(`Building "${key}" (${channels.length} channels)...`);
    const res = await generateOne(key, channels, {
      concurrency,
      onProgress: (d, t) => {
        if (d === t || d % 25 === 0) log(`  ${key}: ${d}/${t}`);
      },
    });
    log(
      `  "${key}" done: ok=${res.stats.ok} skipped=${res.stats.skipped} failed=${res.stats.failed}`,
    );
    outputs.push(res);
  }
  return { outputs, catalogSize: catalog.length };
}
