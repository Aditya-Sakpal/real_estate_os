DROP DOWNLOADED REELS HERE
============================================================

What this folder is for
-----------------------
Download the 73 reference reels however you like and dump them in
here. Do not bother renaming them. Names like "video_1738.mp4" or
"fastvideosave_DUEa-h_jQ3H.mp4" are fine.

Then tell Claude "file the inbox" and all of them get renamed to the
library convention and moved into their correct folder (13 to 19).

How the matching works
----------------------
_FILING-MAP.csv holds all 73 rows: folder, shortcode, url, target
filename, priority.

Matching happens in this order:

1. By shortcode. If the downloaded filename contains the Instagram
   shortcode (DUEa-h_jQ3H, DaJwhFlpI7j, and so on), it is matched
   exactly. Most downloaders include it. This is the reliable path.

2. By order. If the filenames carry no shortcode, files are sorted by
   modification time and matched against the list in order. This only
   works if you download strictly top to bottom from one folder's
   DOWNLOAD-LIST.txt at a time.

3. Anything unmatched stays here and gets reported, rather than being
   guessed at and filed wrong.

Recommended: one folder at a time
---------------------------------
Do 13 first, say "file the inbox", check it landed right, then do 14.
Seven small passes beats one big one where a mis-ordered file shifts
everything after it.

If you only want the 13 originals
---------------------------------
Those are the ones you sent, and they are marked priority=original in
the map. They sit at the top of every DOWNLOAD-LIST.txt under
"YOUR ORIGINAL REFERENCES". The other 60 are optional.

Nothing here is required
------------------------
Each folder's PRODUCTION-SPEC.md stands alone. The reels are for
handing a videographer an example or studying a transition frame by
frame. If neither is happening, skip this folder entirely.
