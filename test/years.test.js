import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { openYears } from '../src/api.js';

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

let n = 0;
async function person(name, inviteCode) {
  const call = client(app.base);
  const r = await call('POST', '/api/signup', { name, email: `${name.toLowerCase()}${++n}@ex.com`, password: 'password123', inviteCode });
  assert.equal(r.status, 201);
  return { call, id: (await call('GET', '/api/me')).body.user.id };
}
async function family() {
  const mom = await person('Mom');
  await mom.call('POST', '/api/families', { name: 'Smiths' });
  const code = (await mom.call('GET', '/api/me')).body.family.inviteCode;
  return { mom, dad: await person('Dad', code) };
}

const THIS_YEAR = new Date().getUTCFullYear();
const LAST_YEAR = THIS_YEAR - 1;

/** Moves an item into last year, as if it had been added then. */
const ageItem = (id) => app.db.prepare('UPDATE items SET year = ? WHERE id = ?').bind(LAST_YEAR, id).run();

test('a year is open until it has ended everywhere on Earth', () => {
  const at = (iso) => openYears(Date.parse(iso));
  assert.deepEqual(at('2026-06-15T12:00:00Z'), { first: 2026, last: 2026 });
  // New Year's Eve evening in California: still 2026 there, already 2027 in Asia.
  assert.deepEqual(at('2027-01-01T04:00:00Z'), { first: 2026, last: 2027 });
  // Late on Dec 31 in Kiribati's time zone (UTC+14): 2027 is open there already.
  assert.deepEqual(at('2026-12-31T10:00:00Z'), { first: 2026, last: 2027 });
  // Jan 1, 12:00 UTC: midnight has passed even at UTC-12, so 2026 is closed.
  assert.deepEqual(at('2027-01-01T12:00:00Z'), { first: 2027, last: 2027 });
});

test('each year has its own lists; a new year starts empty', async () => {
  const { mom, dad } = await family();
  const old = (await mom.call('POST', '/api/items', { title: 'Old wish', year: THIS_YEAR })).body.item;
  await dad.call('PUT', `/api/items/${old.id}/claim`, { status: 'purchased' });
  await ageItem(old.id);
  const fresh = (await mom.call('POST', '/api/items', { title: 'New wish', year: THIS_YEAR })).body.item;
  assert.equal(fresh.year, THIS_YEAR);

  const list = (y) => dad.call('GET', `/api/lists/${mom.id}?year=${y}`);
  assert.deepEqual((await list(THIS_YEAR)).body.items.map((i) => i.title), ['New wish']);
  const past = (await list(LAST_YEAR)).body;
  assert.deepEqual(past.items.map((i) => [i.title, i.claim.status]), [['Old wish', 'purchased']]);
  assert.equal(past.isOpen, false);
  assert.equal((await list(THIS_YEAR)).body.isOpen, true);

  // Counts and the year picker follow the year.
  const me = (y) => mom.call('GET', `/api/me?year=${y}`);
  assert.equal((await me(THIS_YEAR)).body.members.find((m) => m.id === mom.id).itemCount, 1);
  assert.equal((await me(THIS_YEAR + 1)).body.members.find((m) => m.id === mom.id).itemCount, 0);
  assert.deepEqual((await me(THIS_YEAR)).body.years, [THIS_YEAR, LAST_YEAR]);

  // "My shopping" is per year too.
  assert.equal((await dad.call('GET', `/api/claims?year=${THIS_YEAR}`)).body.items.length, 0);
  assert.equal((await dad.call('GET', `/api/claims?year=${LAST_YEAR}`)).body.items.length, 1);

  // Still no spoilers for the owner, even for a finished year.
  assert.ok(!JSON.stringify((await mom.call('GET', `/api/lists/${mom.id}?year=${LAST_YEAR}`)).body).includes('claim'));
});

test('past years are read-only', async () => {
  const { mom, dad } = await family();
  const item = (await mom.call('POST', '/api/items', { title: 'Scarf' })).body.item;
  await ageItem(item.id);

  const closed = /is over/;
  for (const r of [
    await mom.call('POST', '/api/items', { title: 'Late', year: LAST_YEAR }),
    await mom.call('PUT', `/api/items/${item.id}`, { title: 'Edited' }),
    await mom.call('DELETE', `/api/items/${item.id}`),
    await dad.call('PUT', `/api/items/${item.id}/claim`, {}),
    await mom.call('POST', '/api/items/import', { year: LAST_YEAR, items: [{ title: 'x' }] }),
  ]) {
    assert.equal(r.status, 409);
    assert.match(r.body.error, closed);
  }
  assert.equal((await mom.call('POST', '/api/items', { title: 'Too soon', year: THIS_YEAR + 2 })).status, 400);
  assert.equal((await mom.call('GET', `/api/lists/${mom.id}?year=1999`)).status, 400);
});

test('copying a past wish onto this year’s list', async () => {
  const { mom, dad } = await family();
  const old = (await mom.call('POST', '/api/items', { title: 'Telescope', price: '199', priority: 1 })).body.item;
  await dad.call('PUT', `/api/items/${old.id}/claim`, {});
  await ageItem(old.id);

  const copy = await mom.call('POST', `/api/items/${old.id}/copy`, { year: THIS_YEAR });
  assert.equal(copy.status, 201);
  assert.deepEqual(
    [copy.body.item.title, copy.body.item.price, copy.body.item.priority, copy.body.item.year],
    ['Telescope', '199', 1, THIS_YEAR]
  );
  // The copy is a fresh, unclaimed item; last year's claim stays with last year's item.
  const now = (await dad.call('GET', `/api/lists/${mom.id}?year=${THIS_YEAR}`)).body.items;
  assert.equal(now[0].claim, null);

  assert.equal((await dad.call('POST', `/api/items/${old.id}/copy`, { year: THIS_YEAR })).status, 404, "can't copy someone else's");
  assert.equal((await mom.call('POST', `/api/items/${copy.body.item.id}/copy`, { year: THIS_YEAR })).status, 400);
  assert.equal((await mom.call('POST', `/api/items/${copy.body.item.id}/copy`, { year: LAST_YEAR })).status, 409);
});

test('import adds to the chosen year and only checks that year for duplicates', async () => {
  const { mom } = await family();
  const old = (await mom.call('POST', '/api/items', { title: 'Lodge Cast Iron Skillet' })).body.item;
  await ageItem(old.id);
  const preview = await mom.call('POST', '/api/import/preview', {
    source: 'links',
    text: 'https://www.amazon.com/Lodge-Cast-Iron-Skillet/dp/B00006JSUA',
    year: THIS_YEAR,
  });
  assert.equal(preview.body.items[0].alreadyOnList, false, 'last year’s list does not count');
  const added = await mom.call('POST', '/api/items/import', { year: THIS_YEAR, items: preview.body.items });
  assert.equal(added.body.added, 1);
  const items = (await mom.call('GET', `/api/lists/${mom.id}?year=${THIS_YEAR}`)).body.items;
  assert.deepEqual(items.map((i) => [i.title, i.year]), [['Lodge Cast Iron Skillet', THIS_YEAR]]);
});
