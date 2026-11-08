// Import items from an Amazon wish list.
//
// Three ways in, because Amazon sometimes refuses automated requests:
//   1. A public/shared wish list link: we fetch the page (and its "show more" pages) and parse it.
//   2. Pasted product links, one per line: titles come from the link itself.
//   3. The wish list page saved from the browser (File > Save Page As): same parser as (1).
//
// Nothing here writes to the database. It returns candidate items that the
// person reviews before anything is added to their list.

const AMAZON_HOST =
  /(^|\.)amazon\.(com|ca|com\.mx|com\.br|co\.uk|de|fr|it|es|nl|se|pl|com\.be|com\.tr|ae|sa|eg|in|co\.jp|sg|com\.au)$/i;
const SHORT_HOST = /^(a\.co|amzn\.to|amzn\.eu|amzn\.asia)$/i;
const LIST_ID = /\/(?:hz\/wishlist\/(?:ls|genericItemsPage)|wishlist(?:\/ls)?|registry\/wishlist)\/([A-Z0-9]{8,20})/i;
const ASIN = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?=[/?#]|$)/i;
const MAX_PAGES = 15;
const MAX_ITEMS = 300;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- small HTML helpers (no DOM on the server) ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const textOf = (html) =>
  decodeEntities(String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3]) : null;
}

