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
  await call('POST', '/api/signup', { name, email: `${name.toLowerCase()}${++n}@ex.com`, password: 'password123', inviteCode });
  return { call, id: (await call('GET', '/api/me')).body.user.id };
}
async function family() {
  const mom = await person('Mom');
  await mom.call('POST', '/api/families', { name: 'Smiths' });
  const code = (await mom.call('GET', '/api/me')).body.family.inviteCode;
  return { mom, dad: await person('Dad', code), kid: await person('Kid', code) };
}
const SHOES = { title: 'Running shoes', price: '90', notes: 'Size 10', url: 'https://shop.example/shoes' };
const viewOf = async (who, owner, itemId) =>
  (await who.call('GET', `/api/lists/${owner.id}`)).body.items.find((i) => i.id === itemId);

test('the buyer sees exactly what changed after they bought it', async () => {
  const { mom, dad, kid } = await family();
  const item = (await mom.call('POST', '/api/items', SHOES)).body.item;
  await dad.call('PUT', `/api/items/${item.id}/claim`, { status: 'purchased' });
  assert.deepEqual((await viewOf(dad, mom, item.id)).changes, [], 'nothing changed yet');

  await mom.call('PUT', `/api/items/${item.id}`, { ...SHOES, notes: 'Size 12', price: '95' });
  assert.deepEqual((await viewOf(dad, mom, item.id)).changes, [
    { field: 'price', label: 'Price', from: '90', to: '95' },
    { field: 'notes', label: 'Notes', from: 'Size 10', to: 'Size 12' },
  ]);

  // Only the buyer gets the notice; the owner gets no hint at all.
  assert.equal((await viewOf(kid, mom, item.id)).changes, undefined);
  const ownerView = JSON.stringify((await mom.call('GET', `/api/lists/${mom.id}`)).body);
  for (const leak of ['changes', 'Size 10', 'seen_', 'claim']) assert.ok(!ownerView.includes(leak), `owner saw "${leak}"`);

  // "Got it" clears the notice but keeps the purchase.
  const ack = await dad.call('POST', `/api/items/${item.id}/claim/seen`, {});
  assert.equal(ack.status, 200);
  assert.deepEqual(ack.body.item.changes, []);
  assert.equal(ack.body.item.claim.status, 'purchased');

  // A later edit shows only what changed since "Got it".
  await mom.call('PUT', `/api/items/${item.id}`, { ...SHOES, notes: 'Size 12, wide', price: '95' });
  assert.deepEqual((await viewOf(dad, mom, item.id)).changes.map((c) => [c.from, c.to]), [['Size 12', 'Size 12, wide']]);
});

test('editing back to the original clears the notice; priority changes are not flagged', async () => {
  const { mom, dad } = await family();
  const item = (await mom.call('POST', '/api/items', SHOES)).body.item;
  await dad.call('PUT', `/api/items/${item.id}/claim`, {});
  await mom.call('PUT', `/api/items/${item.id}`, { ...SHOES, title: 'Trail shoes' });
  assert.equal((await viewOf(dad, mom, item.id)).changes.length, 1);
  await mom.call('PUT', `/api/items/${item.id}`, { ...SHOES, priority: 1 });
  assert.deepEqual((await viewOf(dad, mom, item.id)).changes, []);
});

test('marking bought after a change keeps the notice; re-claiming starts fresh', async () => {
  const { mom, dad } = await family();
  const item = (await mom.call('POST', '/api/items', SHOES)).body.item;
  await dad.call('PUT', `/api/items/${item.id}/claim`, {});
  await mom.call('PUT', `/api/items/${item.id}`, { ...SHOES, notes: 'Size 12' });
  await dad.call('PUT', `/api/items/${item.id}/claim`, { status: 'purchased' });
  assert.equal((await viewOf(dad, mom, item.id)).changes.length, 1, 'still flagged until "Got it"');

  await dad.call('DELETE', `/api/items/${item.id}/claim`);
  await dad.call('PUT', `/api/items/${item.id}/claim`, {});
  assert.deepEqual((await viewOf(dad, mom, item.id)).changes, [], 'a new claim sees the current version');
});

test('only the claimer can say "Got it"', async () => {
  const { mom, dad, kid } = await family();
  const item = (await mom.call('POST', '/api/items', SHOES)).body.item;
  await dad.call('PUT', `/api/items/${item.id}/claim`, {});
  assert.equal((await kid.call('POST', `/api/items/${item.id}/claim/seen`, {})).status, 404);
  assert.equal((await mom.call('POST', `/api/items/${item.id}/claim/seen`, {})).status, 404);
});
