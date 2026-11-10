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
  const email = `${name.toLowerCase()}${++n}@ex.com`;
  await call('POST', '/api/signup', { name, email, password: 'password123', inviteCode });
  return { call, email, id: (await call('GET', '/api/me')).body.user.id };
}
async function family() {
  const mom = await person('Mom');
  await mom.call('POST', '/api/families', { name: 'Smiths' });
  const code = (await mom.call('GET', '/api/me')).body.family.inviteCode;
  const dad = await person('Dad', code);
  const grandma = await person('Grandma', code);
  const child = (await mom.call('POST', '/api/children', { name: 'Lily' })).body.child;
  return { mom, dad, grandma, child };
}

test('any adult can add a child, who shows up as a family member', async () => {
  const { mom, dad, child } = await family();
  assert.equal(child.name, 'Lily');
  const members = (await dad.call('GET', '/api/me')).body.members;
  assert.deepEqual(members.map((m) => [m.name, m.isChild]), [
    ['Dad', false],
    ['Grandma', false],
    ['Mom', false],
    ['Lily', true],
  ]);
  assert.equal((await dad.call('POST', '/api/children', { name: 'Max' })).status, 201);
  assert.equal((await dad.call('POST', '/api/children', { name: '' })).status, 400);
  assert.equal((await client(app.base)('POST', '/api/children', { name: 'X' })).status, 401);
  void mom;
});

test('adults manage a child’s list, and everyone (including them) sees who is buying', async () => {
  const { mom, dad, grandma, child } = await family();
  const lego = (await mom.call('POST', '/api/items', { title: 'Lego set', ownerId: child.id, price: '50' })).body.item;
  assert.equal(lego.ownerId, child.id);
  // Grandma can add ideas too, and edit.
  const book = (await grandma.call('POST', '/api/items', { title: 'Picture book', ownerId: child.id })).body.item;
  assert.equal((await grandma.call('PUT', `/api/items/${lego.id}`, { title: 'Lego Friends set', price: '50' })).status, 200);

  // Anyone can claim, including the parent who manages the list.
  assert.equal((await mom.call('PUT', `/api/items/${book.id}/claim`, { status: 'purchased' })).status, 200);
  assert.equal((await dad.call('PUT', `/api/items/${lego.id}/claim`, {})).status, 200);

  // No "no peeking": Mom sees Dad's claim on Lily's list, and her own.
  const momView = (await mom.call('GET', `/api/lists/${child.id}`)).body;
  assert.equal(momView.canEdit, true);
  assert.equal(momView.owner.isChild, true);
  assert.deepEqual(momView.items.map((i) => [i.title, i.claim?.userName, i.claim?.status]), [
    ['Lego Friends set', 'Dad', 'claimed'],
    ['Picture book', 'Mom', 'purchased'],
  ]);

  // Removing a claimed item still tells the buyer.
  await grandma.call('DELETE', `/api/items/${lego.id}`);
  const dadView = (await dad.call('GET', `/api/lists/${child.id}`)).body.items;
  // Removed items are listed last.
  assert.deepEqual(dadView.map((i) => [i.title, i.removed]), [['Picture book', false], ['Lego Friends set', true]]);
});

test('editing a child’s item you claimed doesn’t notify you about your own change', async () => {
  const { mom, dad, child } = await family();
  const item = (await mom.call('POST', '/api/items', { title: 'Bike', notes: '16 inch', ownerId: child.id })).body.item;
  await dad.call('PUT', `/api/items/${item.id}/claim`, {});
  await dad.call('PUT', `/api/items/${item.id}`, { title: 'Bike', notes: '20 inch' });
  const own = (await dad.call('GET', `/api/lists/${child.id}`)).body.items[0];
  assert.deepEqual(own.changes, []);
  // But a change by someone else is flagged.
  await mom.call('PUT', `/api/items/${item.id}`, { title: 'Bike', notes: '20 inch, blue' });
  assert.equal((await dad.call('GET', `/api/lists/${child.id}`)).body.items[0].changes.length, 1);
});

test('adults still can’t change each other’s lists, and other families can’t touch a child', async () => {
  const { mom, dad, child } = await family();
  const momItem = (await mom.call('POST', '/api/items', { title: 'Scarf' })).body.item;
  assert.equal((await dad.call('POST', '/api/items', { title: 'Sneaky', ownerId: mom.id })).status, 403);
  assert.equal((await dad.call('PUT', `/api/items/${momItem.id}`, { title: 'Hacked' })).status, 404);
  assert.equal((await dad.call('DELETE', `/api/items/${momItem.id}`)).status, 404);

  const other = await family();
  assert.equal((await other.mom.call('POST', '/api/items', { title: 'x', ownerId: child.id })).status, 404);
  assert.equal((await other.mom.call('GET', `/api/lists/${child.id}`)).status, 404);
  assert.equal((await other.mom.call('DELETE', `/api/children/${child.id}`)).status, 404);
  assert.equal((await mom.call('DELETE', `/api/children/${dad.id}`)).status, 404, 'adults are not children');
});

test('nobody can sign in as a child or reset a child’s password', async () => {
  const { mom, child } = await family();
  const row = await app.db.prepare('SELECT email, password_hash FROM users WHERE id = ?').bind(child.id).first();
  assert.match(row.email, /@children\.invalid$/);
  for (const password of ['!', '', 'password123']) {
    assert.equal((await client(app.base)('POST', '/api/login', { email: row.email, password })).status, 401);
  }
  const reset = await mom.call('POST', `/api/members/${child.id}/reset-link`, {});
  assert.equal(reset.status, 400);
  assert.match(reset.body.error, /doesn’t have a login/);
});

test('renaming and removing a child', async () => {
  const { mom, dad, child } = await family();
  const item = (await mom.call('POST', '/api/items', { title: 'Kite', ownerId: child.id })).body.item;
  await dad.call('PUT', `/api/items/${item.id}/claim`, {});
  assert.equal((await dad.call('PUT', `/api/children/${child.id}`, { name: 'Lilly' })).body.child.name, 'Lilly');
  assert.equal((await mom.call('DELETE', `/api/children/${child.id}`)).status, 200);
  assert.equal((await mom.call('GET', `/api/lists/${child.id}`)).status, 404);
  assert.equal((await dad.call('GET', '/api/claims')).body.items.length, 0, 'claims on their items are gone too');
});

test('import and copy-forward work for a child’s list', async () => {
  const { mom, child } = await family();
  const preview = await mom.call('POST', '/api/import/preview', {
    source: 'links',
    text: 'https://www.amazon.com/Crayola-Washable-Markers/dp/B000HHXJJI',
    ownerId: child.id,
  });
  const added = await mom.call('POST', '/api/items/import', { ownerId: child.id, items: preview.body.items });
  assert.equal(added.body.added, 1);
  const items = (await mom.call('GET', `/api/lists/${child.id}`)).body.items;
  assert.deepEqual(items.map((i) => [i.title, i.ownerId]), [['Crayola Washable Markers', child.id]]);

  const lastYear = new Date().getUTCFullYear() - 1;
  await app.db.prepare('UPDATE items SET year = ? WHERE id = ?').bind(lastYear, items[0].id).run();
  const copy = await mom.call('POST', `/api/items/${items[0].id}/copy`, { year: new Date().getUTCFullYear() });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.item.ownerId, child.id);
});
