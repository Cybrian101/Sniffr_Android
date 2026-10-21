-- PawCircle event announcements: keep the chosen place's name next to its
-- coordinates, so the announcement can show where the event is.
--
-- Run by hand in the Supabase SQL editor. Additive and idempotent: safe to run
-- twice. The backend works with or without it (it only writes location_name
-- once the column exists); until it's run, events show "Event location" with
-- the Open in Maps link.

ALTER TABLE public.community_announcements ADD COLUMN IF NOT EXISTS location_name TEXT;
