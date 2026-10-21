-- POST /communities already rejected a duplicate name with a SELECT-then-
-- INSERT check, but with no DB-level constraint backing it, two concurrent
-- creates (a double-tap on "Create", a retried request after a slow
-- response that actually went through) could both pass the check before
-- either committed -- which is how production ended up with two circles
-- both named "Simba". This adds the real backstop: a case-insensitive
-- unique index, so the second of any such race now fails at the database
-- instead of silently succeeding.
--
-- Run by hand in the Supabase SQL editor, BEFORE deploying the backend that
-- uses it (routes/communities.js now catches 23505 on this index and
-- returns the same DUPLICATE_NAME response the pre-check already gave).
-- NOT safely re-runnable if a new duplicate has appeared since the first
-- run (the rename step below only renames rows that still collide) --
-- safe to run again, just a no-op for anything already resolved.

BEGIN;

-- Names were stored with whatever leading/trailing whitespace the request
-- body had (the duplicate-name check trimmed before comparing, but nothing
-- trimmed before storing) -- e.g. production has a circle literally named
-- "Indies " (trailing space). Harmless on its own, but untrimmed vs.
-- trimmed versions of the same name wouldn't collide under the new index
-- the way a user would expect them to.
UPDATE public.communities SET name = btrim(name) WHERE name <> btrim(name);

-- Resolve existing collisions: keep the oldest circle's name as-is, append
-- " (2)", " (3)", ... to every later one sharing the same name
-- case-insensitively, so the index below has nothing left to conflict with.
WITH ranked AS (
  SELECT id, name,
         ROW_NUMBER() OVER (PARTITION BY lower(name) ORDER BY id) AS rn
  FROM public.communities
)
UPDATE public.communities c
SET name = c.name || ' (' || ranked.rn || ')'
FROM ranked
WHERE c.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_communities_name_unique ON public.communities(lower(name));

COMMIT;
