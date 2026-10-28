#!/usr/bin/env node
// Zio TV via livetgtv — CLI
//
// Commands:
//   generate [keys...]     Write M3U files to ./playlists (default: all 4)
//   serve                  HTTP server that serves always-fresh playlists
//   list                   Print catalog category/counts and per-playlist sizes
//
// Env:
//   ZIO_OUT_DIR   output dir for generate (default ./playlists)
//   ZIO_PORT      serve port (default 8888)
//   ZIO_TTL_MS    serve cache TTL per playlist (default 300000 = 5 min)
//   ZIO_CONCURRENCY  resolve concurrency (default 8)

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

  async function getPlaylistText(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.text;
    const { sets } = await getPlan();
    const channels = sets[key] || [];
    const res = await generateOne(key, channels, { concurrency: CONCURRENCY });
    cache.set(key, { text: res.text, at: Date.now() });
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
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'Zio TV via livetgtv\n\nDirect (header-based) playlists:\n' +
          PLAYLISTS.map((p) => `  /${p.file}   (${p.title})`).join('\n') +
          '\n',
      );
      return;
    }

    const key = routes.get(url);
    if (!key) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    try {
      const text = await getPlaylistText(key);
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
    console.log('\n== TiviMate / OTT Navigator (direct header mode) ==');
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
