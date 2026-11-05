-- Soft delete for monitor objects. Historical measurements and events remain intact.
ALTER TABLE monitors ADD COLUMN deleted_at TEXT;
