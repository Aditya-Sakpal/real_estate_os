-- A project's partner terms are settings: they go with a project or tower
-- that is deleted. A firm ever empanelled there (a grant) still refuses the
-- delete, so no claim or payout loses the terms it was paid on.
ALTER TABLE commission_terms
  DROP CONSTRAINT commission_terms_scope_node_id_fkey,
  ADD CONSTRAINT commission_terms_scope_node_id_fkey
    FOREIGN KEY (scope_node_id) REFERENCES scope_nodes(id) ON DELETE CASCADE;
