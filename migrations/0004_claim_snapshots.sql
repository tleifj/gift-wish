-- "Changed since you bought this": each claim remembers what the item looked like
-- when it was claimed (or when the claimer last said "Got it" to a change), so the
-- claimer can be shown exactly what the owner changed afterwards.
ALTER TABLE claims ADD COLUMN seen_title TEXT;
ALTER TABLE claims ADD COLUMN seen_url TEXT;
ALTER TABLE claims ADD COLUMN seen_price TEXT;
ALTER TABLE claims ADD COLUMN seen_notes TEXT;

-- Existing claims start from the item as it is now.
UPDATE claims SET
  seen_title = (SELECT title FROM items WHERE items.id = claims.item_id),
  seen_url   = (SELECT url   FROM items WHERE items.id = claims.item_id),
  seen_price = (SELECT price FROM items WHERE items.id = claims.item_id),
  seen_notes = (SELECT notes FROM items WHERE items.id = claims.item_id);
