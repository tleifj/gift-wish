-- Password resets, handled by each family's organizer.

-- The organizer is the person who created the family. Existing families get
-- their earliest member, who is the person who created them.
ALTER TABLE families ADD COLUMN organizer_id INTEGER REFERENCES users(id);
UPDATE families SET organizer_id = (SELECT MIN(id) FROM users WHERE users.family_id = families.id);

-- One-time reset links. Only a SHA-256 hash of the link's secret is stored,
-- so reading the database is not enough to reset anyone's password.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_password_resets_user ON password_resets(user_id);
