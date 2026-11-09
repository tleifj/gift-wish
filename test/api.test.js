import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client as makeClient } from './helpers.js';

let app;
let base;

before(async () => {
  app = await startApp();
  base = app.base;
});
after(() => app.close());

const client = () => makeClient(base);

let n = 0;
async function signUp(name, inviteCode) {
  const call = client();
  const r = await call('POST', '/api/signup', { name, email: `${name}${++n}@example.com`, password: 'password123', inviteCode });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const me = await call('GET', '/api/me');
  return { call, id: me.body.user.id };
}

async function makeFamily() {
  const mom = await signUp('Mom');
  await mom.call('POST', '/api/families', { name: 'The Smiths' });
  const code = (await mom.call('GET', '/api/me')).body.family.inviteCode;
  const dad = await signUp('Dad', code);
  const kid = await signUp('Kid');
  assert.equal((await kid.call('POST', '/api/families/join', { code: code.toLowerCase() })).status, 200);
  return { mom, dad, kid, code };
}

test('the list owner never sees who is buying their items', async () => {
  const { mom, dad, kid } = await makeFamily();
  const a = (await mom.call('POST', '/api/items', { title: 'Cozy socks', url: 'example.com/socks', price: '$12' })).body.item;
  const b = (await mom.call('POST', '/api/items', { title: 'Cookbook', priority: 1 })).body.item;
  assert.equal(a.url, 'https://example.com/socks');

  assert.equal((await dad.call('PUT', `/api/items/${a.id}/claim`, {})).status, 200);
  assert.equal((await kid.call('PUT', `/api/items/${b.id}/claim`, { status: 'purchased' })).status, 200);

  // Mom's view: no claim data at all in the payload.
  const own = await mom.call('GET', `/api/lists/${mom.id}`);
  assert.equal(own.body.isMine, true);
  assert.equal(own.body.items.length, 2);
  const raw = JSON.stringify(own.body);
  for (const leak of ['claim', 'Dad', 'Kid', 'purchased', 'removed']) assert.ok(!raw.includes(leak), `leaked "${leak}": ${raw}`);

  // Everyone else sees exactly who is doing what.
  const dadView = (await dad.call('GET', `/api/lists/${mom.id}`)).body.items;
  assert.deepEqual(
    dadView.map((i) => [i.title, i.claim?.status, i.claim?.userName, i.claim?.byMe]),
    [
      ['Cookbook', 'purchased', 'Kid', false],
      ['Cozy socks', 'claimed', 'Dad', true],
    ]
  );
});

test('no double-buying and no meddling with other people\'s claims', async () => {
  const { mom, dad, kid } = await makeFamily();
  const item = (await mom.call('POST', '/api/items', { title: 'Board game' })).body.item;

  assert.equal((await dad.call('PUT', `/api/items/${item.id}/claim`, {})).status, 200);
  const clash = await kid.call('PUT', `/api/items/${item.id}/claim`, {});
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /Dad is already getting this/);
  assert.equal((await kid.call('DELETE', `/api/items/${item.id}/claim`)).status, 403);

  // Dad marks it bought, then changes his mind and releases it.
  assert.equal((await dad.call('PUT', `/api/items/${item.id}/claim`, { status: 'purchased' })).body.item.claim.status, 'purchased');
  assert.equal((await dad.call('DELETE', `/api/items/${item.id}/claim`)).body.item.claim, null);
  assert.equal((await kid.call('PUT', `/api/items/${item.id}/claim`, {})).status, 200);
});

