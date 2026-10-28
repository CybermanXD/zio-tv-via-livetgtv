// Zio TV — Cloudflare Pages Function (catch-all) over the shared proxy core.
//
// Gives a neutral URL (https://ziotv-proxy.pages.dev) instead of the permanent
// account-scoped *.workers.dev subdomain. Behaviour is identical to the Worker
// because both import the same ./src/core.js.
//
// Deploy: `wrangler pages deploy public --project-name ziotv-proxy`

import { handleRequest } from '../src/core.js';

export const onRequest = (context) => handleRequest(context.request);
