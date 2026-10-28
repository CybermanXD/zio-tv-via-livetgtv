#!/usr/bin/env node
// Standalone auto-updater: regenerates all playlist files on an interval so the
// files on disk stay fresh (useful if your IPTV player reads local/synced files
// instead of the HTTP serve endpoint).
//
// Env:
//   ZIO_INTERVAL_MS  regeneration interval (default 1800000 = 30 min)
//   ZIO_OUT_DIR      output dir (default ../playlists)
//   ZIO_CONCURRENCY  resolve concurrency (default 8)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateAll } from './generate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const INTERVAL = Number(process.env.ZIO_INTERVAL_MS || 1800000);
const CONCURRENCY = Number(process.env.ZIO_CONCURRENCY || 8);
const OUT_DIR = resolve(process.env.ZIO_OUT_DIR || join(PROJECT_ROOT, 'playlists'));

async function runOnce() {
  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString();
  console.log(`\n[${stamp}] regenerating...`);
  const { outputs } = await generateAll({ concurrency: CONCURRENCY, log: () => {} });
  for (const o of outputs) {
    await writeFile(join(OUT_DIR, o.file), o.text, 'utf8');
    console.log(`  ${o.file}: ok=${o.stats.ok} skipped=${o.stats.skipped} failed=${o.stats.failed}`);
  }
  console.log(`[${new Date().toISOString()}] done -> ${OUT_DIR}`);
}

async function loop() {
  console.log(`Zio TV watch: updating every ${Math.round(INTERVAL / 60000)} min -> ${OUT_DIR}`);
  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      console.error('update error: ' + (e?.message || e));
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

loop();
