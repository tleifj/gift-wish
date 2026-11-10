-- Lists per year: every item belongs to a year, and each new year starts fresh.
-- Existing items belong to the year they were added.
ALTER TABLE items ADD COLUMN year INTEGER NOT NULL DEFAULT 0;
UPDATE items SET year = CAST(strftime('%Y', created_at) AS INTEGER);

CREATE INDEX idx_items_owner_year ON items(owner_id, year);
