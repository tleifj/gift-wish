// Cloudflare Worker entry point. Static files in public/ are served by Workers
// static assets; only /api/* requests run this code (see wrangler.jsonc).
import { createApi, HttpError } from './api.js';

const COOKIE = 'gw_session';
const MAX_BODY = 64 * 1024;
const MAX_IMPORT_BODY = 8 * 1024 * 1024; // a saved Amazon wish list page can be a few MB

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {}
    }
  }
  return out;
}

async function readJson(request, limit) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > limit) throw new HttpError(413, 'That is too large to upload');
  const raw = await request.text();
  if (raw.length > limit) throw new HttpError(413, 'That is too large to upload');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    // Secure cookies everywhere except plain-http local development.
    const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;
    const headers = {};
    try {
      const ctx = {
        method: request.method,
        path: url.pathname,
        token: parseCookies(request.headers.get('cookie'))[COOKIE],
        body: {},
        setSession: ({ token, maxAge }) => {
          headers['Set-Cookie'] = `${COOKIE}=${token}; Max-Age=${maxAge}; ${cookieAttrs}`;
        },
        clearSession: () => {
          headers['Set-Cookie'] = `${COOKIE}=; Max-Age=0; ${cookieAttrs}`;
        },
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // Basic CSRF protection: state-changing calls must be JSON, which a
        // cross-site HTML form cannot send without a CORS preflight.
        const type = request.headers.get('content-type') || '';
        if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected JSON');
        ctx.body = await readJson(request, url.pathname === '/api/import/preview' ? MAX_IMPORT_BODY : MAX_BODY);
      }

      const result = await createApi(env.DB)(ctx);
      return json(result.status || 200, result.body, headers);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Something went wrong' });
    }
  },
};
