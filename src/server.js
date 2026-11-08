import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, HttpError } from './api.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const COOKIE = 'gw_session';
const MAX_BODY = 64 * 1024;
const MAX_IMPORT_BODY = 8 * 1024 * 1024; // a saved Amazon wish list page can be a few MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(req, limit = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'That is too large to upload');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    // Single-page app: unknown non-file paths fall back to index.html.
    if (extname(rel)) {
      res.writeHead(404).end('Not found');
      return;
    }
    const data = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(req.method === 'HEAD' ? undefined : data);
  }
}

export function createAppServer(db, { secureCookies = false, fetchImpl } = {}) {
  const api = createApi(db, { fetchImpl });
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        await serveStatic(req, res, url.pathname);
        return;
      }

      const headers = {};
      const ctx = {
        method: req.method,
        path: url.pathname,
        token: parseCookies(req.headers.cookie)[COOKIE],
        body: {},
        setSession: ({ token, maxAge }) => {
          headers['Set-Cookie'] = `${COOKIE}=${token}; Max-Age=${maxAge}; ${cookieAttrs}`;
        },
        clearSession: () => {
          headers['Set-Cookie'] = `${COOKIE}=; Max-Age=0; ${cookieAttrs}`;
        },
      };

      if (req.method !== 'GET') {
        // Basic CSRF protection: state-changing calls must be JSON, which a
        // cross-site HTML form cannot send without a CORS preflight.
        const type = req.headers['content-type'] || '';
        if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected JSON');
        ctx.body = await readJson(req, url.pathname === '/api/import/preview' ? MAX_IMPORT_BODY : MAX_BODY);
      }

      const result = await api(ctx);
      send(res, result.status || 200, result.body, headers);
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
      } else {
        console.error(err);
        send(res, 500, { error: 'Something went wrong' });
      }
    }
  });
}
