// Deploys the Worker and brings the D1 database schema up to date.
// Migrations run first, so new code never meets an old schema.
import { spawnSync } from 'node:child_process';

function wrangler(...args) {
  const r = spawnSync('npx', ['wrangler', ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

wrangler('d1', 'migrations', 'apply', 'gift-wish', '--remote');
wrangler('deploy');
