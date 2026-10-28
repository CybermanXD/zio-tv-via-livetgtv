// Writes a small index.html into the output dir so GitHub Pages has a landing
// page listing the playlist URLs. Invoked by `generate`.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLAYLISTS } from './playlists.config.js';
import { PROXY_BASE } from './m3u.js';
import { proxyFileName } from './generate.js';

export async function writePagesIndex(outDir) {
  const directItems = PLAYLISTS.map(
    (p) =>
      `      <li><strong>${p.title}</strong> — <a href="./${p.file}">${p.file}</a> ` +
      `<code>./${p.file}</code></li>`,
  ).join('\n');

  const proxyItems = PLAYLISTS.map((p) => {
    const f = proxyFileName(p.file);
    return (
      `      <li><strong>${p.title}</strong> — <a href="./${f}">${f}</a> ` + `<code>./${f}</code></li>`
    );
  }).join('\n');

  const proxySection = PROXY_BASE
    ? `  <h2>Proxy playlists — for Televizo / VLC / Kodi</h2>
  <p>These route through an always-on proxy (<code>${PROXY_BASE}</code>) that injects the
  stream token, so they play in players that don't forward auth headers. Use these if the
  direct playlists show a black screen.</p>
  <ul>
${proxyItems}
  </ul>
`
    : `  <h2>Proxy playlists</h2>
  <p class="note">Not generated — set the <code>ZIO_PROXY_BASE</code> repository Variable to a deployed
  proxy (e.g. a Cloudflare Worker) and re-run the workflow to enable Televizo/VLC support.</p>
`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Zio TV via livetgtv</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; line-height: 1.5; }
    code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
    li { margin: 8px 0; }
    .note { color: #666; font-size: 0.9em; }
    h2 { margin-top: 32px; }
  </style>
</head>
<body>
  <h1>Zio TV via livetgtv</h1>
  <p>Copy a playlist URL below into your IPTV player. Playlists auto-refresh every few hours.</p>

  <h2>Direct playlists — for TiviMate / OTT Navigator</h2>
  <p>Header-based. Work in players that forward stream headers. No proxy needed.</p>
  <ul>
${directItems}
  </ul>

${proxySection}
  <p class="note">Streams are geo-restricted to India (use an Indian IP). Tokens refresh automatically on each scheduled rebuild.</p>
</body>
</html>
`;
  await writeFile(join(outDir, 'index.html'), html, 'utf8');
}
