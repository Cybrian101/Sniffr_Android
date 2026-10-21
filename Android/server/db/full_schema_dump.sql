-- Auto-generated schema dump from live local Postgres (sniffr_dev)
-- Generated 2026-09-03T16:50:04.385Z

-- ============================================================
-- Enum types
-- ============================================================
DO $$ BEGIN
  CREATE TYPE plan_source_enum AS ENUM ('none', 'paid', 'launch_offer');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE plan_tier_enum AS ENUM ('free', 'plus', 'gold', 'platinum');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE subscription_status_enum AS ENUM ('inactive', 'active', 'cancelled', 'expired');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ============================================================
-- Table: app_ratings
-- ============================================================
CREATE TABLE IF NOT EXISTS app_ratings (
  id                                  SERIAL NOT NULL,
  user_id                             INTEGER,
  rating                              INTEGER NOT NULL,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT app_ratings_user_id_key UNIQUE (user_id),
  CONSTRAINT app_ratings_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
  CONSTRAINT app_ratings_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT app_ratings_rating_not_null CHECK (rating IS NOT NULL)
);


-- ============================================================
-- Table: blocked_users
-- ============================================================
CREATE TABLE IF NOT EXISTS blocked_users (
  id                                  SERIAL NOT NULL,
  blocker_id                          INTEGER,
  blocked_id                          INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT blocked_users_blocker_id_blocked_id_key UNIQUE (blocker_id, blocked_id),
  CONSTRAINT blocked_users_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_blocked_users_blocked ON public.blocked_users USING btree (blocked_id);
CREATE INDEX idx_blocked_users_blocker ON public.blocked_users USING btree (blocker_id);

-- ============================================================
-- Table: calls
-- ============================================================
CREATE TABLE IF NOT EXISTS calls (
  id                                  SERIAL NOT NULL,
  caller_pet_id                       INTEGER,
  receiver_pet_id                     INTEGER,
  type                                TEXT,
  status                              TEXT,
  declined_by                         TEXT,
  duration                            INTEGER DEFAULT 0,
  start_time                          TEXT,
  end_time                            TEXT,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT calls_type_check CHECK ((type = ANY (ARRAY['audio'::text, 'video'::text]))),
  CONSTRAINT calls_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'missed'::text, 'declined'::text, 'failed'::text]))),
  CONSTRAINT calls_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_calls_caller ON public.calls USING btree (caller_pet_id);
CREATE INDEX idx_calls_receiver ON public.calls USING btree (receiver_pet_id);

-- ============================================================
-- Table: comments
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
  id                                  SERIAL NOT NULL,
  post_id                             INTEGER,
  user_id                             INTEGER,
  content                             TEXT NOT NULL,
  parent_comment_id                   INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT comments_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT comments_content_not_null CHECK (content IS NOT NULL)
);

CREATE INDEX idx_comments_parent ON public.comments USING btree (parent_comment_id);
CREATE INDEX idx_comments_post ON public.comments USING btree (post_id);

-- ============================================================
-- Table: communities
-- ============================================================
CREATE TABLE IF NOT EXISTS communities (
  id                                  SERIAL NOT NULL,
  name                                TEXT NOT NULL,
  description                         TEXT,
  category                            TEXT,
  breed                               TEXT,
  pet_type                            TEXT,
  city                                TEXT,
  cover_image                         TEXT,
  icon_image                          TEXT,
  is_private                          INTEGER DEFAULT 0,
  rules                               TEXT,
  created_by                          INTEGER,
  member_count                        INTEGER DEFAULT 1,
  invite_code                         TEXT,
  tags                                TEXT,
  verified                            INTEGER DEFAULT 0,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT communities_invite_code_key UNIQUE (invite_code),
  CONSTRAINT communities_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT communities_name_not_null CHECK (name IS NOT NULL)
);

CREATE INDEX idx_communities_created_by ON public.communities USING btree (created_by);

