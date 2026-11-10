-- Child profiles: family members without a login, whose lists the adults manage.
--
-- A child is a row in users with is_child = 1, so items, claims and per-year lists
-- work exactly as for everyone else. A child has no real email or password:
-- the app stores a unique placeholder email and the password hash "!", which can
-- never match any password, so nobody can sign in as a child.
ALTER TABLE users ADD COLUMN is_child INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN created_by INTEGER REFERENCES users(id);
