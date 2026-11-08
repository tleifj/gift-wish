// Deploys the Worker and brings the D1 database schema up to date.
//
// Normally migrations run first, so new code never meets an old schema.
// On the very first deploy the database doesn't exist yet: `wrangler deploy`
// creates it, and then the migrations run.
import { spawnSync } from 'node:child_process';

const DB = 'gift-wish';

function wrangler(...args) {
  const r = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}` };
}

function must(result) {
  if (!result.ok) process.exit(1);
}

const migrate = () => wrangler('d1', 'migrations', 'apply', DB, '--remote');

const first = migrate();
if (first.ok) {
  must(wrangler('deploy'));
} else if (/Couldn't find a D1 DB/i.test(first.output)) {
  console.log(`\nNo "${DB}" database yet. Deploying to create it, then applying migrations.\n`);
  must(wrangler('deploy'));
  must(migrate());
} else {
  process.exit(1);
}
