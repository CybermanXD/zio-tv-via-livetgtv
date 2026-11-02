#!/usr/bin/env node
// Zio TV via livetgtv — CLI
//
// Commands:
//   generate [keys...]     Write M3U files to ./playlists
//   serve                  HTTP server: fresh playlists + restricted Jio relay
//   list                   Print catalog category/counts and per-playlist sizes
//
// Env:
//   ZIO_OUT_DIR   output dir for generate (default ./playlists)
//   ZIO_PORT      serve port (default 8888)
//   ZIO_TTL_MS    serve cache TTL per playlist (default 300000 = 5 min)
//   ZIO_CONCURRENCY  resolve concurrency (default 8)
//   ZIO_PROXY_BASE   public relay URL embedded by generate (optional)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

import { PLAYLISTS, getPlaylistByKey } from './playlists.config.js';
import { planPlaylists, generateAll, generateOne } from './generate.js';
import { writePagesIndex } from './pages-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CONCURRENCY = Number(process.env.ZIO_CONCURRENCY || 8);
const CDN_HOST = 'jiotvmblive.cdn.jio.com';
const PLAYBACK_USER_AGENT = 'ExoPlayerLib/2.19.1';
const MAX_RELAY_REDIRECTS = 3;

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function relayTarget(pathname) {
  const match = pathname.match(/^\/jio\/([A-Za-z0-9_-]+)(\/.*)$/);
  if (!match) return null;
  let token;
  try {
    token = decodeBase64Url(match[1]);
  } catch {
    return null;
  }
  if (!/^__hdnea__=st=\d+~exp=\d+~acl=\/\*~hmac=[a-f0-9]+$/i.test(token)) return null;
  if (!/^\/bpk-tv\/[A-Za-z0-9_.=/-]+$/.test(match[2]) || match[2].includes('..')) return null;
  return { token, pathname: match[2] };
}

function requestProxyBase(req) {
  const configured = process.env.ZIO_PROXY_BASE;
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${process.env.ZIO_PORT || 8888}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

async function fetchRelay(url, token, range, redirects = 0) {
  const headers = {
    'User-Agent': PLAYBACK_USER_AGENT,
    Cookie: token,
    Accept: '*/*',
  };
  if (range) headers.Range = range;
  const upstream = await fetch(url, { headers, redirect: 'manual' });
  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
    if (redirects >= MAX_RELAY_REDIRECTS) throw new Error('Too many upstream redirects');
    const next = new URL(upstream.headers.get('location'), url);
    if (next.hostname !== CDN_HOST) throw new Error('Blocked upstream redirect');
    return fetchRelay(next, token, range, redirects + 1);
  }
  return upstream;
}

async function relayJio(req, res, target) {
  const upstreamUrl = `https://${CDN_HOST}${target.pathname}?${target.token}`;
  const upstream = await fetchRelay(upstreamUrl, target.token, req.headers.range);
  const headers = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': target.pathname.endsWith('.mpd') ? 'no-store' : 'public, max-age=15',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return;
  }
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

