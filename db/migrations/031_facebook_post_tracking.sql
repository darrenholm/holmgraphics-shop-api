-- Facebook auto-post tracking for gallery photos.
--
-- An OPTIONAL second publish destination, independent of the existing
-- website gallery flag (project_photos.show_in_gallery). When a photo is
-- in the gallery AND fb_post_enabled is on, publishing it also posts the
-- photo + caption to the Holm Graphics Facebook Page via the Graph API.
--
-- Tracking lives on project_photos (NOT a "projects" table) because the
-- gallery is curated per-photo — one published photo maps to one FB post.
--
-- fb_post_enabled : the separate toggle, defaults off so nothing posts to
--                   Facebook unless an admin explicitly opts the photo in.
-- fb_posted       : guard against double-posting on re-publish.
-- fb_post_id      : the Graph API post id (pageid_postid) for link/dedupe.
-- fb_post_error   : last error message; non-null + fb_posted=false ⇒ retryable.
-- fb_caption      : optional per-photo caption override; when null the post
--                   uses the parent project's description (what the website
--                   gallery already shows).
-- fb_posted_at    : when the successful post happened.

ALTER TABLE project_photos
  ADD COLUMN IF NOT EXISTS fb_post_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fb_posted       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fb_post_id      TEXT,
  ADD COLUMN IF NOT EXISTS fb_post_error   TEXT,
  ADD COLUMN IF NOT EXISTS fb_caption      TEXT,
  ADD COLUMN IF NOT EXISTS fb_posted_at    TIMESTAMPTZ;
