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
        origin: url.origin,
        query: url.searchParams,
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
        // cross-site HTML form cannot send without a CORS preflight. A DELETE with
        // no body is fine without it: forms can't send DELETE, and cross-site
        // scripts can't either without a preflight.
        const type = request.headers.get('content-type') || '';
        const emptyDelete = request.method === 'DELETE' && !Number(request.headers.get('content-length'));
        if (!type.startsWith('application/json') && !emptyDelete) throw new HttpError(415, 'Expected JSON');
        if (!emptyDelete) {
          ctx.body = await readJson(request, url.pathname === '/api/import/preview' ? MAX_IMPORT_BODY : MAX_BODY);
        }
      }

      const result = await createApi(env.DB)(ctx);
      return json(result.status || 200, result.body, headers);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      // One log line with the actual message (D1 errors otherwise show up as a bare stack trace),
      // plus a reference the person can quote. It matches the request's Ray ID in Cloudflare's logs.
      const ref = (request.headers.get('cf-ray') || crypto.randomUUID()).slice(0, 16);
      console.error(`[ref ${ref}] ${request.method} ${url.pathname} failed: ${err?.message ?? err}`, err?.stack ?? '');
      return json(500, { error: `Something went wrong (ref ${ref})` });
    }
  },
};