test('owners cannot claim, unclaim, or otherwise probe their own items', async () => {
  const { mom, dad } = await makeFamily();
  const item = (await mom.call('POST', '/api/items', { title: 'Scarf' })).body.item;
  await dad.call('PUT', `/api/items/${item.id}/claim`, {});

  assert.equal((await mom.call('PUT', `/api/items/${item.id}/claim`, {})).status, 403);
  assert.equal((await mom.call('DELETE', `/api/items/${item.id}/claim`)).status, 403);
  const claims = await mom.call('GET', '/api/claims');
  assert.deepEqual(claims.body.items, []);

  // Editing returns the same shape whether or not it's claimed.
  const edited = await mom.call('PUT', `/api/items/${item.id}`, { title: 'Red scarf' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item.claim, undefined);
});

test('removing a claimed item tells the buyer but not the owner', async () => {
  const { mom, dad, kid } = await makeFamily();
  const claimed = (await mom.call('POST', '/api/items', { title: 'Lamp' })).body.item;
  const free = (await mom.call('POST', '/api/items', { title: 'Mug' })).body.item;
  await dad.call('PUT', `/api/items/${claimed.id}/claim`, { status: 'purchased' });

  const r1 = await mom.call('DELETE', `/api/items/${claimed.id}`);
  const r2 = await mom.call('DELETE', `/api/items/${free.id}`);
  assert.deepEqual(r1, r2, 'owner gets identical responses either way');

  assert.deepEqual((await mom.call('GET', `/api/lists/${mom.id}`)).body.items, []);
  assert.deepEqual((await kid.call('GET', `/api/lists/${mom.id}`)).body.items, []);
  const dadItems = (await dad.call('GET', `/api/lists/${mom.id}`)).body.items;
  assert.equal(dadItems.length, 1);
  assert.equal(dadItems[0].removed, true);
  assert.equal(dadItems[0].claim.status, 'purchased');

  // Dad acknowledges; it disappears for good.
  await dad.call('DELETE', `/api/items/${claimed.id}/claim`);
  assert.deepEqual((await dad.call('GET', `/api/lists/${mom.id}`)).body.items, []);
});

test('families are isolated from each other', async () => {
  const smiths = await makeFamily();
  const jones = await makeFamily();
  const item = (await smiths.mom.call('POST', '/api/items', { title: 'Secret' })).body.item;

  assert.equal((await jones.dad.call('GET', `/api/lists/${smiths.mom.id}`)).status, 404);
  assert.equal((await jones.dad.call('PUT', `/api/items/${item.id}/claim`, {})).status, 404);
  assert.equal((await jones.dad.call('PUT', `/api/items/${item.id}`, { title: 'hax' })).status, 404);
});

test('my shopping list shows what I am buying for whom', async () => {
  const { mom, dad, kid } = await makeFamily();
  const a = (await mom.call('POST', '/api/items', { title: 'Book' })).body.item;
  const b = (await kid.call('POST', '/api/items', { title: 'Lego' })).body.item;
  await dad.call('PUT', `/api/items/${a.id}/claim`, {});
  await dad.call('PUT', `/api/items/${b.id}/claim`, { status: 'purchased' });

  const { items } = (await dad.call('GET', '/api/claims')).body;
  assert.deepEqual(items.map((i) => [i.ownerName, i.title, i.claim.status]), [
    ['Kid', 'Lego', 'purchased'],
    ['Mom', 'Book', 'claimed'],
  ]);
});

test('auth and validation basics', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/me')).status, 401);
  assert.equal((await anon('POST', '/api/signup', { name: 'X', email: 'bad', password: 'password123' })).status, 400);
  assert.equal((await anon('POST', '/api/signup', { name: 'X', email: 'x@y.co', password: 'short' })).status, 400);
  assert.equal((await anon('POST', '/api/login', { email: 'nobody@y.co', password: 'password123' })).status, 401);

  const { mom } = await makeFamily();
  assert.equal((await mom.call('POST', '/api/items', { title: 'Bad link', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await mom.call('POST', '/api/items', { title: '' })).status, 400);
  await mom.call('POST', '/api/logout', {});
  assert.equal((await mom.call('GET', '/api/me')).status, 401);
});

test('two people claiming at the same moment: exactly one wins', async () => {
  const { mom, dad, kid } = await makeFamily();
  const item = (await mom.call('POST', '/api/items', { title: 'Telescope' })).body.item;
  const [a, b] = await Promise.all([
    dad.call('PUT', `/api/items/${item.id}/claim`, {}),
    kid.call('PUT', `/api/items/${item.id}/claim`, {}),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('changes must be JSON, except an empty DELETE', async () => {
  const { mom } = await makeFamily();
  const item = (await mom.call('POST', '/api/items', { title: 'Mittens' })).body.item;
  // A cross-site HTML form posts as form data; that must be refused.
  const form = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'title=hax',
  });
  assert.equal(form.status, 415);
  // Removing an item sends no body at all, like the app's Remove button.
  assert.equal((await mom.call('DELETE', `/api/items/${item.id}`)).status, 200);
});