/** Inner HTML of the first element whose id matches, e.g. itemName_ABC. Good enough for Amazon's flat markup. */
function byId(html, id) {
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sid\\s*=\\s*["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const m = re.exec(html);
  return m ? { tag: m[0].slice(0, m[0].indexOf('>') + 1), inner: m[2] } : null;
}

// ---------- URLs ----------

export function isAmazonHost(host) {
  return AMAZON_HOST.test(host) || SHORT_HOST.test(host);
}

function parseUrl(raw) {
  try {
    const s = String(raw).trim();
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
}

/** Canonical product link (drops tracking junk): https://www.amazon.com/dp/B0XXXXXXX */
export function productUrl(host, asin) {
  return `https://${host.replace(/^(?!www\.)/, 'www.')}/dp/${asin.toUpperCase()}`;
}

/** "Wool-Hiking-Socks-Medium" from /Wool-Hiking-Socks-Medium/dp/B0... -> "Wool Hiking Socks Medium" */
function titleFromSlug(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const i = parts.findIndex((p) => /^(dp|gp)$/i.test(p));
  const slug = i > 0 ? parts[i - 1] : '';
  if (!slug || /^[A-Z0-9]{10}$/.test(slug)) return null;
  const words = decodeURIComponent(slug).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words.length > 2 ? words : null;
}

const PRIORITY = { highest: 1, high: 1, medium: 2, low: 3, lowest: 3 };

// ---------- parsing a wish list page ----------

/**
 * Parses one page of an Amazon wish list.
 * Each item is an <li ... data-itemid="..."> with children whose ids end in that item id:
 * itemName_, itemPrice_, itemComment_, itemPriorityLabel_.
 */
export function parseWishlistPage(html, host = 'www.amazon.com') {
  const items = [];
  const seen = new Set();
  const liRe = /<li\b[^>]*\sdata-itemid\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const starts = [];
  let m;
  while ((m = liRe.exec(html))) starts.push({ index: m.index, tag: m[0], itemId: m[1] });

  starts.forEach((s, n) => {
    const block = html.slice(s.index, n + 1 < starts.length ? starts[n + 1].index : undefined);
    const nameEl = byId(block, `itemName_${s.itemId}`);
    const title = nameEl ? attr(nameEl.tag, 'title') || textOf(nameEl.inner) : null;
    if (!title) return;

    const href = nameEl && attr(nameEl.tag, 'href');
    const params = attr(s.tag, 'data-reposition-action-params') || '';
    const asin =
      (href && ASIN.exec(href)?.[1]) ||
      /ASIN:([A-Z0-9]{10})/i.exec(params)?.[1] ||
      ASIN.exec(block)?.[1] ||
      null;
    const key = asin || title;
    if (seen.has(key)) return;
    seen.add(key);

    const priceEl = byId(block, `itemPrice_${s.itemId}`);
    const offscreen = priceEl && /<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]*)/i.exec(priceEl.inner);
    let price = offscreen ? decodeEntities(offscreen[1]).trim() : null;
    if (!price) {
      const dp = Number(attr(s.tag, 'data-price'));
      if (Number.isFinite(dp) && dp > 0) price = dp.toFixed(2);
    }

    const commentEl = byId(block, `itemComment_${s.itemId}`);
    const prioEl = byId(block, `itemPriorityLabel_${s.itemId}`);
    const prioWord = prioEl ? textOf(prioEl.inner).toLowerCase().split(/\s+/).pop() : '';

    let url = null;
    if (asin) url = productUrl(host, asin);
    else if (href) url = new URL(href, `https://${host}`).href;

    items.push({
      title: title.slice(0, 200),
      url,
      price: price ? price.slice(0, 40) : null,
      notes: commentEl ? textOf(commentEl.inner).slice(0, 1000) || null : null,
      priority: PRIORITY[prioWord] ?? 2,
    });
  });

  const more = /name\s*=\s*["']showMoreUrl["'][^>]*value\s*=\s*["']([^"']+)["']/i.exec(html);
  const listName = byId(html, 'profile-list-name');
  return {
    items,
    nextPath: more ? decodeEntities(more[1]) : null,
    listName: listName ? textOf(listName.inner) : null,
  };
}

function looksBlocked(html) {
  return /validateCaptcha|Type the characters you see|api-services-support@amazon\.com|Robot Check/i.test(html);
}

function looksPrivate(html) {
  return /This list is (private|unavailable)|no longer available|Looking for something\?|Page Not Found/i.test(html);
}

// ---------- the three import modes ----------

/** Follows redirects by hand so a short link can only ever lead to an Amazon host. */
async function fetchAmazon(fetchImpl, url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'https:' || !isAmazonHost(current.hostname)) {
      throw new ImportError(400, 'That link does not lead to an Amazon page');
    }
    let res;
    try {
      res = await fetchImpl(current.href, { headers: BROWSER_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    } catch {
      throw new ImportError(502, "Couldn't reach Amazon. Check your connection, or use one of the other import options.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    return { url: current, status: res.status, html: await res.text() };
  }
  throw new ImportError(502, 'Amazon redirected too many times');
}

export async function importFromWishlistUrl(rawUrl, { fetchImpl = fetch } = {}) {
  const url = parseUrl(rawUrl);
  if (!url || !isAmazonHost(url.hostname)) {
    throw new ImportError(400, 'Paste a link to an Amazon wish list, like https://www.amazon.com/hz/wishlist/ls/ABC123XYZ');
  }

  // Short share links (a.co/...) need resolving before we know the list id.
  let { hostname } = url;
  let listId = LIST_ID.exec(url.pathname)?.[1];
  let firstPage = null;
  if (!listId) {
    const resolved = await fetchAmazon(fetchImpl, url);
    hostname = resolved.url.hostname;
    listId = LIST_ID.exec(resolved.url.pathname)?.[1];
    if (!listId) throw new ImportError(400, "That link isn't an Amazon wish list. Open the list on Amazon, choose Send list to others, and copy the link.");
    firstPage = resolved;
  }
  if (!AMAZON_HOST.test(hostname)) throw new ImportError(400, 'That link does not lead to an Amazon page');

  const origin = `https://${hostname}`;
  const page1 = firstPage ?? (await fetchAmazon(fetchImpl, new URL(`/hz/wishlist/ls/${listId}?viewType=list`, origin)));
  if (looksBlocked(page1.html)) {
    throw new ImportError(
      502,
      'Amazon asked for a robot check, so the list could not be read automatically. Try again in a minute, or use "Paste links" or "Upload saved page".'
    );
  }

  let parsed = parseWishlistPage(page1.html, hostname);
  const items = [...parsed.items];
  const listName = parsed.listName;
  for (let page = 2; parsed.nextPath && page <= MAX_PAGES && items.length < MAX_ITEMS; page++) {
    const next = new URL(parsed.nextPath, origin);
    if (next.hostname !== hostname) break;
    const res = await fetchAmazon(fetchImpl, next);
    if (looksBlocked(res.html)) break; // keep what we have
    parsed = parseWishlistPage(res.html, hostname);
    if (!parsed.items.length) break;
    items.push(...parsed.items);
  }

  if (!items.length) {
    if (page1.status === 404 || looksPrivate(page1.html)) {
      throw new ImportError(404, 'That list is private or no longer exists. On Amazon, set the list to Public or Shared and try again.');
    }
    throw new ImportError(422, 'No items were found on that list. If it has items, make sure it is Public or Shared on Amazon.');
  }
  return { listName, items: dedupe(items).slice(0, MAX_ITEMS) };
}

export function importFromSavedPage(html) {
  if (typeof html !== 'string' || !html.trim()) throw new ImportError(400, 'Choose the saved wish list page');
  const host = /https?:\/\/((?:www\.|smile\.)?amazon\.[a-z.]+)\//i.exec(html)?.[1] || 'www.amazon.com';
  const { items, listName } = parseWishlistPage(html, AMAZON_HOST.test(host) ? host : 'www.amazon.com');
  if (!items.length) {
    throw new ImportError(422, 'No wish list items were found in that file. Save the wish list page itself (File > Save Page As, "Webpage, Complete" or "HTML only").');
  }
  return { listName, items: dedupe(items).slice(0, MAX_ITEMS) };
}

/** One link per line (or separated by spaces). Amazon links get a title from the link; others too, when possible. */
export function importFromLinks(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ImportError(400, 'Paste at least one link');
  const tokens = text.match(/(?:https?:\/\/|www\.|a\.co\/|amzn\.to\/)[^\s<>"']+/gi) || [];
  const items = [];
  for (const raw of tokens) {
    const url = parseUrl(raw.replace(/[).,;]+$/, ''));
    if (!url || !/^https?:$/.test(url.protocol)) continue;
    const asin = AMAZON_HOST.test(url.hostname) ? ASIN.exec(url.pathname)?.[1] : null;
    const title = titleFromSlug(url) || (asin ? `Amazon item ${asin}` : prettyTitle(url));
    items.push({ title: title.slice(0, 200), url: asin ? productUrl(url.hostname, asin) : url.href, price: null, notes: null, priority: 2 });
  }
  if (!items.length) throw new ImportError(400, 'No links found. Paste one product link per line.');
  return { listName: null, items: dedupe(items).slice(0, MAX_ITEMS) };
}

function prettyTitle(url) {
  const last = url.pathname.split('/').filter(Boolean).pop();
  const words = last ? decodeURIComponent(last).replace(/\.[a-z]+$/i, '').replace(/[-_+]+/g, ' ').trim() : '';
  return words && !/^\d+$/.test(words) ? words : `Item from ${url.hostname.replace(/^www\./, '')}`;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    const key = (i.url || i.title).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
