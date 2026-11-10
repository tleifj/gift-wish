import {
  createSession,
  destroyAllSessions,
  destroySession,
  hashPassword,
  makeInviteCode,
  randomToken,
  sha256Hex,
  userFromSession,
  verifyPassword,
} from './auth.js';

const RESET_LINK_HOURS = 24;

// ---------- years ----------
// Every item belongs to a year, and the app shows one year at a time.
// A year is "open" (items can be added, edited and claimed) from the moment it has
// started anywhere on Earth until it has ended everywhere: UTC+14 reaches a new year
// 14 hours before UTC, and UTC-12 leaves the old one 12 hours after. So whatever
// year someone's own clock shows is always open.
const HOUR = 36e5;
export function openYears(now = Date.now()) {
  return {
    first: new Date(now - 12 * HOUR).getUTCFullYear(),
    last: new Date(now + 14 * HOUR).getUTCFullYear(),
  };
}

function parseYear(value) {
  if (value === undefined || value === null || value === '') return new Date().getUTCFullYear();
  const y = Number(value);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) fail(400, 'Year must be between 2000 and 2100');
  return y;
}

function requireOpenYear(year) {
  const { first, last } = openYears();
  if (year < first) fail(409, `${year} is over, so its lists can't be changed anymore`);
  if (year > last) fail(400, `${year} hasn't started yet`);
}
import { ImportError, importFromLinks, importFromSavedPage, importFromWishlistUrl } from './amazon.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

function text(value, field, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') fail(400, `${field} must be text`);
  const v = value.trim();
  if (required && !v) fail(400, `${field} is required`);
  if (v.length > max) fail(400, `${field} is too long (max ${max} characters)`);
  return v || null;
}

