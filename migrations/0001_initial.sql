-- Initial schema. To change the schema later, add a new numbered file
-- (0002_....sql); `npm run deploy` applies any that haven't run yet.

CREATE TABLE families (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  family_id     INTEGER REFERENCES families(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- One wish list per person. Items are soft-deleted so that someone who has
-- already claimed/bought an item finds out the owner removed it.
CREATE TABLE items (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  url        TEXT,
  price      TEXT,
  notes      TEXT,
  priority   INTEGER NOT NULL DEFAULT 2,  -- 1 = most wanted, 2 = would like, 3 = nice to have
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

-- Who is buying what. The list owner must NEVER be able to read these rows
-- for their own items; that rule is enforced in the API layer (see api.js).
CREATE TABLE claims (
  item_id    INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('claimed', 'purchased')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_items_owner ON items(owner_id);
CREATE INDEX idx_claims_user ON claims(user_id);
CREATE INDEX idx_users_family ON users(family_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
