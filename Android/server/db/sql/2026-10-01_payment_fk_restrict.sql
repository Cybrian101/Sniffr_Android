-- ════════════════════════════════════════════════════════════════════════
-- Part E: payments keep their link to a deleted account
-- ════════════════════════════════════════════════════════════════════════
-- payment_sessions.user_id and plan_history.user_id switch from
-- ON DELETE CASCADE to ON DELETE RESTRICT: a users row with payments can no
-- longer be hard-deleted (which would silently erase financial records).
-- Account deletion never hard-deletes -- it tombstones the user (deleted_at)
-- and keeps the payments linked.
--
-- RUN ONLY AFTER the new backend is live on Render: the old backend's
-- POST /api/privacy/delete hard-deletes users and would start failing for
-- anyone with a payment. The new backend answers that endpoint with 410.
--
-- Idempotent: each constraint is replaced only if it isn't RESTRICT yet,
-- under the same name, so running this twice changes nothing. The whole
-- change is one transaction. Supabase SQL editor: paste and run all of it.

BEGIN;

DO $$
BEGIN
  -- payment_sessions.user_id -> users.id
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_sessions_user_id_fkey'
      AND conrelid = 'public.payment_sessions'::regclass
      AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE public.payment_sessions DROP CONSTRAINT payment_sessions_user_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_sessions_user_id_fkey'
      AND conrelid = 'public.payment_sessions'::regclass
  ) THEN
    ALTER TABLE public.payment_sessions
      ADD CONSTRAINT payment_sessions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;

  -- plan_history.user_id -> users.id
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_history_user_id_fkey'
      AND conrelid = 'public.plan_history'::regclass
      AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE public.plan_history DROP CONSTRAINT plan_history_user_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_history_user_id_fkey'
      AND conrelid = 'public.plan_history'::regclass
  ) THEN
    ALTER TABLE public.plan_history
      ADD CONSTRAINT plan_history_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;

-- ── Verification (read-only) ──────────────────────────────────────────
-- Expect exactly 2 rows, both ending in "ON DELETE RESTRICT":
--   payment_sessions | payment_sessions_user_id_fkey | FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
--   plan_history     | plan_history_user_id_fkey     | FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
SELECT cl.relname AS table_name, con.conname AS constraint_name, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class cl ON cl.oid = con.conrelid
WHERE con.contype = 'f'
  AND cl.relnamespace = 'public'::regnamespace
  AND con.conname IN ('payment_sessions_user_id_fkey', 'plan_history_user_id_fkey')
ORDER BY 1;
