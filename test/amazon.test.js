import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createAppServer } from '../src/server.js';
import { importFromLinks, importFromWishlistUrl, parseWishlistPage } from '../src/amazon.js';

// Markup modeled on Amazon's wish list pages (list view): one <li data-itemid> per item,
// with itemName_/itemPrice_/itemComment_/itemPriorityLabel_ children, and a showMoreUrl
// input that points at the next page.
function item({ id, asin, title, price, dataPrice, comment, priority }) {
  return `
  <li data-id="LIST1" data-itemid="${id}" data-price="${dataPrice ?? '-Infinity'}"
      data-reposition-action-params='{"itemExternalId":"ASIN:${asin}|ATVPDKIKX0DER","listType":"wishlist"}'
      class="a-spacing-none g-item-sortable">
    <div class="a-fixed-left-grid">
      <h2 class="a-size-base"><a class="a-link-normal" id="itemName_${id}" title="${title}"
        href="/${title.replace(/\W+/g, '-')}/dp/${asin}/?coliid=${id}&amp;colid=LIST1&amp;psc=1&amp;ref_=lv_ov_lig_dp_it">${title}</a></h2>
      ${price ? `<span id="itemPrice_${id}" class="a-price" data-a-size="m"><span class="a-offscreen">${price}</span><span aria-hidden="true">${price}</span></span>` : ''}
      ${comment ? `<span id="itemComment_${id}" class="a-size-small a-color-base g-comment-full">${comment}</span>` : ''}
      ${priority ? `<span id="itemPriorityLabel_${id}" class="a-size-small">${priority}</span>` : ''}
    </div>
  </li>`;
}

function page(items, nextToken) {
  return `<!doctype html><html><head><title>Amazon.com</title></head><body>
  <span id="profile-list-name" class="a-size-extra-large">Birthday Ideas</span>
  <ul id="g-items" class="a-unordered-list">${items.map(item).join('')}</ul>
  ${
    nextToken
      ? `<form><input type="hidden" name="showMoreUrl" value="/hz/wishlist/slv/items?filter=unpurchased&amp;paginationToken=${nextToken}&amp;itemsLayout=LIST&amp;type=wishlist&amp;lid=LIST1&amp;ajax=true"></form>`
      : '<div id="endOfListMarker"></div>'
  }
  </body></html>`;
}

const PAGE1 = page(
  [
    { id: 'I1', asin: 'B0AAAAAAA1', title: 'Smartwool Hiking Socks &amp; Liners', price: '$24.95', comment: 'Size M &lt;3', priority: 'Highest' },
    { id: 'I2', asin: 'B0AAAAAAA2', title: 'The Joy of Cooking', dataPrice: '35.5', priority: 'Low' },
  ],
  'TOKEN2'
);
const PAGE2 = page([{ id: 'I3', asin: 'B0AAAAAAA3', title: 'Cast Iron Skillet', price: '$44.99' }]);

