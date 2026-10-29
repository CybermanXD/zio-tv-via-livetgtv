// Thin client for the livetgtv public API (open, CORS-enabled, no key).
// Docs: https://livetgtv.lovable.app/docs

const BASE = process.env.ZIO_API_BASE || 'https://livetgtv.lovable.app/api/public';

// Manual category reassignments by channel id. The upstream API mislabels a few
// channels; we override so grouping/numbering is correct in EVERY playlist.
// e.g. Animax is served as "English" but belongs under Kids.
export const CATEGORY_OVERRIDES = {
  2258: 'Kids', // Animax
};

/** Apply CATEGORY_OVERRIDES to a channel-like object (returns the same object). */
export function applyCategoryOverride(ch) {
  if (ch && ch.id != null) {
    const o = CATEGORY_OVERRIDES[String(ch.id)];
    if (o) ch.category = o;
  }
  return ch;
}

async function getJson(url, { timeoutMs = 20000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'zio-tv/1.0' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Full channel list. Optional { category, q } filters are passed server-side. */
export async function listChannels({ category, q } = {}) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (q) params.set('q', q);
  const qs = params.toString();
  const data = await getJson(`${BASE}/channels${qs ? '?' + qs : ''}`);
  return (data.channels || []).map(applyCategoryOverride);
}

/**
 * Resolve one channel into playable sources + DRM.
 * Returns { id, name, category, logo, sources:[...], drm:{...} }.
 * Call right before playback — tokens/keys are short-lived.
 */
export async function resolveChannel(id) {
  const data = await getJson(`${BASE}/channels/${encodeURIComponent(id)}`, {
    timeoutMs: 20000,
    retries: 1,
  });
  return applyCategoryOverride(data);
}

export { BASE as API_BASE };
