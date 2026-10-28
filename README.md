# Zio TV via livetgtv

Generates and keeps up to date **four** IPTV playlists for TiviMate / Televizo,
resolved live from the open [`livetgtv`](https://livetgtv.lovable.app/docs) public API.

> **Hosted mode (recommended):** push this folder to a GitHub repo named
> `zio tv via livetgtv`. A GitHub Actions cron regenerates the playlists **every
> 3 hours** and commits them, so you get permanent URLs you paste into your IPTV
> player — no PC needs to stay on. See [Host on GitHub](#host-on-github-auto-updates-every-3-hours).

The streams are **MPEG-DASH (`.mpd`) with ClearKey DRM**, which standard IPTV
players support via `inputstream.adaptive`. Each entry carries the correct
`#KODIPROP` ClearKey tags so the player can decrypt without any extra setup.

## The 4 playlists

| Key          | File             | Contents                                   |
|--------------|------------------|--------------------------------------------|
| `english`    | `english.m3u`    | All channels in the API's **English** category |
| `hindi`      | `hindi.m3u`      | All **Hindi** channels (heuristic — see below) |
| `all`        | `all.m3u`        | **Every** channel in the catalog           |
| `kids-hindi` | `kids-hindi.m3u` | Curated **16 Hindi kids** channels (explicit list) |

> There is no "Hindi" category in the API (only per-regional-language categories
> like Tamil/Telugu plus generic ones like News/Movies/Kids). The `hindi` playlist
> therefore includes any channel whose name says "Hindi" **plus** all generic
> Indian-category channels, while excluding channels whose category/name indicate
> another language (Tamil, Telugu, English, etc.). Tune this in
> [`src/playlists.config.js`](src/playlists.config.js).
>
> The `kids-hindi` playlist is a **pinned explicit line-up of 16 channels**
> (editable via `KIDS_HINDI_IDS` in the same file) because the "Kids" category
> misses a couple (e.g. *ZB Cartoon* is categorised "Unknown").

## Requirements

- Node.js 18+ (uses built-in `fetch`).
- For playback: an **Indian IP** — the JioTV CDN geo-restricts to India.

## Usage

### Generate files once

```bash
node src/index.js generate            # all 4 -> ./playlists
node src/index.js generate hindi all  # only selected playlists
```

(or double-click [`scripts/generate.bat`](scripts/generate.bat) on Windows)

Output files land in `./playlists/`. Tokens/keys are short-lived, so regenerate
before viewing — or use one of the always-fresh options below.

### Serve always-fresh playlists (recommended)

```bash
node src/index.js serve
```

(or [`scripts/serve.bat`](scripts/serve.bat))

It prints URLs like:

```
Zio TV — English            http://192.168.29.235:8888/english.m3u
Zio TV — Hindi              http://192.168.29.235:8888/hindi.m3u
Zio TV — All Channels       http://192.168.29.235:8888/all.m3u
Zio TV — Kids (Hindi)       http://192.168.29.235:8888/kids-hindi.m3u
```

Add those URLs in TiviMate/Televizo (device on the same Wi-Fi). Each fetch
re-resolves current tokens + ClearKeys. Responses are cached for 5 min
(`ZIO_TTL_MS`) so refreshing is fast and easy on the API.

### Keep files refreshed on disk

If your player reads local/synced files instead of a URL:

```bash
node src/watch.js            # regenerates ./playlists every 30 min
```

(or [`scripts/watch.bat`](scripts/watch.bat))

### Auto-start on Windows login

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
Start-ScheduledTask -TaskName ZioTvLivetgtv
```

This registers a Scheduled Task that runs `serve` at logon.

### Inspect the catalog

```bash
node src/index.js list
```

## Loading in a player

These streams are **DRM-protected DASH** (ClearKey; the manifest also advertises
a Widevine system-ID). They only play in apps that implement `inputstream.adaptive`
/ ClearKey and read the `#KODIPROP` tags. **Pick a supported player:**

| Player | Works? | Notes |
|--------|:------:|-------|
| **TiviMate** | ✅ | Add playlist → *Enter URL* (hosted) or *Add from file*. Reads `#KODIPROP` ClearKey automatically. |
| **OTT Navigator** | ✅ | Reads ClearKey `#KODIPROP`. |
| **Televizo** | ✅ | Add playlist → URL or local file. |
| **Kodi** (inputstream.adaptive) | ✅ | Works as-is. |
| **PotPlayer** | ❌ | **Does not support DRM/ClearKey DASH** and ignores `#KODIPROP`, so it fails with *"Unable to connect to the requested server."* This is expected — it is not a playlist problem. |
| **VLC** | ❌ | No ClearKey DASH support. |

> If you tested in **PotPlayer and saw "Failed to start playback / Unable to
> connect"** — that is the DRM limitation above, not a broken URL. The same
> playlist plays correctly in TiviMate / OTT Navigator. (Connectivity to the
> JioTV CDN was verified returning HTTP 200; the manifest carries
> `ContentProtection` + Widevine UUID `EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED`,
> which PotPlayer cannot decrypt.)

## Host on GitHub (auto-updates every 3 hours)

This is the "serve a URL to IPTV players without keeping a PC on" setup. The
included workflow [`.github/workflows/update-playlists.yml`](.github/workflows/update-playlists.yml)
regenerates all four playlists every 3 hours, commits them, and publishes them.

1. **Create the repo and push** (see the git commands at the end of this section).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow runs on push, then every 3 hours (and via **Actions → Run workflow**).

You then get permanent URLs. Two equivalent hosting options are produced:

**Raw file URLs** (always available once committed):
```
https://raw.githubusercontent.com/<you>/zio-tv-via-livetgtv/main/playlists/english.m3u
https://raw.githubusercontent.com/<you>/zio-tv-via-livetgtv/main/playlists/hindi.m3u
https://raw.githubusercontent.com/<you>/zio-tv-via-livetgtv/main/playlists/all.m3u
https://raw.githubusercontent.com/<you>/zio-tv-via-livetgtv/main/playlists/kids-hindi.m3u
```

**GitHub Pages URLs** (nicer, has an index page):
```
https://<you>.github.io/zio-tv-via-livetgtv/english.m3u
https://<you>.github.io/zio-tv-via-livetgtv/hindi.m3u
https://<you>.github.io/zio-tv-via-livetgtv/all.m3u
https://<you>.github.io/zio-tv-via-livetgtv/kids-hindi.m3u
```

Paste any of these into TiviMate/Televizo as a playlist **URL**. The player
re-downloads the file periodically and always gets the latest tokens because the
cron keeps the committed files fresh (tokens last ~6h; refresh runs every 3h).

Create & push (run inside this folder):
```bash
git init -b main
git add -A
git commit -m "Zio TV via livetgtv: initial"
git remote add origin https://github.com/<you>/zio-tv-via-livetgtv.git
git push -u origin main
```

> GitHub's runners are outside India, so generation works but the committed
> tokens are still India-locked for **playback** — your player/device needs an
> Indian IP. If that's a problem, use the self-hosted `serve`/`watch` modes below
> on a machine with an Indian IP instead.

## Configuration (env vars)

| Variable          | Default                         | Used by            |
|-------------------|---------------------------------|--------------------|
| `ZIO_OUT_DIR`     | `./playlists`                   | generate, watch    |
| `ZIO_PORT`        | `8888`                          | serve              |
| `ZIO_TTL_MS`      | `300000` (5 min)                | serve              |
| `ZIO_INTERVAL_MS` | `1800000` (30 min)              | watch              |
| `ZIO_CONCURRENCY` | `8`                             | all                |
| `ZIO_API_BASE`    | `https://livetgtv.lovable.app/api/public` | all      |

## Project layout

```
zio tv via livetgtv/
├── package.json
├── README.md
├── .github/workflows/
│   └── update-playlists.yml # cron: regenerate + commit + Pages every 3h
├── src/
│   ├── index.js            # CLI: generate | serve | list
│   ├── api.js              # livetgtv API client
│   ├── playlists.config.js # the 4 playlist definitions + Hindi/Kids logic
│   ├── m3u.js              # ClearKey M3U builder
│   ├── generate.js         # catalog -> playlists orchestration
│   ├── pages-index.js      # writes playlists/index.html for GitHub Pages
│   └── watch.js            # interval auto-updater for on-disk files
├── scripts/
│   ├── generate.bat
│   ├── serve.bat
│   ├── watch.bat
│   └── install-task.ps1    # Windows auto-start at logon
└── playlists/              # generated output (committed; served to players)
```

## Notes & caveats

- **Geo-locked to India.** Outside India the manifest/segments return 403 — use
  an Indian IP/VPN.
- **Short-lived tokens.** `__hdnea__` lasts a few hours and ClearKeys can rotate;
  always re-resolve before playback (serve/watch do this for you).
- ClearKey ≠ Widevine. The `WDVLive` path looks like Widevine, but the resolver
  returns ClearKey values — which is exactly why ordinary IPTV players work.
- This project only *formats publicly returned data*; it adds no DRM circumvention.