/** Fake fetch that serves the pages above and records what was requested. */
function fakeAmazon(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    for (const [match, respond] of routes) {
      if (match(u)) return respond(u);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const redirect = (location) => new Response(null, { status: 301, headers: { location } });

const LIST_ROUTES = [
  [(u) => u.pathname === '/hz/wishlist/ls/LIST1ABCDE', () => html(PAGE1)],
  [(u) => u.pathname === '/hz/wishlist/slv/items' && u.searchParams.get('paginationToken') === 'TOKEN2', () => html(PAGE2)],
];

test('parses items, prices, comments and priorities from a wish list page', () => {
  const { items, nextPath, listName } = parseWishlistPage(PAGE1);
  assert.equal(listName, 'Birthday Ideas');
  assert.match(nextPath, /paginationToken=TOKEN2&itemsLayout/);
  assert.deepEqual(items, [
    { title: 'Smartwool Hiking Socks & Liners', url: 'https://www.amazon.com/dp/B0AAAAAAA1', price: '$24.95', notes: 'Size M <3', priority: 1 },
    { title: 'The Joy of Cooking', url: 'https://www.amazon.com/dp/B0AAAAAAA2', price: '35.50', notes: null, priority: 3 },
  ]);
});

test('follows "show more" pages', async () => {
  const { fetchImpl, calls } = fakeAmazon(LIST_ROUTES);
  const result = await importFromWishlistUrl('https://www.amazon.com/hz/wishlist/ls/LIST1ABCDE?ref_=wl_share', { fetchImpl });
  assert.deepEqual(result.items.map((i) => i.title), ['Smartwool Hiking Socks & Liners', 'The Joy of Cooking', 'Cast Iron Skillet']);
  assert.equal(calls.length, 2);
});

test('resolves a.co share links, but only to Amazon', async () => {
  const good = fakeAmazon([[(u) => u.hostname === 'a.co', () => redirect('https://www.amazon.com/hz/wishlist/ls/LIST1ABCDE?ref_=cm_sw')], ...LIST_ROUTES]);
  const r = await importFromWishlistUrl('https://a.co/d/abc123', { fetchImpl: good.fetchImpl });
  assert.equal(r.items.length, 3);

  const evil = fakeAmazon([[(u) => u.hostname === 'a.co', () => redirect('http://169.254.169.254/latest/meta-data/')]]);
  await assert.rejects(importFromWishlistUrl('https://a.co/d/abc123', { fetchImpl: evil.fetchImpl }), /does not lead to an Amazon page/);
  assert.equal(evil.calls.length, 1, 'never requested the non-Amazon host');

  await assert.rejects(importFromWishlistUrl('https://example.com/hz/wishlist/ls/LIST1ABCDE'), /Paste a link to an Amazon wish list/);
});

test('explains robot checks and private lists', async () => {
  const captcha = fakeAmazon([[() => true, () => html('<form action="/errors/validateCaptcha">Type the characters you see</form>')]]);
  await assert.rejects(importFromWishlistUrl('amazon.com/hz/wishlist/ls/LIST1ABCDE', captcha), /robot check/);

  const priv = fakeAmazon([[() => true, () => html('<h1>This list is private</h1>')]]);
  await assert.rejects(importFromWishlistUrl('https://www.amazon.co.uk/hz/wishlist/ls/LIST1ABCDE', priv), /private/);
});

test('pasted links become items with readable titles', () => {
  const { items } = importFromLinks(`
    https://www.amazon.com/Lodge-Pre-Seasoned-Skillet-Assist-Handle/dp/B00006JSUA/ref=sr_1_3?keywords=skillet
    https://www.amazon.com/dp/B0BSHF7WHW
    https://www.amazon.com/dp/B0BSHF7WHW?th=1
    www.rei.com/product/12345/smartwool-hiking-socks
  `);
  assert.deepEqual(items.map((i) => [i.title, i.url]), [
    ['Lodge Pre Seasoned Skillet Assist Handle', 'https://www.amazon.com/dp/B00006JSUA'],
    ['Amazon item B0BSHF7WHW', 'https://www.amazon.com/dp/B0BSHF7WHW'],
    ['smartwool hiking socks', 'https://www.rei.com/product/12345/smartwool-hiking-socks'],
  ]);
});

test('import API: preview flags duplicates and saves nothing, import adds the chosen items', async () => {
  const { fetchImpl } = fakeAmazon(LIST_ROUTES);
  const server = createAppServer(openDatabase(':memory:'), { fetchImpl });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
        body: body && JSON.stringify(body),
      });
      cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
      return { status: res.status, body: await res.json() };
    };
  };
  try {
    const me = session();
    await me('POST', '/api/signup', { name: 'Ana', email: 'ana@example.com', password: 'password123' });
    await me('POST', '/api/families', { name: 'Fam' });
    await me('POST', '/api/items', { title: 'The Joy of Cooking' });

    const preview = await me('POST', '/api/import/preview', { source: 'wishlist', url: 'https://www.amazon.com/hz/wishlist/ls/LIST1ABCDE' });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.items.map((i) => [i.title, i.alreadyOnList]), [
      ['Smartwool Hiking Socks & Liners', false],
      ['The Joy of Cooking', true],
      ['Cast Iron Skillet', false],
    ]);
    assert.equal((await me('GET', '/api/me')).body.members[0].itemCount, 1, 'preview saves nothing');

    const chosen = preview.body.items.filter((i) => !i.alreadyOnList);
    const added = await me('POST', '/api/items/import', { items: chosen });
    assert.deepEqual(added, { status: 201, body: { added: 2 } });
    const list = (await me('GET', `/api/lists/${(await me('GET', '/api/me')).body.user.id}`)).body.items;
    assert.deepEqual(list.map((i) => [i.title, i.priority, i.price]), [
      ['Smartwool Hiking Socks & Liners', 1, '$24.95'],
      ['The Joy of Cooking', 2, null],
      ['Cast Iron Skillet', 2, '$44.99'],
    ]);

    // Bad rows are rejected as a whole, with the row number.
    const bad = await me('POST', '/api/items/import', { items: [{ title: 'ok' }, { title: '' }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Item 2: Title is required/);

    const file = await me('POST', '/api/import/preview', { source: 'file', html: PAGE2 });
    assert.deepEqual(file.body.items.map((i) => i.title), ['Cast Iron Skillet']);
    assert.equal((await me('POST', '/api/import/preview', { source: 'file', html: '<p>hello</p>' })).status, 422);

    const anon = session();
    assert.equal((await anon('POST', '/api/import/preview', { source: 'links', text: 'https://amazon.com/dp/B00006JSUA' })).status, 401);
  } finally {
    server.close();
  }
});
