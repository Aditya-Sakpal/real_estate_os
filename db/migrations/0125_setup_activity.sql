-- What a project setup is doing, step by step, for its card to show as it
-- happens: each item { k, t, s } is a step's key, the words and whether it
-- is under way, done or a note. An item is replaced in place by its key, so
-- "Polishing the pictures, 3 of 20" moves on where it stands.
ALTER TABLE project_setups ADD COLUMN activity jsonb NOT NULL DEFAULT '[]'::jsonb;
