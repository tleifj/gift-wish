// Runs the real Worker in Miniflare (Cloudflare's local runtime) with a fresh,
// in-memory D1 database that has all migrations applied.
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const root = new URL('../', import.meta.url);

function migrationStatements() {
  const dir = new URL('migrations/', root);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(new URL(f, dir), 'utf8')
        .replace(/--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
    );
}

/**
 * @param {object} [opts]
 * @param {(req: Request) => Response | Promise<Response>} [opts.outbound] fake for the Worker's outgoing fetches
 */
export async function startApp({ outbound } = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: new URL('src/worker.js', root).pathname,
    modulesRoot: new URL('.', root).pathname,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-07-01',
    d1Databases: { DB: 'test-db' },
    outboundService: outbound ?? (() => new Response('No network in tests', { status: 599 })),
  });
  const url = await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const sql of migrationStatements()) await db.prepare(sql).run();
  return { base: url.href.replace(/\/$/, ''), close: () => mf.dispose() };
}

/** A tiny client that keeps its own session cookie, like a separate browser. */
export function client(base) {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}
