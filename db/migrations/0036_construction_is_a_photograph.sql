-- ===========================================================================
--  0036_construction_is_a_photograph  --  a progress photo is never a render
--
--  The upload screen offers no "these are photographs" tick for a category
--  that is a photograph by nature, and the action read the missing tick as
--  "render". So every construction photo was filed with is_render true, shown
--  as "Render", and would have carried the artist's impression line, which
--  says of a real photograph of the site that it is not one.
--
--  The application now forces it (`isRenderFor()`, `addAsset()`); this puts
--  the rows already filed right, and a CHECK keeps a later write path from
--  doing it again. CONSTRUCTION is the only category marked photographic in
--  `asset-rules.ts`; a new one marked so belongs in this CHECK too.
-- ===========================================================================

UPDATE assets SET is_render = false
WHERE category = 'CONSTRUCTION' AND is_render;

ALTER TABLE assets
  ADD CONSTRAINT assets_photograph_not_render
  CHECK (category <> 'CONSTRUCTION' OR NOT is_render);
