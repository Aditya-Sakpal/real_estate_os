-- ===========================================================================
--  0022_post_review  --  what the check found on a designed post
--
--  Posts are now designed by an image model from the approved photograph,
--  and every frame is checked before anybody sees it: a second model reads
--  it, the QR is scanned, and code compares what was read with what should
--  be there. A frame that fails is designed again with what was wrong, up to
--  three times, and the best attempt is kept.
--
--  `review` is { passed, attempts, problems: [{ code, text }], model }.
--  NULL means the post was laid out without a model, before this existed.
--  The same shape on `post_creatives`, for the posts a schedule makes.
-- ===========================================================================

ALTER TABLE rendered_posts ADD COLUMN review jsonb;
ALTER TABLE post_creatives ADD COLUMN post_review jsonb;