function lanIPs() {
  const ips = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

async function cmdGenerate(keys) {
  const outDir = resolve(process.env.ZIO_OUT_DIR || join(PROJECT_ROOT, 'playlists'));
  await mkdir(outDir, { recursive: true });
  const only = keys.length ? keys : null;
  const { outputs } = await generateAll({
    concurrency: CONCURRENCY,
    only,
    log: (m) => console.log(m),
  });
  for (const o of outputs) {
    const target = join(outDir, o.file);
    await writeFile(target, o.text, 'utf8');
    console.log(`WROTE ${target}  (ok=${o.stats.ok} skipped=${o.stats.skipped} failed=${o.stats.failed})`);
  }
  // Landing page for GitHub Pages hosting.
  await writePagesIndex(outDir);
  console.log(`\nDone. ${outputs.length} playlist(s) written to ${outDir}`);
  console.log('NOTE: tokens/keys are short-lived — re-run before viewing, or use `serve`.');
}

async function cmdList() {
  const { catalog, sets } = await planPlaylists();
  console.log(`CATALOG: ${catalog.length} channels\n`);
  const byCat = new Map();
  for (const c of catalog) byCat.set(c.category || 'Unknown', (byCat.get(c.category || 'Unknown') || 0) + 1);
  console.log('By category:');
  [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('  ' + String(v).padStart(4) + '  ' + k));
  console.log('\nPlaylists:');
  for (const p of PLAYLISTS) console.log('  ' + p.key.padEnd(12) + (sets[p.key]?.length || 0) + ' channels -> ' + p.file);
}

async function cmdServe() {
  const port = Number(process.env.ZIO_PORT || 8888);
  const ttl = Number(process.env.ZIO_TTL_MS || 300000);

  // Per-playlist cache of generated text.
  const cache = new Map(); // key -> { text, at }
  let planCache = null; // { sets, at }

  async function getPlan() {
    if (planCache && Date.now() - planCache.at < ttl) return planCache;
    const { sets } = await planPlaylists();
    planCache = { sets, at: Date.now() };
    return planCache;
  }

  async function getPlaylistText(key, proxyBase) {
    // The embedded relay origin can differ (LAN IP, reverse-proxy hostname), so
    // it must be part of the cache key or one client can receive another's URL.
    const cacheKey = `${key}\n${proxyBase}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) return hit.text;
    const { sets } = await getPlan();
    const channels = sets[key] || [];
    const res = await generateOne(key, channels, { concurrency: CONCURRENCY, proxyBase });
    cache.set(cacheKey, { text: res.text, at: Date.now() });
    console.log(
      `${new Date().toISOString()} rebuilt "${key}" ok=${res.stats.ok} skipped=${res.stats.skipped} failed=${res.stats.failed}`,
    );
    return res.text;
  }

  const routes = new Map(PLAYLISTS.map((p) => ['/' + p.file, p.key]));
  // also allow /<key>.m3u and /<key>
  for (const p of PLAYLISTS) {
    routes.set('/' + p.key + '.m3u', p.key);
    routes.set('/' + p.key, p.key);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const relay = relayTarget(url.pathname);
    if (relay) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      try {
        await relayJio(req, res, relay);
      } catch (e) {
        console.error(`${new Date().toISOString()} relay error ${relay.pathname}: ${e?.message || e}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('upstream relay error');
      }
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'Zio TV via livetgtv\n\nRelayed, player-compatible playlists:\n' +
          PLAYLISTS.map((p) => `  /${p.file}   (${p.title})`).join('\n') +
          '\n',
      );
      return;
    }

    const key = routes.get(url.pathname);
    if (!key) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    try {
      const text = await getPlaylistText(key, requestProxyBase(req));
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('error: ' + (e?.message || e));
    }
  });

  server.listen(port, () => {
    console.log(`Zio TV serving on port ${port} (cache TTL ${Math.round(ttl / 1000)}s)`);
    const ips = lanIPs();
    const host = ips[0] || 'YOUR-PC-IP';
    console.log('\n== Player-compatible relayed playlists ==');
    for (const p of PLAYLISTS) console.log(`  ${p.title.padEnd(26)} http://${host}:${port}/${p.file}`);
    if (ips.length > 1) console.log(`\n(other IPs: ${ips.slice(1).join(', ')})`);
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'generate':
      await cmdGenerate(rest.filter((k) => getPlaylistByKey(k)));
      break;
    case 'serve':
      await cmdServe();
      break;
    case 'list':
      await cmdList();
      break;
    default:
      console.log('Usage: zio-tv <generate [keys...] | serve | list>');
      console.log('  keys: ' + PLAYLISTS.map((p) => p.key).join(', '));
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('FATAL: ' + (e?.stack || e?.message || e));
  process.exit(1);
});
