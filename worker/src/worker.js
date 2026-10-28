// Zio TV — Cloudflare Worker entry (thin wrapper over the shared proxy core).
//
// All logic lives in ./core.js so the Worker and the Cloudflare Pages Function
// (functions/[[path]].js) stay byte-for-byte identical in behaviour.
//
// Deploy: `wrangler deploy`  -> https://zio-tv.<account>.workers.dev

import { handleRequest } from './core.js';

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
