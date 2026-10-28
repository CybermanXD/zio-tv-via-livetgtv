// Writes a small index.html into the output dir so GitHub Pages has a landing
// page listing the playlist URLs. Invoked by `generate`.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLAYLISTS } from './playlists.config.js';

export async function writePagesIndex(outDir) {
  const items = PLAYLISTS.map(
    (p) =>
      `      <li><strong>${p.title}</strong> — <a href="./${p.file}">${p.file}</a> ` +
      `<code>./${p.file}</code></li>`,
  ).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Zio TV via livetgtv</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; line-height: 1.5; }
    code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
    li { margin: 8px 0; }
    .note { color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Zio TV via livetgtv</h1>
  <p>Copy a playlist URL below into TiviMate / Televizo. Playlists auto-refresh every few hours.</p>
  <ul>
${items}
  </ul>
  <p class="note">Streams are geo-restricted to India (use an Indian IP). Tokens refresh automatically on each scheduled rebuild.</p>
</body>
</html>
`;
  await writeFile(join(outDir, 'index.html'), html, 'utf8');
}
