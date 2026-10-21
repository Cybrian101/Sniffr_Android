-- Post reporting hardening (QA handoff M18/L5: "report counts can race").
--
-- Run by hand in the Supabase SQL editor, BEFORE deploying the backend
-- change that relies on it (models/PostRepository.js's reportPost, now an
-- `INSERT ... ON CONFLICT (post_id, user_id) DO NOTHING`). Without this
-- constraint, two concurrent report requests from the same user could both
-- pass the old check-then-insert and both count, inflating reported_count
-- past what the real number of distinct reporters supports.
--
-- Safe to run twice. If duplicate (post_id, user_id) rows already exist
-- (possible under the old racy code), the ADD CONSTRAINT below fails --
-- run the cleanup SELECT/DELETE first in that case (commented out, opt-in).

-- Uncomment to see existing duplicates before adding the constraint:
-- SELECT post_id, user_id, COUNT(*) FROM public.post_reports GROUP BY post_id, user_id HAVING COUNT(*) > 1;

-- Uncomment to remove duplicates, keeping the earliest report per (post_id, user_id):
-- DELETE FROM public.post_reports a USING public.post_reports b
--   WHERE a.post_id = b.post_id AND a.user_id = b.user_id AND a.id > b.id;

ALTER TABLE public.post_reports
  ADD CONSTRAINT post_reports_post_user_unique UNIQUE (post_id, user_id);

-- ── Verification (read-only) ──────────────────────────────────────────
SELECT conname FROM pg_constraint WHERE conname = 'post_reports_post_user_unique';