function link(value) {
  const v = text(value, 'Link', { max: 2000 });
  if (!v) return null;
  let parsed;
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    fail(400, 'Link must be a valid web address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(400, 'Link must start with http:// or https://');
  return parsed.href;
}

function priority(value) {
  if (value === undefined || value === null || value === '') return 2;
  const n = Number(value);
  if (![1, 2, 3].includes(n)) fail(400, 'Priority must be 1, 2 or 3');
  return n;
}

function newPassword(value) {
  if (typeof value !== 'string' || value.length < 8) fail(400, 'Password must be at least 8 characters');
  if (value.length > 200) fail(400, 'Password is too long');
  return value;
}

function itemFields(body) {
  return [
    text(body.title, 'Title', { required: true, max: 200 }),
    link(body.url),
    text(body.price, 'Price', { max: 40 }),
    text(body.notes, 'Notes', { max: 1000 }),
    priority(body.priority),
  ];
}

/**
 * Turns an item row into what `viewer` is allowed to see.
 *
 * THE core rule of the app: if the viewer owns the item, claim information is
 * removed entirely — not just hidden in the UI — so it never leaves the server.
 */
function present(row, viewer) {
  const item = {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    url: row.url,
    price: row.price,
    notes: row.notes,
    priority: row.priority,
    createdAt: row.created_at,
    year: row.year,
  };
  if (row.owner_id === viewer.id) return item;

  item.removed = Boolean(row.deleted_at);
  if (row.claim_user_id === viewer.id && !row.deleted_at) item.changes = changesSinceClaim(row);
  item.claim = row.claim_status
    ? {
        status: row.claim_status,
        userId: row.claim_user_id,
        userName: row.claim_user_name,
        byMe: row.claim_user_id === viewer.id,
      }
    : null;
  return item;
}

// What the owner changed after this person claimed the item (or last said "Got it").
const WATCHED_FIELDS = [
  ['title', 'Name'],
  ['price', 'Price'],
  ['notes', 'Notes'],
  ['url', 'Link'],
];
function changesSinceClaim(row) {
  return WATCHED_FIELDS.filter(([key]) => (row[`seen_${key}`] ?? null) !== (row[key] ?? null)).map(([key, label]) => ({
    field: key,
    label,
    from: row[`seen_${key}`] ?? null,
    to: row[key] ?? null,
  }));
}

const ITEM_SELECT = `
  SELECT i.*, c.status AS claim_status, c.user_id AS claim_user_id, cu.name AS claim_user_name,
         c.seen_title, c.seen_url, c.seen_price, c.seen_notes
    FROM items i
    LEFT JOIN claims c ON c.item_id = i.id
    LEFT JOIN users cu ON cu.id = c.user_id
`;

const SQL = {
  userByEmail: 'SELECT * FROM users WHERE email = ?',
  userById: 'SELECT id, name, family_id FROM users WHERE id = ?',
  insertUser: 'INSERT INTO users (name, email, password_hash, family_id) VALUES (?, ?, ?, ?)',
  familyById: 'SELECT * FROM families WHERE id = ?',
  familyByCode: 'SELECT * FROM families WHERE invite_code = ?',
  insertFamily: 'INSERT INTO families (name, invite_code, organizer_id) VALUES (?, ?, ?)',
  // Only joins if the person isn't in a family yet, so two quick requests can't both win.
  setFamily: 'UPDATE users SET family_id = ? WHERE id = ? AND family_id IS NULL',
  members: `SELECT u.id, u.name,
                   (SELECT COUNT(*) FROM items i
                     WHERE i.owner_id = u.id AND i.deleted_at IS NULL AND i.year = ?) AS item_count
              FROM users u WHERE u.family_id = ? ORDER BY u.name COLLATE NOCASE`,
  // Years that have any items in this family, for the year picker.
  familyYears: `SELECT DISTINCT i.year FROM items i JOIN users u ON u.id = i.owner_id
                 WHERE u.family_id = ? AND i.deleted_at IS NULL ORDER BY i.year DESC`,
  itemRow: `${ITEM_SELECT} WHERE i.id = ?`,
  // Owner sees only live items. Others also see removed items they had claimed,
  // so they know not to buy it (or that they may want to return it).
  listItems: `${ITEM_SELECT}
               WHERE i.owner_id = ? AND i.year = ?
                 AND (i.deleted_at IS NULL OR (c.user_id = ? AND i.owner_id <> ?))
               ORDER BY i.deleted_at IS NOT NULL, i.priority, i.created_at, i.id`,
  myClaims: `${ITEM_SELECT}
               JOIN users o ON o.id = i.owner_id
              WHERE c.user_id = ? AND o.family_id = ? AND i.year = ?
              ORDER BY o.name COLLATE NOCASE, c.status DESC, i.title COLLATE NOCASE`,
  insertItem: 'INSERT INTO items (owner_id, year, title, url, price, notes, priority) VALUES (?, ?, ?, ?, ?, ?, ?)',
  updateItem: 'UPDATE items SET title = ?, url = ?, price = ?, notes = ?, priority = ? WHERE id = ?',
  // Run together in one batch: keep a tombstone only if someone has claimed it.
  softDeleteIfClaimed:
    "UPDATE items SET deleted_at = datetime('now') WHERE id = ? AND EXISTS (SELECT 1 FROM claims WHERE item_id = items.id)",
  hardDeleteIfUnclaimed: 'DELETE FROM items WHERE id = ? AND NOT EXISTS (SELECT 1 FROM claims WHERE item_id = items.id)',
  // A single statement, so two people tapping at the same moment can't both get the item:
  // it inserts a new claim, or updates one that already belongs to this person, or does nothing.
  claim: `INSERT INTO claims (item_id, user_id, status, seen_title, seen_url, seen_price, seen_notes)
          SELECT id, ?, ?, title, url, price, notes FROM items WHERE id = ?
          ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')
          WHERE claims.user_id = excluded.user_id`,
  // "Got it": the claimer has seen the current version.
  acknowledgeChanges: `UPDATE claims SET
            seen_title = (SELECT title FROM items WHERE id = claims.item_id),
            seen_url   = (SELECT url   FROM items WHERE id = claims.item_id),
            seen_price = (SELECT price FROM items WHERE id = claims.item_id),
            seen_notes = (SELECT notes FROM items WHERE id = claims.item_id)
          WHERE item_id = ? AND user_id = ?`,
  releaseClaim: 'DELETE FROM claims WHERE item_id = ? AND user_id = ?',
  deleteIfRemoved: 'DELETE FROM items WHERE id = ? AND deleted_at IS NOT NULL',
  ownerNames: 'SELECT id, name FROM users WHERE family_id = ?',
  myLiveItems: 'SELECT title, url FROM items WHERE owner_id = ? AND year = ? AND deleted_at IS NULL',
  // Creating a new reset link cancels any earlier unused one for that person.
  cancelResetLinks: 'DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL',
  insertResetLink: 'INSERT INTO password_resets (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)',
  validResetLink: `SELECT u.id, u.name FROM password_resets r JOIN users u ON u.id = r.user_id
                    WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`,
  // One statement, so a link can only ever be used once, even if opened twice at the same moment.
  useResetLink: `UPDATE password_resets SET used_at = datetime('now')
                  WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
                  RETURNING user_id`,
  setPassword: 'UPDATE users SET password_hash = ? WHERE id = ?',
};

/** Thin async wrapper over a D1 binding. */
function wrap(d1) {
  const stmt = (sql, args) => d1.prepare(sql).bind(...args);
  return {
    stmt: (sql, ...args) => stmt(sql, args),
    get: (sql, ...args) => stmt(sql, args).first(),
    all: async (sql, ...args) => (await stmt(sql, args).all()).results,
    run: async (sql, ...args) => (await stmt(sql, args).run()).meta,
    batch: (stmts) => d1.batch(stmts),
  };
}

export function createApi(d1) {
  const db = wrap(d1);

  async function requireUser(ctx) {
    const user = await userFromSession(db, ctx.token);
    if (!user) fail(401, 'Please sign in');
    return user;
  }

  async function requireFamily(ctx) {
    const user = await requireUser(ctx);
    if (!user.family_id) fail(403, 'Create or join a family first');
    return user;
  }

  /** Loads an item that the viewer is allowed to act on (same family). */
  async function loadItem(viewer, id) {
    const row = await db.get(SQL.itemRow, Number(id) || 0);
    if (!row) fail(404, 'Item not found');
    const owner = await db.get(SQL.userById, row.owner_id);
    if (!owner || owner.family_id !== viewer.family_id) fail(404, 'Item not found');
    return row;
  }

  async function newFamily(name, organizerId) {
    for (let i = 0; i < 5; i++) {
      const code = makeInviteCode();
      if (!(await db.get(SQL.familyByCode, code))) {
        return (await db.run(SQL.insertFamily, name, code, organizerId)).last_row_id;
      }
    }
    fail(500, 'Could not generate an invite code, please try again');
  }

  const routes = {
    'POST /api/signup': async (ctx) => {
      const name = text(ctx.body.name, 'Name', { required: true, max: 60 });
      const email = text(ctx.body.email, 'Email', { required: true, max: 200 }).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email');
      const password = newPassword(ctx.body.password);
      if (await db.get(SQL.userByEmail, email)) fail(409, 'An account with that email already exists');

      const code = typeof ctx.body.inviteCode === 'string' ? ctx.body.inviteCode.trim().toUpperCase() : '';
      const family = code ? await db.get(SQL.familyByCode, code) : null;
      let userId;
      try {
        userId = (await db.run(SQL.insertUser, name, email, await hashPassword(password), family?.id ?? null)).last_row_id;
      } catch (err) {
        if (/UNIQUE/i.test(String(err?.message))) fail(409, 'An account with that email already exists');
        throw err;
      }
      ctx.setSession(await createSession(db, userId));
      return { status: 201, body: { ok: true } };
    },

    'POST /api/login': async (ctx) => {
      const email = String(ctx.body.email || '').trim().toLowerCase();
      const user = await db.get(SQL.userByEmail, email);
      if (!user || !(await verifyPassword(String(ctx.body.password || ''), user.password_hash))) {
        fail(401, 'Wrong email or password');
      }
      ctx.setSession(await createSession(db, user.id));
      return { body: { ok: true } };
    },

    'POST /api/logout': async (ctx) => {
      await destroySession(db, ctx.token);
      ctx.clearSession();
      return { body: { ok: true } };
    },

    'GET /api/me': async (ctx) => {
      const user = await requireUser(ctx);
      const family = user.family_id ? await db.get(SQL.familyById, user.family_id) : null;
      const year = parseYear(ctx.query.get('year'));
      const members = family ? await db.all(SQL.members, year, family.id) : [];
      const years = family ? (await db.all(SQL.familyYears, family.id)).map((r) => r.year) : [];
      const organizer = members.find((m) => m.id === family?.organizer_id);
      return {
        body: {
          user: { id: user.id, name: user.name, email: user.email },
          family: family
            ? {
                id: family.id,
                name: family.name,
                inviteCode: family.invite_code,
                organizerId: organizer?.id ?? null,
                organizerName: organizer?.name ?? null,
                isOrganizer: family.organizer_id === user.id,
              }
            : null,
          members: members.map((m) => ({ id: m.id, name: m.name, itemCount: m.item_count })),
          years,
          openYears: openYears(),
        },
      };
    },

    'POST /api/families': async (ctx) => {
      const user = await requireUser(ctx);
      if (user.family_id) fail(409, "You're already in a family");
      const name = text(ctx.body.name, 'Family name', { required: true, max: 80 });
      const { changes } = await db.run(SQL.setFamily, await newFamily(name, user.id), user.id);
      if (!changes) fail(409, "You're already in a family");
      return { status: 201, body: { ok: true } };
    },

    'POST /api/families/join': async (ctx) => {
      const user = await requireUser(ctx);
      if (user.family_id) fail(409, "You're already in a family");
      const code = String(ctx.body.code || '').trim().toUpperCase();
      const family = await db.get(SQL.familyByCode, code);
      if (!family) fail(404, "That invite code doesn't match any family");
      const { changes } = await db.run(SQL.setFamily, family.id, user.id);
      if (!changes) fail(409, "You're already in a family");
      return { body: { ok: true } };
    },

    // ---------- password resets (by the family organizer) ----------

    'POST /api/members/:id/reset-link': async (ctx) => {
      const user = await requireFamily(ctx);
      const family = await db.get(SQL.familyById, user.family_id);
      if (family.organizer_id !== user.id) {
        const organizer = family.organizer_id ? await db.get(SQL.userById, family.organizer_id) : null;
        fail(403, `Only ${organizer?.name ?? 'the family organizer'} can reset passwords`);
      }
      const member = await db.get(SQL.userById, Number(ctx.params.id) || 0);
      if (!member || member.family_id !== user.family_id) fail(404, 'Member not found');

      const token = randomToken();
      const expiresAt = new Date(Date.now() + RESET_LINK_HOURS * 36e5).toISOString();
      await db.batch([
        db.stmt(SQL.cancelResetLinks, member.id),
        db.stmt(SQL.insertResetLink, await sha256Hex(token), member.id, user.id, expiresAt),
      ]);
      // The secret goes after "#", which browsers never send to the server, so it can't end up in request logs.
      return { status: 201, body: { url: `${ctx.origin}/#/reset/${token}`, name: member.name, expiresAt } };
    },

    'POST /api/password-reset/check': async (ctx) => {
      const token = String(ctx.body.token || '');
      const row = token && (await db.get(SQL.validResetLink, await sha256Hex(token), new Date().toISOString()));
      if (!row) fail(410, 'This reset link has expired or was already used. Ask your family organizer for a new one.');
      return { body: { name: row.name } };
    },

    'POST /api/password-reset': async (ctx) => {
      const token = String(ctx.body.token || '');
      const password = newPassword(ctx.body.password);
      const hash = await hashPassword(password);
      const used = token && (await db.get(SQL.useResetLink, await sha256Hex(token), new Date().toISOString()));
      if (!used) fail(410, 'This reset link has expired or was already used. Ask your family organizer for a new one.');
      await db.run(SQL.setPassword, hash, used.user_id);
      // Sign out everywhere (including whoever might have been using the old password), then sign in here.
      await destroyAllSessions(db, used.user_id);
      ctx.setSession(await createSession(db, used.user_id));
      return { body: { ok: true } };
    },

    'GET /api/lists/:userId': async (ctx) => {
      const viewer = await requireFamily(ctx);
      const owner = await db.get(SQL.userById, Number(ctx.params.userId) || 0);
      if (!owner || owner.family_id !== viewer.family_id) fail(404, 'List not found');
      const year = parseYear(ctx.query.get('year'));
      const rows = await db.all(SQL.listItems, owner.id, year, viewer.id, viewer.id);
      return {
        body: {
          owner: { id: owner.id, name: owner.name },
          year,
          isOpen: year >= openYears().first,
          isMine: owner.id === viewer.id,
          items: rows.map((r) => present(r, viewer)),
        },
      };
    },

    'GET /api/claims': async (ctx) => {
      const viewer = await requireFamily(ctx);
      const names = new Map((await db.all(SQL.ownerNames, viewer.family_id)).map((u) => [u.id, u.name]));
      const year = parseYear(ctx.query.get('year'));
      const rows = await db.all(SQL.myClaims, viewer.id, viewer.family_id, year);
      return { body: { year, items: rows.map((r) => ({ ...present(r, viewer), ownerName: names.get(r.owner_id) })) } };
    },

    'POST /api/items': async (ctx) => {
      const user = await requireFamily(ctx);
      const year = parseYear(ctx.body.year);
      requireOpenYear(year);
      const { last_row_id } = await db.run(SQL.insertItem, user.id, year, ...itemFields(ctx.body));
      return { status: 201, body: { item: present(await db.get(SQL.itemRow, last_row_id), user) } };
    },

    'PUT /api/items/:id': async (ctx) => {
      const user = await requireFamily(ctx);
      const row = await loadItem(user, ctx.params.id);
      if (row.owner_id !== user.id || row.deleted_at) fail(404, 'Item not found');
      requireOpenYear(row.year);
      await db.run(SQL.updateItem, ...itemFields(ctx.body), row.id);
      return { body: { item: present(await db.get(SQL.itemRow, row.id), user) } };
    },

    'DELETE /api/items/:id': async (ctx) => {
      const user = await requireFamily(ctx);
      const row = await loadItem(user, ctx.params.id);
      if (row.owner_id !== user.id || row.deleted_at) fail(404, 'Item not found');
      requireOpenYear(row.year);
      // If someone already claimed it, keep a tombstone so they get told it was removed.
      // The response is identical either way, so the owner learns nothing.
      await db.batch([db.stmt(SQL.softDeleteIfClaimed, row.id), db.stmt(SQL.hardDeleteIfUnclaimed, row.id)]);
      return { body: { ok: true } };
    },

    // Reads items from an Amazon wish list (or pasted links / a saved page) for review.
    // Nothing is saved here; the person picks what to keep, then calls /api/items/import.
    'POST /api/import/preview': async (ctx) => {
      const user = await requireFamily(ctx);
      const { source } = ctx.body;
      let result;
      try {
        if (source === 'wishlist') result = await importFromWishlistUrl(ctx.body.url);
        else if (source === 'links') result = importFromLinks(ctx.body.text);
        else if (source === 'file') result = importFromSavedPage(ctx.body.html);
        else fail(400, 'Unknown import type');
      } catch (err) {
        if (err instanceof ImportError) fail(err.status, err.message);
        throw err;
      }
      const existing = await db.all(SQL.myLiveItems, user.id, parseYear(ctx.body.year));
      const urls = new Set(existing.map((i) => i.url).filter(Boolean));
      const titles = new Set(existing.map((i) => i.title.toLowerCase()));
      return {
        body: {
          listName: result.listName,
          items: result.items.map((i) => ({
            ...i,
            alreadyOnList: Boolean((i.url && urls.has(i.url)) || titles.has(i.title.toLowerCase())),
          })),
        },
      };
    },

    'POST /api/items/import': async (ctx) => {
      const user = await requireFamily(ctx);
      const year = parseYear(ctx.body.year);
      requireOpenYear(year);
      const list = ctx.body.items;
      if (!Array.isArray(list) || !list.length) fail(400, 'Choose at least one item to add');
      if (list.length > 300) fail(400, 'You can add up to 300 items at a time');
      const rows = list.map((i, n) => {
        try {
          return itemFields(i && typeof i === 'object' ? i : {});
        } catch (err) {
          if (err instanceof HttpError) fail(400, `Item ${n + 1}: ${err.message}`);
          throw err;
        }
      });
      // A D1 batch runs as one transaction: all rows are added, or none.
      await db.batch(rows.map((r) => db.stmt(SQL.insertItem, user.id, year, ...r)));
      return { status: 201, body: { added: rows.length } };
    },

    // Copies one of your own items onto another (open) year's list, e.g. a wish that rolls over.
    // Only the item itself is copied, never who bought it.
    'POST /api/items/:id/copy': async (ctx) => {
      const user = await requireFamily(ctx);
      const row = await loadItem(user, ctx.params.id);
      if (row.owner_id !== user.id || row.deleted_at) fail(404, 'Item not found');
      const year = parseYear(ctx.body.year);
      requireOpenYear(year);
      if (year === row.year) fail(400, `This is already on your ${year} list`);
      const { last_row_id } = await db.run(
        SQL.insertItem, user.id, year, row.title, row.url, row.price, row.notes, row.priority
      );
      return { status: 201, body: { item: present(await db.get(SQL.itemRow, last_row_id), user) } };
    },

    // Mark "I'm getting this" (status = claimed) or "I bought it" (status = purchased).
    'PUT /api/items/:id/claim': async (ctx) => {
      const user = await requireFamily(ctx);
      const row = await loadItem(user, ctx.params.id);
      if (row.owner_id === user.id) fail(403, "No peeking! You can't claim items on your own list.");
      if (row.deleted_at) fail(410, 'This item was removed from the list');
      requireOpenYear(row.year);
      const status = ctx.body.status ?? 'claimed';
      if (status !== 'claimed' && status !== 'purchased') fail(400, 'Status must be "claimed" or "purchased"');
      const { changes } = await db.run(SQL.claim, user.id, status, row.id);
      const now = await db.get(SQL.itemRow, row.id);
      if (!changes) fail(409, `${now?.claim_user_name ?? 'Someone'} is already getting this`);
      return { body: { item: present(now, user) } };
    },

    // "Got it" on a "Changed since you bought this" notice.
    'POST /api/items/:id/claim/seen': async (ctx) => {
      const user = await requireFamily(ctx);
      const row = await loadItem(user, ctx.params.id);
      const { changes } = await db.run(SQL.acknowledgeChanges, row.id, user.id);
      if (!changes) fail(404, 'You haven’t claimed this item');
      return { body: { item: present(await db.get(SQL.itemRow, row.id), user) } };
    },

    'DELETE /api/items/:id/claim': async (ctx) => {
      const user = await requireFamily(ctx);
      const row = await loadItem(user, ctx.params.id);
      if (row.owner_id === user.id) fail(403, "No peeking! You can't change claims on your own list.");
      const { changes } = await db.run(SQL.releaseClaim, row.id, user.id);
      if (!changes) fail(403, 'Only the person who claimed this can release it');
      // Clean up a removed item once nobody is holding it any more.
      if (row.deleted_at) {
        await db.run(SQL.deleteIfRemoved, row.id);
        return { body: { item: null } };
      }
      return { body: { item: present(await db.get(SQL.itemRow, row.id), user) } };
    },
  };

  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    const names = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    return { method, pattern, names, handler };
  });

  return async function handle(ctx) {
    for (const r of compiled) {
      if (r.method !== ctx.method) continue;
      const m = r.pattern.exec(ctx.path);
      if (!m) continue;
      ctx.params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      return r.handler(ctx);
    }
    fail(404, 'Not found');
  };
}
