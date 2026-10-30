-- ===========================================================================
--  0011_reference_media  --  a reference is an upload, not a link
--
--  0010 let a reference carry a link or an image. In practice the link box
--  collects the wrong thing. Asked for "the post that worked", a person
--  pastes the address of the post: a Meta permalink, a LinkedIn update, a
--  YouTube watch page. None of those is media. They are HTML pages behind
--  a login wall, and nothing downstream can read a creative out of one.
--  Expecting the person filling the form to know the difference between a
--  page URL and a media URL is expecting them to think like the code.
--
--  So the link goes and the upload stays, and the upload now takes video as
--  well as images. That has a cost, and it is written here rather than
--  discovered later:
--
--    - The cap rises from 5 MB to 25 MB, which covers a 30 second reel at
--      sensible quality. A server action buffers the whole body in memory
--      before any of this sees it, so the cap is also a memory bound.
--    - Bytes in a row is the wrong long-term home for video. It is the right
--      one today for the same reason it was for images: this repository has
--      no object storage, and the RLS policy that guards every other table
--      guards this column too. A bucket needs a second access-control system
--      written by hand, and the second one is the one that leaks.
--    - When the Approved Asset Library arrives with real object storage,
--      `media` becomes a key and this column is dropped. Until then, expect
--      the database's size to track the reference media people upload.
--
--  Renamed from `image` because it is no longer only images, and a column
--  called `image` holding an MP4 is how the next person writes a bug.
-- ===========================================================================

-- No link, and nothing to migrate into: a reference with only a URL was a
-- reference to a page nothing could read. There is no production data.
DELETE FROM campaign_references WHERE image IS NULL;

-- Constraints before columns. Dropping a column takes every constraint that
-- mentions it, so dropping `url` first leaves the statement below with
-- nothing to drop and the migration fails on its own tidiness.
ALTER TABLE campaign_references DROP CONSTRAINT campaign_references_says_something;
ALTER TABLE campaign_references DROP CONSTRAINT campaign_references_image_pair;
ALTER TABLE campaign_references DROP CONSTRAINT campaign_references_image_size;

ALTER TABLE campaign_references DROP COLUMN url;

ALTER TABLE campaign_references RENAME COLUMN image TO media;
ALTER TABLE campaign_references RENAME COLUMN image_type TO media_type;
ALTER TABLE campaign_references RENAME COLUMN image_name TO media_name;

-- A reference IS its media now. A note on its own is a sentence in a brief,
-- not an example of anything.
ALTER TABLE campaign_references ALTER COLUMN media SET NOT NULL;
ALTER TABLE campaign_references ALTER COLUMN media_type SET NOT NULL;

ALTER TABLE campaign_references
  ADD CONSTRAINT campaign_references_media_size
    CHECK (octet_length(media) <= 26214400);
