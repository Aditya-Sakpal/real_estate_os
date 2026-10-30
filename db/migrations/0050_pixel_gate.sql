-- ===========================================================================
--  0050_pixel_gate  --  what the finished picture was read to carry
--
--  Every other gate reads what we meant to put on an advertisement. The
--  pixel gate reads the raster a buyer sees: the QR decoded at the sizes a
--  phone shows it and after a simulated print, the registration number read
--  back character for character by OCR, where the block sits, how tall its
--  type is against the phone number, how readable it is against what is
--  behind it, the artist's impression line, and every price against the
--  configuration it is printed beside. `pixel-rules.ts` decides; `pixel.ts`
--  reads.
--
--  `pixel` is { verdict, engine, checkedAt, registrationNo,
--  files: [{ sha256, frames, verdict }], findings: [{ code, verdict, text,
--  file, at? }] }. NULL means the post was made before the gate existed, and
--  such a post never publishes: `prepare()` refuses anything without a PASS,
--  AUTO included.
--
--  The hash of each checked file also rides in `media[i].sha256`, written in
--  the same statement, so a file replaced after the check is not the file
--  that passed. No key is stored here, so the orphan sweep's list of columns
--  that hold keys is unchanged.
--
--  `rendered_posts` keeps its grants: the app role may insert a post with its
--  verdict and may never update either. A verdict is reached once, on the
--  bytes it names.
-- ===========================================================================

ALTER TABLE rendered_posts ADD COLUMN pixel jsonb;
ALTER TABLE post_creatives ADD COLUMN pixel jsonb;

ALTER TABLE rendered_posts ADD CONSTRAINT rendered_posts_pixel_shape
  CHECK (pixel IS NULL OR (pixel->>'verdict' IN ('PASS', 'FAIL', 'HOLD') AND jsonb_typeof(pixel->'files') = 'array'));
ALTER TABLE post_creatives ADD CONSTRAINT post_creatives_pixel_shape
  CHECK (pixel IS NULL OR (pixel->>'verdict' IN ('PASS', 'FAIL', 'HOLD') AND jsonb_typeof(pixel->'files') = 'array'));
