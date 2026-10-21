-- Payment proofs: private Supabase Storage instead of public Cloudinary URLs.
--
-- Run by hand in the Supabase SQL editor, BEFORE deploying the backend that
-- stores proofs in the "payment-proofs" bucket: the proof upload and the
-- admin payments list both use this column.
--
-- proof_storage_path holds the object path inside the private bucket
-- ("<userId>/<sessionId>-<random>.<ext>"); admins get a 5-minute signed URL
-- for it. proof_url stays as it is for older proofs (public Cloudinary URLs)
-- and is no longer written. Additive and idempotent: safe to run twice.
-- RLS and the bucket's policies are not touched.

ALTER TABLE public.payment_sessions ADD COLUMN IF NOT EXISTS proof_storage_path TEXT;

-- ── Verification (read-only) ──────────────────────────────────────────
-- Expect one row: proof_storage_path | text | YES
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'payment_sessions' AND column_name = 'proof_storage_path';
