# Zio TV — Cloudflare Worker (always-on token proxy)

This tiny Worker is what makes the streams play in **Televizo / ExoPlayer, VLC,
Kodi** — not just TiviMate — **without running anything on your PC**.

## Why it's needed

JioTV streams are ClearKey-encrypted DASH whose **segments** are gated by an
Akamai `__hdnea__` token. Most players don't forward auth headers to segment
requests, so segments return **HTTP 403** → black screen / "No data".

GitHub Pages is static and can't inject that token. This Worker runs always-on
(Cloudflare free tier) and does the injection:

- `GET /mpd/<id>` – resolves the channel, returns a **rewritten manifest** whose
  segments point back at the Worker.
- `GET /seg/<id>/<path>` – fetches the real segment upstream **with the token**
  and streams it back. Auto-refreshes the token on 403.

The hosted GitHub playlists simply point each channel at `…/mpd/<id>`, and embed
the (stable) ClearKey for in-player decryption. The player only ever sees plain
URLs → works everywhere.

## One-time deploy (≈2 minutes)

You need a free Cloudflare account.

```bash
cd worker
npm install
npx wrangler login       # opens browser, authorise
npx wrangler deploy
```

`wrangler deploy` prints your live URL, e.g.:

```
https://zio-tv.<your-subdomain>.workers.dev
```

Quick check in a browser:

```
https://zio-tv.<your-subdomain>.workers.dev/mpd/143
```

You should see XML (a DASH manifest).

## Point the GitHub playlists at your Worker

1. GitHub repo → **Settings → Secrets and variables → Actions → Variables** tab
   → **New repository variable**.
2. Name: `ZIO_PROXY_BASE`  Value: `https://zio-tv.<your-subdomain>.workers.dev`
   (no trailing slash).
3. Actions tab → **Update IPTV playlists** → **Run workflow**.

The regenerated playlists now contain `…workers.dev/mpd/<id>` URLs.

## Use in Televizo

Add the hosted playlist URL (English example):

```
https://raw.githubusercontent.com/CybermanXD/zio-tv-via-livetgtv/main/playlists/english.m3u
```

That's it — plays in Televizo, VLC, TiviMate, Kodi. Nothing runs on your PC.

## Notes / limits

- Free Workers: 100,000 requests/day. A live DASH stream pulls a segment every
  few seconds, so one viewer ≈ a few thousand requests/hour — fine for personal
  use; many simultaneous viewers could exceed the free tier.
- Each Worker request may make ≤50 subrequests. `/mpd` and `/seg` make only 2–3
  each, so they're well within the limit. (Bulk `/p/<key>.m3u` exists for quick
  tests of the small kids-hindi list, but the real playlists are built on GitHub
  to avoid that limit.)
- `wrangler.toml` name is `zio-tv`; change it if you want a different subdomain.
