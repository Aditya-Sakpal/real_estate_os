-- ---------------------------------------------------------------------------
-- 0119  Whether a person on a call list ever enquired
-- ---------------------------------------------------------------------------
--
-- A sheet is often a cold list: people who never filled a form or asked
-- about anything. The agent opened one such call with "you had enquired
-- about Harbour View, E Wing", the remark saying in so many words not to. Each
-- row now records what its remarks and the list say: true when this person
-- enquired, false when they never did, NULL when nothing says. Only true
-- lets the agent speak of an enquiry.

ALTER TABLE call_list_rows ADD COLUMN enquired boolean;
