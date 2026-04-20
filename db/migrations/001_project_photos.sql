-- 001_project_photos.sql
-- Tracks metadata for every job photo stored on WHC. Files themselves
-- continue to live at public_html/shop-uploads/jobs/<project_id>/<filename>;
-- this table adds the metadata we couldn't encode in the filename
-- (category + the admin curation flag for the public gallery).
--
-- Safe to re-run: all statements are IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS project_photos (
  id               SERIAL       PRIMARY KEY,
  project_id       INTEGER      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename         TEXT         NOT NULL,
  category         TEXT         NOT NULL DEFAULT 'other'
                                CHECK (category IN ('signs_led','vehicle_wraps','apparel','printing','other')),
  show_in_gallery  BOOLEAN      NOT NULL DEFAULT FALSE,
  uploaded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  uploaded_by      INTEGER              REFERENCES employees(id) ON DELETE SET NULL,

  -- Same filename can't appear twice within a single job folder.
  UNIQUE (project_id, filename)
);

CREATE INDEX IF NOT EXISTS project_photos_project_id_idx
  ON project_photos (project_id);

-- Fast public-gallery lookup: only rows where show_in_gallery is true.
CREATE INDEX IF NOT EXISTS project_photos_gallery_idx
  ON project_photos (show_in_gallery, category)
  WHERE show_in_gallery = TRUE;
