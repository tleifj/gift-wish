import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

let n = 0;
async function person(name, inviteCode) {
  const call = client(app.base);
  const email = `${name.toLowerCase()}${++n}@example.com`;
  const r = await call('POST', '/api/signup', { name, email, password: 'password123', inviteCode });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const me = (await call('GET', '/api/me')).body;
  return { call, email, id: me.user.id };
}

async function family() {
  const mom = await person('Mom');
  await mom.call('POST', '/api/families', { name: 'Smiths' });
  const code = (await mom.call('GET', '/api/me')).body.family.inviteCode;
  return { mom, dad: await person('Dad', code), kid: await person('Kid', code) };
}

const tokenOf = (url) => url.split('#/reset/')[1];

test('the person who creates the family is its organizer', async () => {
  const { mom, dad } = await family();
  const momFam = (await mom.call('GET', '/api/me')).body.family;
  const dadFam = (await dad.call('GET', '/api/me')).body.family;
  assert.equal(momFam.isOrganizer, true);
  assert.equal(dadFam.isOrganizer, false);
  assert.equal(dadFam.organizerName, 'Mom');
});

test('organizer resets a password: new one works, old one and old sessions do not', async () => {
  const { mom, dad } = await family();
  const link = await mom.call('POST', `/api/members/${dad.id}/reset-link`, {});
  assert.equal(link.status, 201);
  assert.equal(link.body.name, 'Dad');
  assert.match(link.body.url, /^http:\/\/[^/]+\/#\/reset\/[A-Za-z0-9_-]{43}$/);
  const token = tokenOf(link.body.url);

  const fresh = client(app.base);
  assert.deepEqual(await fresh('POST', '/api/password-reset/check', { token }), { status: 200, body: { name: 'Dad' } });
  assert.equal((await fresh('POST', '/api/password-reset', { token, password: 'short' })).status, 400);
  assert.equal((await fresh('POST', '/api/password-reset', { token, password: 'new-password-1' })).status, 200);

  // The person is signed in right away on the device that used the link...
  assert.equal((await fresh('GET', '/api/me')).body.user.id, dad.id);
  // ...and signed out everywhere else.
  assert.equal((await dad.call('GET', '/api/me')).status, 401);

  const login = (password) => client(app.base)('POST', '/api/login', { email: dad.email, password });
  assert.equal((await login('password123')).status, 401);
  assert.equal((await login('new-password-1')).status, 200);

  // One use only.
  assert.equal((await client(app.base)('POST', '/api/password-reset', { token, password: 'another-one-2' })).status, 410);
  assert.equal((await client(app.base)('POST', '/api/password-reset/check', { token })).status, 410);
});

test('only the organizer can make links, and only for their own family', async () => {
  const { mom, dad, kid } = await family();
  const other = await family();

  const denied = await dad.call('POST', `/api/members/${kid.id}/reset-link`, {});
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /Only Mom can reset passwords/);
  assert.equal((await mom.call('POST', `/api/members/${other.dad.id}/reset-link`, {})).status, 404);
  assert.equal((await client(app.base)('POST', `/api/members/${kid.id}/reset-link`, {})).status, 401);
});

test('a newer link cancels the older one, and links expire', async () => {
  const { mom, kid } = await family();
  const first = tokenOf((await mom.call('POST', `/api/members/${kid.id}/reset-link`, {})).body.url);
  const second = tokenOf((await mom.call('POST', `/api/members/${kid.id}/reset-link`, {})).body.url);
  const anon = client(app.base);
  assert.equal((await anon('POST', '/api/password-reset/check', { token: first })).status, 410);
  assert.equal((await anon('POST', '/api/password-reset/check', { token: second })).status, 200);

  await app.db.prepare("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").bind(kid.id).run();
  assert.equal((await anon('POST', '/api/password-reset', { token: second, password: 'new-password-1' })).status, 410);
  assert.equal((await anon('POST', '/api/password-reset/check', { token: 'made-up' })).status, 410);
});

test('reset links are stored hashed, never as the secret itself', async () => {
  const { mom, kid } = await family();
  const token = tokenOf((await mom.call('POST', `/api/members/${kid.id}/reset-link`, {})).body.url);
  const rows = (await app.db.prepare('SELECT token_hash FROM password_resets WHERE user_id = ?').bind(kid.id).all()).results;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});
