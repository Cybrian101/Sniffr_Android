-- PawCircle URLs: /community/:id showed the raw numeric id (e.g. /community/312)
-- instead of a readable name, the way pet profiles already get /kitty instead
-- of /profile/42. Adds a slug derived from each community's name, generated
-- once at creation time and never changed afterward (so existing links never
-- break even if the circle is renamed later).
--
-- Run by hand in the Supabase SQL editor, BEFORE deploying the backend that
-- uses it (routes/communities.js's :id param resolver reads this column, and
-- POST /communities starts writing it). Additive and idempotent: safe to run
-- twice. Existing rows are backfilled below with a slug generated the same
-- way CommunityRepository.generateUniqueSlug() generates new ones.

BEGIN;

ALTER TABLE public.communities ADD COLUMN IF NOT EXISTS slug TEXT;

-- Backfill: lowercase the name, replace runs of non-alphanumeric characters
-- with a single hyphen, trim leading/trailing hyphens. Two communities whose
-- names collapse to the same slug (e.g. "Dog's Club" and "Dogs Club") get
-- `-<id>` appended to every row after the first, keeping the backfill
-- collision-free without needing app code to run it.
WITH base AS (
  SELECT id,
         NULLIF(regexp_replace(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), '') AS base_slug
  FROM public.communities
),
ranked AS (
  SELECT id, base_slug,
         ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY id) AS rn
  FROM base
)
UPDATE public.communities c
SET slug = CASE WHEN ranked.rn = 1 THEN ranked.base_slug ELSE ranked.base_slug || '-' || ranked.id END
FROM ranked
WHERE c.id = ranked.id AND c.slug IS NULL AND ranked.base_slug IS NOT NULL;

-- A handful of edge-case names (emoji-only, etc.) can still backfill to
-- NULL above -- fall back to the numeric id as its own slug so every row
-- ends up with one.
UPDATE public.communities SET slug = id::text WHERE slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_communities_slug ON public.communities(slug);

COMMIT;
