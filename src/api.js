import {
  createSession,
  destroySession,
  hashPassword,
  makeInviteCode,
  userFromSession,
  verifyPassword,
} from './auth.js';
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
  };
  if (row.owner_id === viewer.id) return item;

  item.removed = Boolean(row.deleted_at);
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

const ITEM_SELECT = `
  SELECT i.*, c.status AS claim_status, c.user_id AS claim_user_id, cu.name AS claim_user_name
    FROM items i
    LEFT JOIN claims c ON c.item_id = i.id
    LEFT JOIN users cu ON cu.id = c.user_id
`;

export function createApi(db, { fetchImpl = fetch } = {}) {
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, name, family_id FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'),
    familyById: db.prepare('SELECT * FROM families WHERE id = ?'),
    familyByCode: db.prepare('SELECT * FROM families WHERE invite_code = ?'),
    insertFamily: db.prepare('INSERT INTO families (name, invite_code) VALUES (?, ?)'),
    setFamily: db.prepare('UPDATE users SET family_id = ? WHERE id = ?'),
    members: db.prepare(
      `SELECT u.id, u.name,
              (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id AND i.deleted_at IS NULL) AS item_count
         FROM users u WHERE u.family_id = ? ORDER BY u.name COLLATE NOCASE`
    ),
    itemRow: db.prepare(`${ITEM_SELECT} WHERE i.id = ?`),
    // Owner sees only live items. Others also see removed items they had claimed,
    // so they know not to buy it (or that they may want to return it).
    listItems: db.prepare(
      `${ITEM_SELECT}
        WHERE i.owner_id = ?
          AND (i.deleted_at IS NULL OR (c.user_id = ? AND i.owner_id <> ?))
        ORDER BY i.deleted_at IS NOT NULL, i.priority, i.created_at`
    ),
    myClaims: db.prepare(
      `${ITEM_SELECT}
        JOIN users o ON o.id = i.owner_id
        WHERE c.user_id = ? AND o.family_id = ?
        ORDER BY o.name COLLATE NOCASE, c.status DESC, i.title COLLATE NOCASE`
    ),
    insertItem: db.prepare(
      'INSERT INTO items (owner_id, title, url, price, notes, priority) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    updateItem: db.prepare('UPDATE items SET title = ?, url = ?, price = ?, notes = ?, priority = ? WHERE id = ?'),
    softDelete: db.prepare("UPDATE items SET deleted_at = datetime('now') WHERE id = ?"),
    hardDelete: db.prepare('DELETE FROM items WHERE id = ?'),
    upsertClaim: db.prepare(
      `INSERT INTO claims (item_id, user_id, status) VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
    ),
    deleteClaim: db.prepare('DELETE FROM claims WHERE item_id = ?'),
    ownerNames: db.prepare('SELECT id, name FROM users WHERE family_id = ?'),
    myLiveItems: db.prepare('SELECT title, url FROM items WHERE owner_id = ? AND deleted_at IS NULL'),
  };

  function itemFields(body) {
    return [
      text(body.title, 'Title', { required: true, max: 200 }),
      link(body.url),
      text(body.price, 'Price', { max: 40 }),
      text(body.notes, 'Notes', { max: 1000 }),
      priority(body.priority),
    ];
  }

  function requireUser(ctx) {
    const user = userFromSession(db, ctx.token);
    if (!user) fail(401, 'Please sign in');
    return user;
  }

  function requireFamily(ctx) {
    const user = requireUser(ctx);
    if (!user.family_id) fail(403, 'Create or join a family first');
    return user;
  }

  /** Loads an item that the viewer is allowed to act on (same family, still visible). */
  function loadItem(viewer, id) {
    const row = q.itemRow.get(Number(id));
    if (!row) fail(404, 'Item not found');
    const owner = q.userById.get(row.owner_id);
    if (!owner || owner.family_id !== viewer.family_id) fail(404, 'Item not found');
    return row;
  }

  function loadOthersItem(viewer, id) {
    const row = loadItem(viewer, id);
    if (row.owner_id === viewer.id) fail(403, "No peeking! You can't claim items on your own list.");
    if (row.deleted_at) fail(410, 'This item was removed from the list');
    return row;
  }

  function newFamily(name) {
    for (let i = 0; i < 5; i++) {
      const code = makeInviteCode();
      if (!q.familyByCode.get(code)) {
        const { lastInsertRowid } = q.insertFamily.run(name, code);
        return Number(lastInsertRowid);
      }
    }
    fail(500, 'Could not generate an invite code, please try again');
  }

  const routes = {
    'POST /api/signup': (ctx) => {
      const name = text(ctx.body.name, 'Name', { required: true, max: 60 });
      const email = text(ctx.body.email, 'Email', { required: true, max: 200 }).toLowerCase();
      const password = ctx.body.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email');
      if (typeof password !== 'string' || password.length < 8) fail(400, 'Password must be at least 8 characters');
      if (q.userByEmail.get(email)) fail(409, 'An account with that email already exists');
      const { lastInsertRowid } = q.insertUser.run(name, email, hashPassword(password));
      const userId = Number(lastInsertRowid);

      const code = typeof ctx.body.inviteCode === 'string' ? ctx.body.inviteCode.trim().toUpperCase() : '';
      if (code) {
        const family = q.familyByCode.get(code);
        if (family) q.setFamily.run(family.id, userId);
      }
      ctx.setSession(createSession(db, userId));
      return { status: 201, body: { ok: true } };
    },

    'POST /api/login': (ctx) => {
      const email = String(ctx.body.email || '').trim().toLowerCase();
      const user = q.userByEmail.get(email);
      if (!user || !verifyPassword(String(ctx.body.password || ''), user.password_hash)) {
        fail(401, 'Wrong email or password');
      }
      ctx.setSession(createSession(db, user.id));
      return { body: { ok: true } };
    },

    'POST /api/logout': (ctx) => {
      destroySession(db, ctx.token);
      ctx.clearSession();
      return { body: { ok: true } };
    },

    'GET /api/me': (ctx) => {
      const user = requireUser(ctx);
      const family = user.family_id ? q.familyById.get(user.family_id) : null;
      return {
        body: {
          user: { id: user.id, name: user.name, email: user.email },
          family: family ? { id: family.id, name: family.name, inviteCode: family.invite_code } : null,
          members: family
            ? q.members.all(family.id).map((m) => ({ id: m.id, name: m.name, itemCount: m.item_count }))
            : [],
        },
      };
    },

    'POST /api/families': (ctx) => {
      const user = requireUser(ctx);
      if (user.family_id) fail(409, "You're already in a family");
      const name = text(ctx.body.name, 'Family name', { required: true, max: 80 });
      q.setFamily.run(newFamily(name), user.id);
      return { status: 201, body: { ok: true } };
    },

    'POST /api/families/join': (ctx) => {
      const user = requireUser(ctx);
      if (user.family_id) fail(409, "You're already in a family");
      const code = String(ctx.body.code || '').trim().toUpperCase();
      const family = q.familyByCode.get(code);
      if (!family) fail(404, "That invite code doesn't match any family");
      q.setFamily.run(family.id, user.id);
      return { body: { ok: true } };
    },

    'GET /api/lists/:userId': (ctx) => {
      const viewer = requireFamily(ctx);
      const owner = q.userById.get(Number(ctx.params.userId));
      if (!owner || owner.family_id !== viewer.family_id) fail(404, 'List not found');
      const rows = q.listItems.all(owner.id, viewer.id, viewer.id);
      return {
        body: {
          owner: { id: owner.id, name: owner.name },
          isMine: owner.id === viewer.id,
          items: rows.map((r) => present(r, viewer)),
        },
      };
    },

    'GET /api/claims': (ctx) => {
      const viewer = requireFamily(ctx);
      const names = new Map(q.ownerNames.all(viewer.family_id).map((u) => [u.id, u.name]));
      const items = q.myClaims
        .all(viewer.id, viewer.family_id)
        .map((r) => ({ ...present(r, viewer), ownerName: names.get(r.owner_id) }));
      return { body: { items } };
    },

    'POST /api/items': (ctx) => {
      const user = requireFamily(ctx);
      const { lastInsertRowid } = q.insertItem.run(user.id, ...itemFields(ctx.body));
      return { status: 201, body: { item: present(q.itemRow.get(Number(lastInsertRowid)), user) } };
    },

    'PUT /api/items/:id': (ctx) => {
      const user = requireFamily(ctx);
      const row = loadItem(user, ctx.params.id);
      if (row.owner_id !== user.id || row.deleted_at) fail(404, 'Item not found');
      q.updateItem.run(...itemFields(ctx.body), row.id);
      return { body: { item: present(q.itemRow.get(row.id), user) } };
    },

    'DELETE /api/items/:id': (ctx) => {
      const user = requireFamily(ctx);
      const row = loadItem(user, ctx.params.id);
      if (row.owner_id !== user.id || row.deleted_at) fail(404, 'Item not found');
      // If someone already claimed it, keep a tombstone so they get told it was removed.
      // The response is identical either way, so the owner learns nothing.
      if (row.claim_status) q.softDelete.run(row.id);
      else q.hardDelete.run(row.id);
      return { body: { ok: true } };
    },

    // Reads items from an Amazon wish list (or pasted links / a saved page) for review.
    // Nothing is saved here; the person picks what to keep, then calls /api/items/import.
    'POST /api/import/preview': async (ctx) => {
      const user = requireFamily(ctx);
      const { source } = ctx.body;
      let result;
      try {
        if (source === 'wishlist') result = await importFromWishlistUrl(ctx.body.url, { fetchImpl });
        else if (source === 'links') result = importFromLinks(ctx.body.text);
        else if (source === 'file') result = importFromSavedPage(ctx.body.html);
        else fail(400, 'Unknown import type');
      } catch (err) {
        if (err instanceof ImportError) fail(err.status, err.message);
        throw err;
      }
      const existing = q.myLiveItems.all(user.id);
      const urls = new Set(existing.map((i) => i.url).filter(Boolean));
      const titles = new Set(existing.map((i) => i.title.toLowerCase()));
      return {
        body: {
          listName: result.listName,
          items: result.items.map((i) => ({
            ...i,
            alreadyOnList: (i.url && urls.has(i.url)) || titles.has(i.title.toLowerCase()),
          })),
        },
      };
    },

    'POST /api/items/import': (ctx) => {
      const user = requireFamily(ctx);
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
      db.exec('BEGIN');
      try {
        for (const r of rows) q.insertItem.run(user.id, ...r);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { status: 201, body: { added: rows.length } };
    },

    // Mark "I'm getting this" (status = claimed) or "I bought it" (status = purchased).
    'PUT /api/items/:id/claim': (ctx) => {
      const user = requireFamily(ctx);
      const row = loadOthersItem(user, ctx.params.id);
      const status = ctx.body.status ?? 'claimed';
      if (status !== 'claimed' && status !== 'purchased') fail(400, 'Status must be "claimed" or "purchased"');
      if (row.claim_user_id && row.claim_user_id !== user.id) {
        fail(409, `${row.claim_user_name} is already getting this`);
      }
      q.upsertClaim.run(row.id, user.id, status);
      return { body: { item: present(q.itemRow.get(row.id), user) } };
    },

    'DELETE /api/items/:id/claim': (ctx) => {
      const user = requireFamily(ctx);
      const row = loadItem(user, ctx.params.id);
      if (row.owner_id === user.id) fail(403, "No peeking! You can't change claims on your own list.");
      if (row.claim_user_id !== user.id) fail(403, 'Only the person who claimed this can release it');
      q.deleteClaim.run(row.id);
      // Clean up a removed item once nobody is holding it any more.
      if (row.deleted_at) {
        q.hardDelete.run(row.id);
        return { body: { item: null } };
      }
      return { body: { item: present(q.itemRow.get(row.id), user) } };
    },
  };

  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    const names = [];
    const pattern = new RegExp(
      '^' + path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$'
    );
    return { method, pattern, names, handler };
  });

  return function handle(ctx) {
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
