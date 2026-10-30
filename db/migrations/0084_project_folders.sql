-- 0084: Files in a folder per project.
--
-- Decided with the client on 4 October 2026: in the bucket, each client has
-- a folder, and inside it one folder per project holding everything made or
-- uploaded for that project. What belongs to the organisation or an entity
-- rather than to one project goes under `shared`:
--
--   org/<org>/project/<project>/<kind>/<id>
--   org/<org>/shared/<kind>/<id>
--
-- Rows hold the key, so reading a file never rebuilds one; only the two
-- CHECKs that pinned the old flat shape need to know. Both still accept the
-- flat shape, so a row written before the move stays valid until
-- `npm run storage:folders` moves it.

ALTER TABLE brain_documents DROP CONSTRAINT brain_documents_key_is_the_hash;
ALTER TABLE brain_documents ADD CONSTRAINT brain_documents_key_is_the_hash CHECK (
  storage_key = 'org/' || org_id::text || '/doc/' || sha256
  OR storage_key ~ ('^org/' || org_id::text || '/(project/[0-9a-f-]{36}|shared)/doc/' || sha256 || '$')
);

DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'visit_notes'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%visitnote%'
  LOOP
    EXECUTE format('ALTER TABLE visit_notes DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE visit_notes ADD CONSTRAINT visit_notes_key_shape
  CHECK (storage_key ~ '^org/[0-9a-f-]{36}/((project/[0-9a-f-]{36}|shared)/)?visitnote/[0-9a-f-]{36}$');