-- ============================================================
-- Table: community_announcements
-- ============================================================
CREATE TABLE IF NOT EXISTS community_announcements (
  id                                  SERIAL NOT NULL,
  community_id                        INTEGER,
  sender_id                           INTEGER,
  title                               TEXT NOT NULL,
  content                             TEXT NOT NULL,
  latitude                            DOUBLE PRECISION,
  longitude                           DOUBLE PRECISION,
  is_event                            INTEGER DEFAULT 0,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT community_announcements_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT community_announcements_title_not_null CHECK (title IS NOT NULL),
  CONSTRAINT community_announcements_content_not_null CHECK (content IS NOT NULL)
);

CREATE INDEX idx_community_announcements_community ON public.community_announcements USING btree (community_id);

-- ============================================================
-- Table: community_events
-- ============================================================
CREATE TABLE IF NOT EXISTS community_events (
  id                                  SERIAL NOT NULL,
  community_id                        INTEGER,
  title                               TEXT NOT NULL,
  description                         TEXT,
  event_date                          TEXT,
  location                            TEXT,
  created_by                          INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT community_events_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT community_events_title_not_null CHECK (title IS NOT NULL)
);

CREATE INDEX idx_community_events_community ON public.community_events USING btree (community_id);

-- ============================================================
-- Table: community_join_requests
-- ============================================================
CREATE TABLE IF NOT EXISTS community_join_requests (
  id                                  SERIAL NOT NULL,
  community_id                        INTEGER,
  user_id                             INTEGER,
  status                              TEXT DEFAULT 'pending'::text,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT community_join_requests_community_id_user_id_key UNIQUE (community_id, user_id),
  CONSTRAINT community_join_requests_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_community_join_requests_community ON public.community_join_requests USING btree (community_id);

-- ============================================================
-- Table: community_members
-- ============================================================
CREATE TABLE IF NOT EXISTS community_members (
  id                                  SERIAL NOT NULL,
  community_id                        INTEGER,
  user_id                             INTEGER,
  role                                TEXT DEFAULT 'Member'::text,
  verified_badge                      TEXT,
  last_active_at                      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  joined_at                           TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  cleared_at                          TIMESTAMPTZ,
  is_hidden                           INTEGER DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT community_members_community_id_user_id_key UNIQUE (community_id, user_id),
  CONSTRAINT community_members_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_community_members_community ON public.community_members USING btree (community_id);
CREATE INDEX idx_community_members_user ON public.community_members USING btree (user_id);

-- ============================================================
-- Table: community_message_reactions
-- ============================================================
CREATE TABLE IF NOT EXISTS community_message_reactions (
  id                                  SERIAL NOT NULL,
  community_message_id                INTEGER,
  user_id                             INTEGER,
  reaction                            TEXT NOT NULL,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT community_message_reactions_community_message_id_user_id_key UNIQUE (community_message_id, user_id),
  CONSTRAINT community_message_reactions_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT community_message_reactions_reaction_not_null CHECK (reaction IS NOT NULL)
);

CREATE INDEX idx_community_message_reactions_msg ON public.community_message_reactions USING btree (community_message_id);

-- ============================================================
-- Table: community_messages
-- ============================================================
CREATE TABLE IF NOT EXISTS community_messages (
  id                                  SERIAL NOT NULL,
  community_id                        INTEGER,
  sender_id                           INTEGER,
  content                             TEXT,
  media_url                           TEXT,
  message_type                        TEXT DEFAULT 'text'::text,
  is_announcement                     INTEGER DEFAULT 0,
  is_pinned                           INTEGER DEFAULT 0,
  reply_to_id                         INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT community_messages_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_community_messages_community ON public.community_messages USING btree (community_id);

-- ============================================================
-- Table: community_photos
-- ============================================================
CREATE TABLE IF NOT EXISTS community_photos (
  id                                  SERIAL NOT NULL,
  community_id                        INTEGER,
  user_id                             INTEGER,
  media_url                           TEXT NOT NULL,
  caption                             TEXT,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT community_photos_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT community_photos_media_url_not_null CHECK (media_url IS NOT NULL)
);

CREATE INDEX idx_community_photos_community ON public.community_photos USING btree (community_id);

-- ============================================================
-- Table: community_polls
-- ============================================================
CREATE TABLE IF NOT EXISTS community_polls (
  id                                  SERIAL NOT NULL,
  community_id                        INTEGER,
  question                            TEXT NOT NULL,
  options_json                        TEXT NOT NULL,
  votes_json                          TEXT DEFAULT '{}'::text,
  created_by                          INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT community_polls_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT community_polls_question_not_null CHECK (question IS NOT NULL),
  CONSTRAINT community_polls_options_json_not_null CHECK (options_json IS NOT NULL)
);

CREATE INDEX idx_community_polls_community ON public.community_polls USING btree (community_id);

-- ============================================================
-- Table: conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id                                  SERIAL NOT NULL,
  match_id                            INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT conversations_match_id_key UNIQUE (match_id),
  CONSTRAINT conversations_id_not_null CHECK (id IS NOT NULL)
);


-- ============================================================
-- Table: likes
-- ============================================================
CREATE TABLE IF NOT EXISTS likes (
  id                                  SERIAL NOT NULL,
  post_id                             INTEGER,
  user_id                             INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT likes_post_id_user_id_key UNIQUE (post_id, user_id),
  CONSTRAINT likes_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_likes_created ON public.likes USING btree (created_at);
CREATE INDEX idx_likes_post ON public.likes USING btree (post_id);

-- ============================================================
-- Table: matches
-- ============================================================
CREATE TABLE IF NOT EXISTS matches (
  id                                  SERIAL NOT NULL,
  pet1_id                             INTEGER,
  pet2_id                             INTEGER,
  source                              TEXT DEFAULT 'meet'::text NOT NULL,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT matches_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT matches_source_not_null CHECK (source IS NOT NULL)
);

CREATE INDEX idx_matches_pet1 ON public.matches USING btree (pet1_id);
CREATE INDEX idx_matches_pet2 ON public.matches USING btree (pet2_id);

-- ============================================================
-- Table: message_reactions
-- ============================================================
CREATE TABLE IF NOT EXISTS message_reactions (
  id                                  SERIAL NOT NULL,
  message_id                          INTEGER,
  user_id                             INTEGER,
  reaction                            TEXT NOT NULL,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT message_reactions_message_id_user_id_key UNIQUE (message_id, user_id),
  CONSTRAINT message_reactions_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT message_reactions_reaction_not_null CHECK (reaction IS NOT NULL)
);

CREATE INDEX idx_message_reactions_message ON public.message_reactions USING btree (message_id);

-- ============================================================
-- Table: messages
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id                                  SERIAL NOT NULL,
  conversation_id                     INTEGER,
  sender_id                           INTEGER,
  content                             TEXT,
  media_url                           TEXT,
  message_type                        TEXT DEFAULT 'text'::text,
  status                              TEXT DEFAULT 'sent'::text,
  delivered_at                        TIMESTAMPTZ,
  seen_at                             TIMESTAMPTZ,
  reply_to_id                         INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT messages_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_messages_conv ON public.messages USING btree (conversation_id);
CREATE INDEX idx_messages_sender ON public.messages USING btree (sender_id);

-- ============================================================
-- Table: notification_preferences
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_preferences (
  id                                  SERIAL NOT NULL,
  user_id                             INTEGER,
  matches                             INTEGER DEFAULT 1,
  activity                            INTEGER DEFAULT 1,
  pawcircle                           INTEGER DEFAULT 1,
  nearby                              INTEGER DEFAULT 1,
  offers                              INTEGER DEFAULT 1,
  email                               INTEGER DEFAULT 1,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT notification_preferences_user_id_key UNIQUE (user_id),
  CONSTRAINT notification_preferences_id_not_null CHECK (id IS NOT NULL)
);


-- ============================================================
-- Table: notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id                                  SERIAL NOT NULL,
  user_id                             INTEGER,
  category                            TEXT NOT NULL,
  type                                TEXT NOT NULL,
  title                               TEXT NOT NULL,
  description                         TEXT NOT NULL,
  avatar_url                          TEXT,
  target_id                           TEXT,
  sender_pet_id                       INTEGER,
  is_read                             INTEGER DEFAULT 0,
  action_status                       TEXT DEFAULT 'pending'::text,
  metadata_json                       TEXT,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT notifications_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT notifications_category_not_null CHECK (category IS NOT NULL),
  CONSTRAINT notifications_type_not_null CHECK (type IS NOT NULL),
  CONSTRAINT notifications_title_not_null CHECK (title IS NOT NULL),
  CONSTRAINT notifications_description_not_null CHECK (description IS NOT NULL)
);

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id);
CREATE INDEX idx_notifications_user_read ON public.notifications USING btree (user_id, is_read);
CREATE INDEX idx_notifications_user_type_target ON public.notifications USING btree (user_id, type, target_id);

-- ============================================================
-- Table: payment_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_sessions (
  id                                  SERIAL NOT NULL,
  user_id                             INTEGER,
  plan                                plan_tier_enum NOT NULL,
  amount                              DOUBLE PRECISION NOT NULL,
  provider                            TEXT DEFAULT 'mock'::text NOT NULL,
  status                              TEXT DEFAULT 'pending'::text NOT NULL,
  provider_reference                  TEXT,
  payment_method                      TEXT,
  upi_transaction_id                  TEXT,
  proof_url                           TEXT,
  submitted_at                        TIMESTAMPTZ,
  reviewed_at                         TIMESTAMPTZ,
  reviewed_by                         INTEGER,
  rejection_reason                    TEXT,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  completed_at                        TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT payment_sessions_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT payment_sessions_plan_not_null CHECK (plan IS NOT NULL),
  CONSTRAINT payment_sessions_amount_not_null CHECK (amount IS NOT NULL),
  CONSTRAINT payment_sessions_provider_not_null CHECK (provider IS NOT NULL),
  CONSTRAINT payment_sessions_status_not_null CHECK (status IS NOT NULL)
);

CREATE INDEX idx_payment_sessions_status ON public.payment_sessions USING btree (status);
CREATE INDEX idx_payment_sessions_user ON public.payment_sessions USING btree (user_id);

-- ============================================================
-- Table: pets
-- ============================================================
CREATE TABLE IF NOT EXISTS pets (
  id                                  SERIAL NOT NULL,
  user_id                             INTEGER,
  name                                TEXT NOT NULL,
  pet_username                        TEXT,
  type                                TEXT,
  gender                              TEXT,
  age                                 INTEGER,
  breed_type                          TEXT,
  breed_name                          TEXT,
  avatar_url                          TEXT,
  vaccinated                          INTEGER DEFAULT 0,
  pet_kyc                             INTEGER DEFAULT 0,
  latitude                            DOUBLE PRECISION,
  longitude                           DOUBLE PRECISION,
  location_text                       TEXT,
  bio                                 TEXT,
  pawsitive_score                     INTEGER DEFAULT 50,
  is_flagged                          INTEGER DEFAULT 0,
  reported_count                      INTEGER DEFAULT 0,
  last_updated_location_timestamp     TEXT,
  country                             TEXT,
  state                               TEXT,
  city                                TEXT,
  area                                TEXT,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT pets_pet_username_key UNIQUE (pet_username),
  CONSTRAINT pets_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT pets_name_not_null CHECK (name IS NOT NULL)
);

CREATE INDEX idx_pets_geo ON public.pets USING btree (latitude, longitude);
CREATE INDEX idx_pets_lat ON public.pets USING btree (latitude);
CREATE INDEX idx_pets_lng ON public.pets USING btree (longitude);
CREATE INDEX idx_pets_user ON public.pets USING btree (user_id);

-- ============================================================
-- Table: plan_history
-- ============================================================
CREATE TABLE IF NOT EXISTS plan_history (
  id                                  SERIAL NOT NULL,
  user_id                             INTEGER,
  plan                                plan_tier_enum NOT NULL,
  source                              plan_source_enum NOT NULL,
  action                              TEXT NOT NULL,
  amount_paid                         DOUBLE PRECISION DEFAULT 0,
  previous_plan                       plan_tier_enum,
  payment_session_id                  INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT plan_history_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT plan_history_plan_not_null CHECK (plan IS NOT NULL),
  CONSTRAINT plan_history_source_not_null CHECK (source IS NOT NULL),
  CONSTRAINT plan_history_action_not_null CHECK (action IS NOT NULL)
);

CREATE INDEX idx_plan_history_user ON public.plan_history USING btree (user_id);

-- ============================================================
-- Table: post_reports
-- ============================================================
CREATE TABLE IF NOT EXISTS post_reports (
  id                                  SERIAL NOT NULL,
  post_id                             INTEGER,
  user_id                             INTEGER,
  reason                              TEXT,
  status                              TEXT,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT post_reports_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_post_reports_post ON public.post_reports USING btree (post_id);
CREATE INDEX idx_post_reports_user ON public.post_reports USING btree (user_id);

-- ============================================================
-- Table: posts
-- ============================================================
CREATE TABLE IF NOT EXISTS posts (
  id                                  SERIAL NOT NULL,
  pet_id                              INTEGER,
  caption                             TEXT,
  media_url                           TEXT,
  media_type                          TEXT DEFAULT 'image'::text,
  is_flagged                          INTEGER DEFAULT 0,
  moderation_status                   TEXT DEFAULT 'approved'::text,
  reported_count                      INTEGER DEFAULT 0,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT posts_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_posts_created ON public.posts USING btree (created_at);
CREATE INDEX idx_posts_pet ON public.posts USING btree (pet_id);

-- ============================================================
-- Table: profile_views
-- ============================================================
CREATE TABLE IF NOT EXISTS profile_views (
  id                                  SERIAL NOT NULL,
  viewer_pet_id                       INTEGER,
  viewed_pet_id                       INTEGER,
  last_notified_at                    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT profile_views_viewer_pet_id_viewed_pet_id_key UNIQUE (viewer_pet_id, viewed_pet_id),
  CONSTRAINT profile_views_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_profile_views_viewed ON public.profile_views USING btree (viewed_pet_id);
CREATE INDEX idx_profile_views_viewer ON public.profile_views USING btree (viewer_pet_id);

-- ============================================================
-- Table: reactions
-- ============================================================
CREATE TABLE IF NOT EXISTS reactions (
  id                                  SERIAL NOT NULL,
  post_id                             INTEGER,
  user_id                             INTEGER,
  reaction                            TEXT NOT NULL,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT reactions_post_id_user_id_key UNIQUE (post_id, user_id),
  CONSTRAINT reactions_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT reactions_reaction_not_null CHECK (reaction IS NOT NULL)
);

CREATE INDEX idx_reactions_post ON public.reactions USING btree (post_id);

-- ============================================================
-- Table: refresh_tokens
-- ============================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                                  SERIAL NOT NULL,
  user_id                             INTEGER,
  token_hash                          TEXT NOT NULL,
  device_info                         TEXT,
  expires_at                          TIMESTAMPTZ NOT NULL,
  revoked                             INTEGER DEFAULT 0,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT refresh_tokens_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT refresh_tokens_token_hash_not_null CHECK (token_hash IS NOT NULL),
  CONSTRAINT refresh_tokens_expires_at_not_null CHECK (expires_at IS NOT NULL)
);

CREATE INDEX idx_refresh_tokens_hash ON public.refresh_tokens USING btree (token_hash);
CREATE INDEX idx_refresh_tokens_user ON public.refresh_tokens USING btree (user_id);

-- ============================================================
-- Table: shares
-- ============================================================
CREATE TABLE IF NOT EXISTS shares (
  id                                  SERIAL NOT NULL,
  post_id                             INTEGER,
  user_id                             INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT shares_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_shares_post ON public.shares USING btree (post_id);

-- ============================================================
-- Table: spotlight_history
-- ============================================================
CREATE TABLE IF NOT EXISTS spotlight_history (
  id                                  SERIAL NOT NULL,
  pet_id                              INTEGER,
  area                                TEXT NOT NULL,
  score                               INTEGER DEFAULT 0,
  cycle_date                          TEXT NOT NULL,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT spotlight_history_area_cycle_date_key UNIQUE (area, cycle_date),
  CONSTRAINT spotlight_history_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT spotlight_history_area_not_null CHECK (area IS NOT NULL),
  CONSTRAINT spotlight_history_cycle_date_not_null CHECK (cycle_date IS NOT NULL)
);

CREATE INDEX idx_spotlight_history_date ON public.spotlight_history USING btree (cycle_date);
CREATE INDEX idx_spotlight_history_pet ON public.spotlight_history USING btree (pet_id);

-- ============================================================
-- Table: spotlight_rank_tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS spotlight_rank_tracking (
  id                                  SERIAL NOT NULL,
  pet_id                              INTEGER,
  area                                TEXT NOT NULL,
  last_notified_rank                  INTEGER,
  updated_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT spotlight_rank_tracking_pet_id_area_key UNIQUE (pet_id, area),
  CONSTRAINT spotlight_rank_tracking_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT spotlight_rank_tracking_area_not_null CHECK (area IS NOT NULL)
);

CREATE INDEX idx_spotlight_rank_tracking_pet ON public.spotlight_rank_tracking USING btree (pet_id);

-- ============================================================
-- Table: swipes
-- ============================================================
CREATE TABLE IF NOT EXISTS swipes (
  id                                  SERIAL NOT NULL,
  from_pet_id                         INTEGER,
  to_pet_id                           INTEGER,
  action                              TEXT,
  request_status                      TEXT DEFAULT 'awaiting'::text,
  status                              TEXT DEFAULT 'committed'::text,
  expires_at                          TIMESTAMPTZ,
  notification_id                     INTEGER,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT swipes_from_pet_id_to_pet_id_key UNIQUE (from_pet_id, to_pet_id),
  CONSTRAINT swipes_id_not_null CHECK (id IS NOT NULL)
);

CREATE INDEX idx_swipes_from ON public.swipes USING btree (from_pet_id);
CREATE INDEX idx_swipes_request_status ON public.swipes USING btree (request_status);
CREATE INDEX idx_swipes_to ON public.swipes USING btree (to_pet_id);

-- ============================================================
-- Table: trusted_devices
-- ============================================================
CREATE TABLE IF NOT EXISTS trusted_devices (
  id                                  SERIAL NOT NULL,
  user_id                             INTEGER,
  device_token                        TEXT NOT NULL,
  device_info                         TEXT,
  expires_at                          TIMESTAMPTZ NOT NULL,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT trusted_devices_device_token_key UNIQUE (device_token),
  CONSTRAINT trusted_devices_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT trusted_devices_device_token_not_null CHECK (device_token IS NOT NULL),
  CONSTRAINT trusted_devices_expires_at_not_null CHECK (expires_at IS NOT NULL)
);

CREATE INDEX idx_trusted_devices_user ON public.trusted_devices USING btree (user_id);

-- ============================================================
-- Table: users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id                                  SERIAL NOT NULL,
  email                               TEXT NOT NULL,
  username                            TEXT NOT NULL,
  password_hash                       TEXT NOT NULL,
  full_name                           TEXT,
  active_pet_id                       INTEGER,
  last_active_at                      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  reset_token                         TEXT,
  reset_token_expires_at              TIMESTAMPTZ,
  super_sniff_enabled                 INTEGER DEFAULT 0,
  current_plan                        plan_tier_enum DEFAULT 'free'::plan_tier_enum,
  plan_source                         plan_source_enum DEFAULT 'none'::plan_source_enum,
  subscription_status                 subscription_status_enum DEFAULT 'inactive'::subscription_status_enum,
  plan_start_date                     TIMESTAMPTZ,
  plan_expiry_date                    TIMESTAMPTZ,
  auto_renew                          INTEGER DEFAULT 0,
  premium_badge_enabled               INTEGER DEFAULT 1,
  is_founding_member                  INTEGER DEFAULT 0,
  welcome_slider_seen                 INTEGER DEFAULT 0,
  boost_credits_remaining             INTEGER DEFAULT 0,
  boost_credits_refreshed_at          TIMESTAMPTZ,
  email_verified                      INTEGER DEFAULT 0,
  email_verify_token                  TEXT,
  email_verify_expires_at             TIMESTAMPTZ,
  pawprint_2fa_enabled                INTEGER DEFAULT 0,
  paw_code                            TEXT,
  paw_code_expires_at                 TIMESTAMPTZ,
  pawprint_verify_token_hash          TEXT,
  pawprint_verify_expires_at          TIMESTAMPTZ,
  is_admin                            BOOLEAN DEFAULT false NOT NULL,
  created_at                          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_username_key UNIQUE (username),
  CONSTRAINT users_id_not_null CHECK (id IS NOT NULL),
  CONSTRAINT users_email_not_null CHECK (email IS NOT NULL),
  CONSTRAINT users_username_not_null CHECK (username IS NOT NULL),
  CONSTRAINT users_password_hash_not_null CHECK (password_hash IS NOT NULL),
  CONSTRAINT users_is_admin_not_null CHECK (is_admin IS NOT NULL)
);

CREATE INDEX idx_users_active_pet ON public.users USING btree (active_pet_id);

-- ============================================================
-- Foreign keys (added after all tables exist)
-- ============================================================
ALTER TABLE app_ratings ADD CONSTRAINT app_ratings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE blocked_users ADD CONSTRAINT blocked_users_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE blocked_users ADD CONSTRAINT blocked_users_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE calls ADD CONSTRAINT calls_caller_pet_id_fkey FOREIGN KEY (caller_pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE calls ADD CONSTRAINT calls_receiver_pet_id_fkey FOREIGN KEY (receiver_pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE comments ADD CONSTRAINT comments_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE comments ADD CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE communities ADD CONSTRAINT communities_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE community_announcements ADD CONSTRAINT community_announcements_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_announcements ADD CONSTRAINT community_announcements_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_events ADD CONSTRAINT community_events_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_events ADD CONSTRAINT community_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE community_join_requests ADD CONSTRAINT community_join_requests_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_join_requests ADD CONSTRAINT community_join_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_members ADD CONSTRAINT community_members_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_members ADD CONSTRAINT community_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_message_reactions ADD CONSTRAINT community_message_reactions_community_message_id_fkey FOREIGN KEY (community_message_id) REFERENCES community_messages(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_message_reactions ADD CONSTRAINT community_message_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_messages ADD CONSTRAINT community_messages_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_messages ADD CONSTRAINT community_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_messages ADD CONSTRAINT community_messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES community_messages(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE community_photos ADD CONSTRAINT community_photos_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_photos ADD CONSTRAINT community_photos_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_polls ADD CONSTRAINT community_polls_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE community_polls ADD CONSTRAINT community_polls_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE likes ADD CONSTRAINT likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE likes ADD CONSTRAINT likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE matches ADD CONSTRAINT matches_pet1_id_fkey FOREIGN KEY (pet1_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE matches ADD CONSTRAINT matches_pet2_id_fkey FOREIGN KEY (pet2_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_sender_pet_id_fkey FOREIGN KEY (sender_pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE payment_sessions ADD CONSTRAINT payment_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE payment_sessions ADD CONSTRAINT payment_sessions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE pets ADD CONSTRAINT pets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE plan_history ADD CONSTRAINT plan_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE plan_history ADD CONSTRAINT plan_history_payment_session_id_fkey FOREIGN KEY (payment_session_id) REFERENCES payment_sessions(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE post_reports ADD CONSTRAINT post_reports_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE post_reports ADD CONSTRAINT post_reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE posts ADD CONSTRAINT posts_pet_id_fkey FOREIGN KEY (pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE profile_views ADD CONSTRAINT profile_views_viewer_pet_id_fkey FOREIGN KEY (viewer_pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE profile_views ADD CONSTRAINT profile_views_viewed_pet_id_fkey FOREIGN KEY (viewed_pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE reactions ADD CONSTRAINT reactions_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE reactions ADD CONSTRAINT reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE shares ADD CONSTRAINT shares_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE shares ADD CONSTRAINT shares_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE spotlight_history ADD CONSTRAINT spotlight_history_pet_id_fkey FOREIGN KEY (pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE spotlight_rank_tracking ADD CONSTRAINT spotlight_rank_tracking_pet_id_fkey FOREIGN KEY (pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE swipes ADD CONSTRAINT swipes_from_pet_id_fkey FOREIGN KEY (from_pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE swipes ADD CONSTRAINT swipes_to_pet_id_fkey FOREIGN KEY (to_pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE swipes ADD CONSTRAINT swipes_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notifications(id) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE trusted_devices ADD CONSTRAINT trusted_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE users ADD CONSTRAINT fk_users_active_pet FOREIGN KEY (active_pet_id) REFERENCES pets(id) ON UPDATE NO ACTION ON DELETE SET NULL;

