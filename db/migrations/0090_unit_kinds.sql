-- 0090: A plot is sold by its plot area, in the unit the developer sells it in.
--
-- The catalog itself is code (`UNIT_CONFIGS` in `unit-rules.ts`): 1 RK,
-- 4.5 BHK, 5 BHK, Penthouse and Jodi flat joined it without a migration,
-- because `unit_types.config` has no CHECK.
--
-- What needed columns is the plot. A plot, a villa or a row house may record
-- the plot it stands on, in square feet (normalised), with the unit it is
-- shown in (sq ft, sq yd or sq m) and what the signed rate per square foot is
-- applied to (the carpet area, or the plot). A plot has no carpet area, so
-- its version row carries the plot area in `carpet_area_sqft` too: every
-- reader that prices or measures by area then reads the area sold.
--
-- Additive and nullable. A row written before this has none of the three,
-- and its hash is computed exactly as before (the hash appends the plot only
-- when there is one), so every existing approval still matches.

ALTER TABLE unit_type_versions
  ADD COLUMN plot_area_sqft numeric(12, 2),
  ADD COLUMN area_unit text,
  ADD COLUMN price_basis text;

ALTER TABLE unit_type_versions
  ADD CONSTRAINT unit_type_versions_plot_area
    CHECK (plot_area_sqft IS NULL OR plot_area_sqft > 0),
  ADD CONSTRAINT unit_type_versions_area_unit
    CHECK (area_unit IS NULL OR area_unit IN ('SQFT', 'SQYD', 'SQM')),
  ADD CONSTRAINT unit_type_versions_price_basis
    CHECK (price_basis IS NULL OR price_basis IN ('CARPET', 'PLOT')),
  -- The unit and the basis describe a plot area, so neither stands alone.
  ADD CONSTRAINT unit_type_versions_plot_whole
    CHECK ((plot_area_sqft IS NULL) = (area_unit IS NULL) AND (plot_area_sqft IS NULL) = (price_basis IS NULL));
