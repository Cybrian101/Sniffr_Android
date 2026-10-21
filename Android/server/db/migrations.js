import db from './connection.js';

// Premium subscription enums (Postgres-only -- this file's CREATE TABLE
// statements use SQLite-flavored syntax like INTEGER PRIMARY KEY AUTOINCREMENT
// and are never actually run against Postgres; runMigrations() is dead code,
// never invoked at server startup. Real schema changes are applied directly
// against the live Supabase DB via ad-hoc scripts. Kept here purely as
// documentation of the current live schema, matching this file's existing
// role for every other table below.
//   CREATE TYPE plan_tier_enum AS ENUM ('free', 'plus', 'gold', 'platinum');
//   CREATE TYPE plan_source_enum AS ENUM ('none', 'paid', 'launch_offer');
//   CREATE TYPE subscription_status_enum AS ENUM ('inactive', 'active', 'cancelled', 'expired');

export function runMigrations() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      active_pet_id INTEGER,
      last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reset_token TEXT,
      reset_token_expires_at DATETIME,
      super_sniff_enabled INTEGER DEFAULT 0,
      current_plan plan_tier_enum DEFAULT 'free',
      plan_source plan_source_enum DEFAULT 'none',
      subscription_status subscription_status_enum DEFAULT 'inactive',
      plan_start_date DATETIME,
      plan_expiry_date DATETIME,
      auto_renew INTEGER DEFAULT 0,
      premium_badge_enabled INTEGER DEFAULT 1,
      is_founding_member INTEGER DEFAULT 0,
      welcome_slider_seen INTEGER DEFAULT 0,
      boost_credits_remaining INTEGER DEFAULT 0,
      boost_credits_refreshed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      device_info TEXT,
      expires_at DATETIME NOT NULL,
      revoked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS pets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      pet_username TEXT UNIQUE,
      type TEXT,
      gender TEXT,
      age INTEGER,
      breed_type TEXT,
      breed_name TEXT,
      avatar_url TEXT,
      vaccinated INTEGER DEFAULT 0,
      pet_kyc INTEGER DEFAULT 0,
      latitude REAL,
      longitude REAL,
      location_text TEXT,
      bio TEXT,
      pawsitive_score INTEGER DEFAULT 50,
      is_flagged INTEGER DEFAULT 0,
      reported_count INTEGER DEFAULT 0,
      last_updated_location_timestamp TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      caption TEXT,
      media_url TEXT,
      media_type TEXT DEFAULT 'image',
      is_flagged INTEGER DEFAULT 0,
      moderation_status TEXT DEFAULT 'approved',
      reported_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS swipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      to_pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      action TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'committed',
      notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
      UNIQUE(from_pet_id, to_pet_id)
    )`,
    `CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pet1_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      pet2_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT,
      media_url TEXT,
      message_type TEXT DEFAULT 'text',
      status TEXT DEFAULT 'sent',
      delivered_at DATETIME,
      seen_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      receiver_pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      type TEXT CHECK(type IN ('audio', 'video')),
      status TEXT CHECK(status IN ('completed', 'missed', 'declined', 'failed')),
      declined_by TEXT,
      duration INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS communities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      breed TEXT,
      pet_type TEXT,
      city TEXT,
      cover_image TEXT,
      icon_image TEXT,
      is_private INTEGER DEFAULT 0,
      rules TEXT,
      created_by INTEGER,
      member_count INTEGER DEFAULT 1,
      invite_code TEXT UNIQUE,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS community_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'Member',
      verified_badge TEXT,
      last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(community_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS community_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT,
      media_url TEXT,
      message_type TEXT DEFAULT 'text',
      is_announcement INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      reply_to_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS community_announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS community_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT NOT NULL,
      caption TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS community_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      event_date TEXT,
      location TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS community_polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      votes_json TEXT DEFAULT '{}',
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS community_join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(community_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // UNIQUE(post_id, user_id) added by db/sql/2026-10-10_post_reports_unique.sql
    // (QA handoff M18) -- a concurrent duplicate report from the same user
    // used to be able to race past the old check-then-insert in
    // PostRepository.reportPost and inflate reported_count.
    `CREATE TABLE IF NOT EXISTS post_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (post_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      reaction TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS message_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      reaction TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS blocked_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocker_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(blocker_id, blocked_id)
    )`,
    `CREATE TABLE IF NOT EXISTS spotlight_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      area TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      cycle_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(area, cycle_date)
    )`,
    `CREATE TABLE IF NOT EXISTS spotlight_rank_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      area TEXT NOT NULL,
      last_notified_rank INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pet_id, area)
    )`,
    `CREATE TABLE IF NOT EXISTS profile_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      viewer_pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      viewed_pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      last_notified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(viewer_pet_id, viewed_pet_id)
    )`,
    // Tracks a checkout attempt through a payment gateway (mock today;
    // Razorpay/Stripe/Apple Pay/Google Play later), independent of
    // plan_history -- a session that's created but never confirmed (user
    // abandons checkout) just sits at status='pending' and never touches
    // the user's actual plan. Only confirmCheckoutSession() flips it to
    // 'succeeded' and THEN calls subscribeToPlan(). provider_reference is
    // the gateway's own order/payment-intent id, for reconciliation.
    //
    // payment_method / upi_transaction_id / proof_url / submitted_at /
    // reviewed_at / reviewed_by / rejection_reason support the manual UPI
    // review flow (not yet wired up): user submits upi_transaction_id +
    // proof_url (status -> 'pending_review'), an admin reviews and sets
    // status to 'succeeded' (only then does subscribeToPlan() run) or
    // 'rejected' (with rejection_reason). All seven are nullable and
    // untouched by the existing mock-gateway path. status stays plain TEXT
    // with no CHECK constraint -- same as plan_history.action -- so a new
    // status value never needs a migration.
    `CREATE TABLE IF NOT EXISTS payment_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      plan plan_tier_enum NOT NULL,
      amount REAL NOT NULL,
      provider TEXT NOT NULL DEFAULT 'mock',
      status TEXT NOT NULL DEFAULT 'pending',
      provider_reference TEXT,
      payment_method TEXT,
      upi_transaction_id TEXT,
      proof_url TEXT,
      submitted_at DATETIME,
      reviewed_at DATETIME,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      rejection_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )`,
    // action is free TEXT (not an enum) by design, so new billing events
    // (e.g. 'refunded') never need a migration -- current values in use:
    // 'subscribed' | 'renewed' | 'upgraded' | 'downgraded' | 'cancelled' |
    // 'expired' | 'launch_offer_granted'. previous_plan is set only for
    // 'upgraded'/'downgraded' rows (lets the UI show "Upgraded from Plus").
    // payment_session_id links a paid row back to the payment_sessions row
    // that triggered it, for future gateway reconciliation/refund lookups.
    `CREATE TABLE IF NOT EXISTS plan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      plan plan_tier_enum NOT NULL,
      source plan_source_enum NOT NULL,
      action TEXT NOT NULL,
      amount_paid REAL DEFAULT 0,
      previous_plan plan_tier_enum,
      payment_session_id INTEGER REFERENCES payment_sessions(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      avatar_url TEXT,
      target_id TEXT,
      sender_pet_id INTEGER,
      is_read INTEGER DEFAULT 0,
      action_status TEXT DEFAULT 'pending',
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // App rating (Settings -> Rate Sniffr). One row per user (UNIQUE) --
    // resubmitting updates it in place instead of creating a duplicate.
    // NOTE: runMigrations() is not invoked at startup (see file header) --
    // this table must be created on the live Supabase DB by hand.
    `CREATE TABLE IF NOT EXISTS app_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      matches INTEGER DEFAULT 1,
      activity INTEGER DEFAULT 1,
      pawcircle INTEGER DEFAULT 1,
      nearby INTEGER DEFAULT 1,
      offers INTEGER DEFAULT 1,
      email INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS trusted_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      device_token TEXT UNIQUE NOT NULL,
      device_info TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // Which Supabase Auth sessions (by GoTrue session_id) have completed
    // PawPrint 2FA -- see db/sql/2026-10-10_pawprint_verified_sessions.sql
    // (that file is what actually gets run by hand on Supabase) and
    // middleware/auth.js's resolveUserFromToken (QA handoff H1).
    `CREATE TABLE IF NOT EXISTS pawprint_verified_sessions (
      session_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      verified_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // ── Account deletion ("SniffedOut") ──────────────────────────────
    // The four entries below (tables here; columns/indexes in the lists
    // further down) mirror server/db/sql/2026-09-30_account_deletion_schema.sql,
    // which is what actually gets run by hand on Supabase. That file also
    // enables RLS on the three new tables.
    //
    // Delete-account email codes: only an HMAC of the code is stored;
    // attempts / expiry / single use tracked in the row.
    `CREATE TABLE IF NOT EXISTS verification_codes (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('delete_account')),
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      invalidated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Cloudinary purge queue, filled inside the deletion transaction and
    // retried hourly. No FK to users on purpose.
    `CREATE TABLE IF NOT EXISTS pending_media_deletions (
      id BIGSERIAL PRIMARY KEY,
      public_id TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('image', 'video', 'raw')),
      source TEXT NOT NULL,
      deleted_user_id INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (public_id, resource_type)
    )`,
    // Supabase Auth identities of deleted accounts, deleted after COMMIT and
    // retried hourly (see db/sql/2026-10-01_pending_auth_deletions.sql).
    `CREATE TABLE IF NOT EXISTS pending_auth_deletions (
      id BIGSERIAL PRIMARY KEY,
      auth_user_id UUID NOT NULL UNIQUE,
      deleted_user_id INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Hook for a future PawCircle "Transfer Ownership" feature -- no
    // endpoints use it yet. Valid for 5 days from when it was sent.
    `CREATE TABLE IF NOT EXISTS community_ownership_transfers (
      id SERIAL PRIMARY KEY,
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 days'),
      responded_at TIMESTAMPTZ
    )`
  ];

  tables.forEach(sql => db.exec(sql));

  // Additive migrations (safe to re-run — ignore errors if column exists)
  const alterations = [
    // pets — new columns
    `ALTER TABLE pets ADD COLUMN pawsitive_score INTEGER DEFAULT 50`,
    `ALTER TABLE pets ADD COLUMN is_flagged INTEGER DEFAULT 0`,
    `ALTER TABLE pets ADD COLUMN reported_count INTEGER DEFAULT 0`,
    `ALTER TABLE pets ADD COLUMN country TEXT`,
    `ALTER TABLE pets ADD COLUMN state TEXT`,
    `ALTER TABLE pets ADD COLUMN city TEXT`,
    `ALTER TABLE pets ADD COLUMN area TEXT`,
    // posts — moderation fields
    `ALTER TABLE posts ADD COLUMN is_flagged INTEGER DEFAULT 0`,
    `ALTER TABLE posts ADD COLUMN moderation_status TEXT DEFAULT 'approved'`,
    `ALTER TABLE posts ADD COLUMN reported_count INTEGER DEFAULT 0`,
    // calls — extended fields
    `ALTER TABLE calls ADD COLUMN declined_by TEXT`,
    // communities & users — presence & tag matching
    `ALTER TABLE communities ADD COLUMN tags TEXT`,
    `ALTER TABLE users ADD COLUMN last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN reset_token TEXT`,
    `ALTER TABLE users ADD COLUMN reset_token_expires_at DATETIME`,
    `ALTER TABLE pets ADD COLUMN last_updated_location_timestamp TEXT`,
    `ALTER TABLE calls ADD COLUMN start_time TEXT`,
    `ALTER TABLE calls ADD COLUMN end_time TEXT`,
    `ALTER TABLE communities ADD COLUMN verified INTEGER DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN reply_to_id INTEGER`,
    `ALTER TABLE comments ADD COLUMN parent_comment_id INTEGER`,
    `ALTER TABLE users ADD COLUMN pawprint_2fa_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN paw_code TEXT`,
    `ALTER TABLE users ADD COLUMN paw_code_expires_at DATETIME`,
    `ALTER TABLE community_members ADD COLUMN cleared_at DATETIME`,
    `ALTER TABLE community_members ADD COLUMN is_hidden INTEGER DEFAULT 0`,
    // account email verification -- these three were previously live on
    // Supabase but undocumented here; added for completeness
    `ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN email_verify_token TEXT`,
    `ALTER TABLE users ADD COLUMN email_verify_expires_at DATETIME`,
    // PawPrint Verification enable-by-email-link (see routes/auth.js
    // "PAWPRINT VERIFICATION — ENABLE-BY-EMAIL-LINK"). NOTE: runMigrations()
    // is not invoked at startup (see file header) -- these two columns must
    // be added to the live Supabase DB by hand before that feature works.
    `ALTER TABLE users ADD COLUMN pawprint_verify_token_hash TEXT`,
    `ALTER TABLE users ADD COLUMN pawprint_verify_expires_at DATETIME`,
    // Platform-admin flag (see middleware/admin.js's requireAdmin). Deliberately
    // separate from community_members.role, which is a per-PawCircle role and
    // has nothing to do with platform-wide permissions. No route ever sets this
    // -- it's promoted by running this ALTER's UPDATE-equivalent by hand
    // directly against Supabase. requireAdmin reads it fresh from the DB on
    // every request rather than trusting a JWT claim, so revoking admin access
    // takes effect immediately instead of waiting for an old access token to
    // expire. NOTE: runMigrations() is not invoked at startup (see file
    // header) -- this column must be added to the live Supabase DB by hand.
    `ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE`,
    // Account deletion tombstones (see 2026-09-30_account_deletion_schema.sql):
    // NULL = live; set when an account and its pets are SniffedOut.
    `ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ`,
    `ALTER TABLE pets ADD COLUMN deleted_at TIMESTAMPTZ`,
    // Read-only ("frozen") PawCircles, e.g. frozen_reason = 'owner_deleted'.
    `ALTER TABLE communities ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen'))`,
    `ALTER TABLE communities ADD COLUMN frozen_at TIMESTAMPTZ`,
    `ALTER TABLE communities ADD COLUMN frozen_reason TEXT`,
    // Payment proofs in the private Supabase Storage bucket (services/paymentProofs.js);
    // on the live DB see db/sql/2026-10-02_payment_proof_storage_path.sql.
    `ALTER TABLE payment_sessions ADD COLUMN proof_storage_path TEXT`,
    // QA handoff M15 (Spotlight Boosts had no effect) -- see
    // db/sql/2026-10-10_spotlight_location_fixes.sql and premiumGate.js's
    // consumeBoostCredit / SpotlightRepository.js's boosted-first sort.
    `ALTER TABLE users ADD COLUMN spotlight_boost_until TIMESTAMPTZ`,
    // QA handoff M14 (yesterday's champion history was global, not
    // location-specific) -- see db/sql/2026-10-10_spotlight_location_fixes.sql,
    // which also replaces the old UNIQUE(area, cycle_date) with
    // UNIQUE(area, location_key, cycle_date).
    `ALTER TABLE spotlight_history ADD COLUMN location_key TEXT NOT NULL DEFAULT 'global'`,
    // QA handoff M18/L5 (report counts could race) -- see
    // db/sql/2026-10-10_post_reports_unique.sql; PostRepository.js's
    // reportPost relies on this constraint for its ON CONFLICT DO NOTHING.
    `ALTER TABLE post_reports ADD CONSTRAINT post_reports_post_user_unique UNIQUE (post_id, user_id)`,
    // Private PawCircles join by approval (services/circleJoinRequests.js);
    // on the live DB see db/sql/2026-10-02_private_circle_requests.sql.
    `ALTER TABLE community_join_requests ADD COLUMN expires_at TIMESTAMPTZ`,
    `ALTER TABLE community_join_requests ADD COLUMN decided_at TIMESTAMPTZ`,
    `ALTER TABLE community_join_requests ADD COLUMN decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
    `ALTER TABLE communities ADD COLUMN disabled_at TIMESTAMPTZ`
  ];
  alterations.forEach(sql => { try { db.exec(sql); } catch(e) { /* column already exists */ } });

  // Create indexes (geospatial + common queries)
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_pets_lat ON pets(latitude)',
    'CREATE INDEX IF NOT EXISTS idx_pets_lng ON pets(longitude)',
    // Composite index for bounding-box prefilter (lat+lng together)
    'CREATE INDEX IF NOT EXISTS idx_pets_geo ON pets(latitude, longitude)',
    'CREATE INDEX IF NOT EXISTS idx_pets_user ON pets(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_posts_pet ON posts(pet_id)',
    'CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id)',
    'CREATE INDEX IF NOT EXISTS idx_likes_created ON likes(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_pet_id)',
    'CREATE INDEX IF NOT EXISTS idx_calls_receiver ON calls(receiver_pet_id)',
    'CREATE INDEX IF NOT EXISTS idx_swipes_from ON swipes(from_pet_id)',
    'CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_comment_id)',
    'CREATE INDEX IF NOT EXISTS idx_spotlight_history_date ON spotlight_history(cycle_date)',
    // Account deletion (see 2026-09-30_account_deletion_schema.sql)
    'CREATE INDEX IF NOT EXISTS idx_verification_codes_user_purpose ON verification_codes(user_id, purpose, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_pets_active_geo ON pets(latitude, longitude) WHERE deleted_at IS NULL',
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_one_pending ON community_ownership_transfers(community_id) WHERE status = 'pending'"
  ];
  indexes.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  // Seed demo data
  seedDemoData();
  seedPawCircleData();
  seedEcosystemData();
}

function seedDemoData() {
  const existing = db.get('SELECT id FROM users WHERE email = ?', ['demo@example.invalid']);
  if (existing) return;

  // password: Demo1234 (bcrypt hash)
  const hash = '$2a$10$YtOaQBw12dvRSCEvalSftukFzIbllcL128gNDH1GhOkg7JeRxCUpK';

  const users = [
    ['demo@example.invalid', 'mochi_owner', hash, 'Sarah Chen'],
    ['luna@example.invalid', 'luna_cat', hash, 'Emily Davis'],
    ['cooper@example.invalid', 'cooper_pup', hash, 'James Wilson'],
    ['bella@example.invalid', 'bella_fluff', hash, 'Maria Garcia'],
    ['oliver@example.invalid', 'oliver_cool', hash, 'Alex Kim'],
  ];
  users.forEach(u => db.run('INSERT INTO users (email, username, password_hash, full_name) VALUES (?, ?, ?, ?)', u));

  const petImgs = [
    'https://lh3.googleusercontent.com/aida-public/AB6AXuDtCmqW7bpNsFX6DdBxdmuDxra4LZhYzyJXmZMGGgO4I9v0280CaGNiSLB5XMp5Y51-niYmc8OwJnQHRZN74foKV3fjLlfjVzPfRICRdhtimt-LBz4eLleUS2ooEKwZtYyEYgbOzciNVLuJpKUDeSeHtwnVfUsdlHg7vg2XuZRsxxRmA8-qFcsGEJW6c2upLl_48zB6emxZpO46P6nPZJw6Pd5i6oUDNiYMFPXi5hogEoLWvfBUXmmp44Ff9kRMfmNYp85rzFqyhpI',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuC5d8RMXUAhLXSOgX_qyYDeEmpitWVJWHjMuH58jFcbBBfW-QmGIk7KXipOpy1uwVWX59R--Hdm93gSGFT002s9D_pR7hk3mhTIUByUOxIG2OBHlt-iS5vmGtGx1Jsx5sNwGoMJ5d7LlcwP8Uom-QKcfIpeC3_pwhGTn58CLd8cf6fSH-vCo9RbJvCFBog4TCrBc9WQ7e7k3DokPvE-wkCDGpCmAHNKqOMI4oRBoLuhRyua3GA-pQK7jdNi1ST8Mi808sd-RLZ3CGA',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuCf5x2Gfq_GNNaoZvtc-JAGtI8i2Dtv4_uM936rwH5TIXB-3XRpStSGCZVTBwNbfpL2ndxifAxaTJ6bqRsm5XzXXHg8XdS14TpHQjOy1_whyNy2hSrsLFCp1F_cxbXIgTFOJnG_1pJZMM3r3Ak6n566b2kiGhf8oEYwJAu7q96G5p9fZZFjtOLLDoxDfhAQatdcQyK61goVhUUbsEvoD9O10B7bIP_ueQT0Q0z4aNIOFeQ8SGoO5d4GRoPKFo_54sHxV73PMOs1z0Y',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuA9bZzSXnZux7RUeTDJ7wXxTnKXSi_yC0f_qizXHu-bR-vWc8w-HPwO_4SeUl580SxXznr6KebVhjtIXCOIN6Y7q99up9ZY-HsQvEyNCyd63JEzQlMhDtxGSZIXiqpAlDMaCLUqywJOwyksNEpOIk-AYrXoRCwocPRF45rvHxWtl36btoOcgijHRu3FmbvkP9tRUAS4qWuXv2ZufKYDnDvBnJYdhb0R8qd3fSvejQODisazNev5I9fY0mPnJ9q1LWI9g5ZMQTb5Zk4',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuDkoM2ePqafjfeTuRIu7-BB9fA7OeTVk94Sbw0XpewdZ_5HItF_yWbxvw5LSCqvn2yAskDW6IyfZmS4_iXe5rWuDPiAMFDcUUu7kN6lKSXZc2c1_lyPIi0ChPjr6ckU02F65JC-BFhi_TERir1FtnCODUk-T1B9VI6fdios0qQnMt3bz7ShRtUai05lNVQC93W0hstYodj01l8DtDBv-mBZQh-bMDWcp5I5-ei-UVzj8Wa8D22PXPLdVJbsOBMkERnek3yL6tCH6FM',
  ];

  const pets = [
    [1,'Mochi','@mochi','dog','male',2,'Original','French Bulldog',petImgs[0],13.0827,80.2707,'Chennai, Tamil Nadu','Just woke up from my third nap today. Is it snack time yet?',1,65,'India','Tamil Nadu','Chennai','Adyar'],
    [2,'Luna','@luna','cat','female',1,'Original','Persian',petImgs[1],12.9716,77.5946,'Bangalore, Karnataka','Looking for someone who appreciates cardboard boxes and sunbeams. ✨',1,45,'India','Karnataka','Bangalore','Indiranagar'],
    [3,'Cooper','@cooper','dog','male',2,'Original','Golden Retriever',petImgs[2],19.0760,72.8777,'Mumbai, Maharashtra','Ball is life. Also treats. Mostly treats.',1,80,'India','Maharashtra','Mumbai','Bandra'],
    [4,'Bella','@bella','dog','female',3,'Original','Bichon Frise',petImgs[3],13.0418,80.2341,'Chennai, Tamil Nadu','Pretty in pink 🎀 Will pose for treats',1,55,'India','Tamil Nadu','Chennai','T Nagar'],
    [5,'Oliver','@oliver','cat','male',2,'Original','British Shorthair',petImgs[4],17.3850,78.4867,'Hyderabad, Telangana','Too cool for school 😎',1,30,'India','Telangana','Hyderabad','Jubilee Hills'],
  ];
  pets.forEach(p => db.run(
    'INSERT INTO pets (user_id,name,pet_username,type,gender,age,breed_type,breed_name,avatar_url,latitude,longitude,location_text,bio,vaccinated,pawsitive_score,country,state,city,area,last_updated_location_timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\'))',
    p
  ));

  // Posts
  const postData = [
    [1,'Just woke up from my third nap today. Is it snack time yet? 🦴🌸',petImgs[0],'image'],
    [2,'Looking for someone who appreciates the finer things in life... like cardboard boxes ✨',petImgs[1],'image'],
    [3,'Ball is life! 🎾 Who wants to play fetch at Central Park?',petImgs[2],'image'],
    [4,'Pretty in pink 🎀 My human got me a new bow!',petImgs[3],'image'],
  ];
  postData.forEach(p => db.run('INSERT INTO posts (pet_id,caption,media_url,media_type) VALUES (?,?,?,?)', p));

  // Likes
  for (let pid = 1; pid <= 4; pid++) {
    for (let uid = 1; uid <= 5; uid++) {
      if (Math.random() > 0.3) {
        try { db.run('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [pid, uid]); } catch(e) {}
      }
    }
  }

  // Matches & conversations
  db.run('INSERT INTO swipes (from_pet_id, to_pet_id, action) VALUES (?, ?, ?)', [1, 2, 'like']);
  db.run('INSERT INTO swipes (from_pet_id, to_pet_id, action) VALUES (?, ?, ?)', [2, 1, 'like']);
  db.run('INSERT INTO matches (pet1_id, pet2_id) VALUES (?, ?)', [1, 2]);
  db.run('INSERT INTO conversations (match_id) VALUES (?)', [1]);
  db.run('INSERT INTO messages (conversation_id, sender_id, content, status) VALUES (?, ?, ?, ?)', [1, 2, 'Hi! Want to sniff some grass this weekend? 🐾', 'seen']);
  db.run('INSERT INTO messages (conversation_id, sender_id, content, status) VALUES (?, ?, ?, ?)', [1, 1, "Bark! Saturday morning works best!", 'seen']);

  db.run('INSERT INTO swipes (from_pet_id, to_pet_id, action) VALUES (?, ?, ?)', [1, 4, 'like']);
  db.run('INSERT INTO swipes (from_pet_id, to_pet_id, action) VALUES (?, ?, ?)', [4, 1, 'like']);
  db.run('INSERT INTO matches (pet1_id, pet2_id) VALUES (?, ?)', [1, 4]);
  db.run('INSERT INTO conversations (match_id) VALUES (?)', [2]);
  db.run('INSERT INTO messages (conversation_id, sender_id, content, status) VALUES (?, ?, ?, ?)', [2, 4, 'Did you find your favorite toy?', 'delivered']);

  // Calls — demo with all 4 statuses
  db.run('INSERT INTO calls (caller_pet_id, receiver_pet_id, type, status, duration) VALUES (?, ?, ?, ?, ?)', [1, 2, 'video', 'completed', 124]);
  db.run('INSERT INTO calls (caller_pet_id, receiver_pet_id, type, status, duration) VALUES (?, ?, ?, ?, ?)', [2, 1, 'audio', 'missed', 0]);
  db.run('INSERT INTO calls (caller_pet_id, receiver_pet_id, type, status, duration) VALUES (?, ?, ?, ?, ?)', [1, 4, 'video', 'completed', 45]);
  db.run('INSERT INTO calls (caller_pet_id, receiver_pet_id, type, status, duration, declined_by) VALUES (?, ?, ?, ?, ?, ?)', [3, 1, 'audio', 'declined', 0, 'receiver']);
  db.run('INSERT INTO calls (caller_pet_id, receiver_pet_id, type, status, duration) VALUES (?, ?, ?, ?, ?)', [1, 3, 'video', 'failed', 0]);
}

function seedPawCircleData() {
  // PawCircle Demo Communities (India-Focused)
  const commCount = db.get('SELECT COUNT(*) as count FROM communities');
  if (!commCount || commCount.count === 0) {
    const indianCommunities = [
      [1, 'Golden Retrievers Chennai', 'A friendly PawCircle community for Golden Retriever parents in Chennai to arrange beach walks, playdates, and tips! 🏖️🐾', 'Dog Breeds', 'Golden Retriever', 'Dog', 'Chennai', '/communities/dogs.jpg', 'pets', 0, '1. Be kind and respectful to all pet parents.\n2. Keep vaccinations up to date for playdates.\n3. No spam or commercial selling.', 1, 48, 'GR-CHENNAI-2026', 'chennai, golden, retriever, playdate, beach'],
      [2, 'Labrador Lovers Bangalore', 'Bangalore Labradors unite! Cubbon Park meetups, training tips, and swimming trips for water-loving Labs. 🌊🐕', 'Dog Breeds', 'Labrador', 'Dog', 'Bangalore', '/communities/dogs.jpg', 'pets', 0, '1. Respect Cubbon Park leash guidelines.\n2. Share helpful nutrition and vet advice.', 1, 64, 'LAB-BLR-2026', 'swimming, cubbon, lab, bangalore, playdate'],
      [3, 'Indie Dogs India', 'Celebrating Indian Pariah and Indie rescue dogs across India! Health care, adoption advocacy, and community support. ❤️🇮🇳', 'Dog Breeds', 'Indie Dog', 'Dog', 'India', '/communities/general.jpg', 'favorite', 0, '1. Love and advocate for Desi/Indie pets.\n2. Share rescue & fostering resources across Indian cities.', 2, 112, 'INDIE-INDIA-2026', 'indie, rescue, desi, care, adoption'],
      [4, 'Huskies Hyderabad', 'Hyderabad Husky Club — managing Huskies in sunny India! Cooling tips, night walks around Necklace Road & Jubilee Hills. ❄️🐺', 'Dog Breeds', 'Husky', 'Dog', 'Hyderabad', '/communities/dogs.jpg', 'ac_unit', 0, '1. Share AC and summer care advice.\n2. Evening playdates only during warm months.', 3, 31, 'HUSKY-HYD-2026', 'husky, cooling, necklace, nightwalk, hyderabad'],
      [5, 'Persian Cats Chennai', 'Fluffy Persian cat parents in Chennai! Grooming secrets, AC comfort tips, eye care, and peaceful indoor playdates. 🐱✨', 'Cat Breeds', 'Persian', 'Cat', 'Chennai', '/communities/cats.jpg', 'auto_awesome', 0, '1. Gentle grooming advice & vet recommendations.\n2. Cat-friendly indoor playdates only.', 2, 42, 'PERSIAN-CHN-2026', 'persian, groom, indoor, ac, fluffy, chennai'],
      [6, 'Bengal Cats Bengaluru', 'Active Bengal cat lovers in Namma Bengaluru! Agility toys, leash walking tips, and high-energy indoor setups. 🐆🏡', 'Cat Breeds', 'Bengal', 'Cat', 'Bangalore', '/communities/cats.jpg', 'pets', 0, '1. Share enrichment & puzzle toy ideas.', 2, 29, 'BENGAL-BLR-2026', 'bengal, leash, play, bangalore, cat'],
      [7, 'Beagle Buddies Chennai', 'Arooo! Beagle parents in Chennai sharing scent games, diet control tips, and weekend meetups at Elliot’s Beach. 🐶🏖️', 'Dog Breeds', 'Beagle', 'Dog', 'Chennai', '/communities/dogs.jpg', 'pets', 0, '1. Keep Beagles on leash during beach outings.', 1, 37, 'BEAGLE-CHN-2026', 'beagle, beach, scent, chennai, hound'],
      [8, 'Mumbai Cat Parents', 'The ultimate PawCircle community for cat parents across Mumbai, Bandra, Andheri, and South Bombay! Meow! 🐾🏙️', 'Pet Types', 'Cat', 'Cat', 'Mumbai', '/communities/cats.jpg', 'pets', 0, '1. Cat sitters, foster alerts, and vet reviews in Mumbai.', 4, 89, 'MUMBAI-CATS-2026', 'cat, sitters, foster, bandra, mumbai, advice'],
      [9, 'Chennai Puppy Playdates', 'Socializing puppies under 1 year in Chennai! Safe, supervised puppy playdates in Alwarpet, Adyar, and Besant Nagar. 🎾🐕', 'Activities', 'Puppy', 'Puppy', 'Chennai', '/communities/playdates.jpg', 'celebration', 0, '1. Puppies must have at least second round of vaccinations.\n2. Supervise play gently.', 1, 53, 'PUPPY-CHN-2026', 'puppy, playdate, chennai, social'],
      [10, 'Bangalore Pet Rescue', 'Emergency rescue, fostering, blood donors, and adoption appeals across Bangalore. Let’s help every paw find a home! 🚑❤️', 'Activities', 'Rescue', 'Dog', 'Bangalore', '/communities/rescue.jpg', 'volunteer_activism', 0, '1. Verified rescue requests only.\n2. No donations without admin verification.', 3, 140, 'RESCUE-BLR-2026', 'rescue, emergency, foster, bangalore, adopt'],
      [11, 'Pet Parents India', 'India’s largest community for all pet lovers — dogs, cats, birds, and rescues! Daily cute moments & nationwide advice. 🇮🇳🐾', 'Pet Types', 'All', 'All', 'India', '/communities/general.jpg', 'groups', 0, '1. Celebrate all pets across India!', 1, 215, 'PAWS-INDIA-2026', 'india, general, advice, puppy, kitten']
    ];

    indianCommunities.forEach(c => {
      db.run(
        'INSERT INTO communities (id, name, description, category, breed, pet_type, city, cover_image, icon_image, is_private, rules, created_by, member_count, invite_code, tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        c
      );
    });

    // Seed members into communities with roles and badges
    for (let cid = 1; cid <= 11; cid++) {
      // User 1 (Demo User Mochi / Sarah Chen) is member/owner in Chennai & India communities
      db.run('INSERT OR IGNORE INTO community_members (community_id, user_id, role, verified_badge) VALUES (?, ?, ?, ?)', [cid, 1, cid === 1 || cid === 7 || cid === 9 || cid === 11 ? 'Owner' : 'Member', cid === 1 ? 'Verified Vet' : null]);
      db.run('INSERT OR IGNORE INTO community_members (community_id, user_id, role, verified_badge) VALUES (?, ?, ?, ?)', [cid, 2, cid === 5 || cid === 3 ? 'Admin' : 'Member', cid === 3 ? 'Verified Rescue / NGO' : null]);
      db.run('INSERT OR IGNORE INTO community_members (community_id, user_id, role, verified_badge) VALUES (?, ?, ?, ?)', [cid, 3, 'Moderator', 'Verified Trainer']);
      db.run('INSERT OR IGNORE INTO community_members (community_id, user_id, role, verified_badge) VALUES (?, ?, ?, ?)', [cid, 4, 'Member', null]);
      db.run('INSERT OR IGNORE INTO community_members (community_id, user_id, role, verified_badge) VALUES (?, ?, ?, ?)', [cid, 5, 'Member', null]);
    }

    // Seed Announcements
    const announcements = [
      [1, 1, 'Sunday Beach Playdate at Besant Nagar Beach! 🏖️', 'Hey Golden Retriever family! We are hosting our monthly sunrise playdate at Besant Nagar Beach this Sunday at 6:30 AM. Bring water bowls and treats! 🐾✨'],
      [1, 1, 'Summer Paw Care & Hydration Tips ☀️', 'Chennai heat is peaking! Remember to check pavement temperatures with the back of your hand before walks. Early morning walks recommended!'],
      [5, 2, 'Grooming Workshop in Alwarpet This Weekend 🐱', 'Learn gentle coat brushing and mat prevention techniques for Persian cats with Dr. Ramesh at Alwarpet Vet Clinic this Saturday.'],
      [9, 1, 'Puppy Socialization Rules Reminder 🎾', 'Please ensure all participating puppies have completed their DHPP booster shots at least 10 days prior to playdates!']
    ];
    announcements.forEach(a => {
      db.run('INSERT INTO community_announcements (community_id, sender_id, title, content) VALUES (?, ?, ?, ?)', a);
    });

    // Seed Community Messages (Chat)
    const commMsgs = [
      [1, 2, 'Hi everyone! Mochi and Luna look forward to seeing the Golden crew this weekend! 🐾'],
      [1, 3, 'Cooper will be there with his favorite tennis ball! 🎾'],
      [1, 1, 'Can’t wait to see all the Goldens splashing in the waves! Don’t forget towels! 🏖️'],
      [5, 2, 'Does anyone have recommendations for quiet AC pet taxis in Chennai?'],
      [5, 4, 'Yes! Paws & Go Cabs in Chennai are super gentle with cats!']
    ];
    commMsgs.forEach(m => {
      db.run('INSERT INTO community_messages (community_id, sender_id, content) VALUES (?, ?, ?)', m);
    });

    // Seed Community Photos
    const commPhotos = [
      [1, 1, 'https://lh3.googleusercontent.com/aida-public/AB6AXuDtCmqW7bpNsFX6DdBxdmuDxra4LZhYzyJXmZMGGgO4I9v0280CaGNiSLB5XMp5Y51-niYmc8OwJnQHRZN74foKV3fjLlfjVzPfRICRdhtimt-LBz4eLleUS2ooEKwZtYyEYgbOzciNVLuJpKUDeSeHtwnVfUsdlHg7vg2XuZRsxxRmA8-qFcsGEJW6c2upLl_48zB6emxZpO46P6nPZJw6Pd5i6oUDNiYMFPXi5hogEoLWvfBUXmmp44Ff9kRMfmNYp85rzFqyhpI', 'Mochi enjoying the cool breeze after walk! 🐾'],
      [1, 3, 'https://lh3.googleusercontent.com/aida-public/AB6AXuCf5x2Gfq_GNNaoZvtc-JAGtI8i2Dtv4_uM936rwH5TIXB-3XRpStSGCZVTBwNbfpL2ndxifAxaTJ6bqRsm5XzXXHg8XdS14TpHQjOy1_whyNy2hSrsLFCp1F_cxbXIgTFOJnG_1pJZMM3r3Ak6n566b2kiGhf8oEYwJAu7q96G5p9fZZFjtOLLDoxDfhAQatdcQyK61goVhUUbsEvoD9O10B7bIP_ueQT0Q0z4aNIOFeQ8SGoO5d4GRoPKFo_54sHxV73PMOs1z0Y', 'Cooper ready for fetch! 🎾']
    ];
    commPhotos.forEach(p => {
      db.run('INSERT INTO community_photos (community_id, user_id, media_url, caption) VALUES (?, ?, ?, ?)', p);
    });

    // Seed Community Events
    const commEvents = [
      [1, 'Besant Nagar Sunrise Beach Walk 🏖️', 'Meet near Karl Schmidt Memorial at Besant Nagar Beach for a fun off-leash play session!', '2026-07-19T06:30:00.000Z', 'Besant Nagar Beach, Chennai', 1],
      [5, 'Persian Cat Indoor Tea Party ☕🐱', 'Relaxed indoor social meetup for cat parents at Paws Cafe Alwarpet.', '2026-07-25T16:00:00.000Z', 'Paws Cafe Alwarpet, Chennai', 2]
    ];
    commEvents.forEach(e => {
      db.run('INSERT INTO community_events (community_id, title, description, event_date, location, created_by) VALUES (?, ?, ?, ?, ?, ?)', e);
    });

    // Seed Community Polls
    const commPolls = [
      [1, 'What time works best for our August Beach Meetup? ⏰', JSON.stringify(['6:00 AM Sunrise', '6:30 AM Morning', '5:30 PM Evening Breeze']), JSON.stringify({ '0': [1, 2], '1': [3, 4], '2': [5] }), 1]
    ];
    // Migration: Add active_pet_id column to users table if missing
    try {
      db.run('ALTER TABLE users ADD COLUMN active_pet_id INTEGER REFERENCES pets(id)');
    } catch (e) {
      /* Column already exists */
    }
  }

  console.log('✅ Demo data seeded');
}

// ─── Ecosystem Seeder: 30 users, ~55 pets ───────────────────────────────
function seedEcosystemData() {
  const check = db.get("SELECT id FROM users WHERE email = 'eco01@example.invalid'");
  if (check) return;

  // bcrypt hash for 'Sniffr2026' (same salt rounds as demo)
  const hash = '$2a$10$YtOaQBw12dvRSCEvalSftukFzIbllcL128gNDH1GhOkg7JeRxCUpK';

  // ── Pet avatar URLs (cycle through these) ──
  const avatars = [
    'https://lh3.googleusercontent.com/aida-public/AB6AXuDtCmqW7bpNsFX6DdBxdmuDxra4LZhYzyJXmZMGGgO4I9v0280CaGNiSLB5XMp5Y51-niYmc8OwJnQHRZN74foKV3fjLlfjVzPfRICRdhtimt-LBz4eLleUS2ooEKwZtYyEYgbOzciNVLuJpKUDeSeHtwnVfUsdlHg7vg2XuZRsxxRmA8-qFcsGEJW6c2upLl_48zB6emxZpO46P6nPZJw6Pd5i6oUDNiYMFPXi5hogEoLWvfBUXmmp44Ff9kRMfmNYp85rzFqyhpI',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuC5d8RMXUAhLXSOgX_qyYDeEmpitWVJWHjMuH58jFcbBBfW-QmGIk7KXipOpy1uwVWX59R--Hdm93gSGFT002s9D_pR7hk3mhTIUByUOxIG2OBHlt-iS5vmGtGx1Jsx5sNwGoMJ5d7LlcwP8Uom-QKcfIpeC3_pwhGTn58CLd8cf6fSH-vCo9RbJvCFBog4TCrBc9WQ7e7k3DokPvE-wkCDGpCmAHNKqOMI4oRBoLuhRyua3GA-pQK7jdNi1ST8Mi808sd-RLZ3CGA',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuCf5x2Gfq_GNNaoZvtc-JAGtI8i2Dtv4_uM936rwH5TIXB-3XRpStSGCZVTBwNbfpL2ndxifAxaTJ6bqRsm5XzXXHg8XdS14TpHQjOy1_whyNy2hSrsLFCp1F_cxbXIgTFOJnG_1pJZMM3r3Ak6n566b2kiGhf8oEYwJAu7q96G5p9fZZFjtOLLDoxDfhAQatdcQyK61goVhUUbsEvoD9O10B7bIP_ueQT0Q0z4aNIOFeQ8SGoO5d4GRoPKFo_54sHxV73PMOs1z0Y',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuA9bZzSXnZux7RUeTDJ7wXxTnKXSi_yC0f_qizXHu-bR-vWc8w-HPwO_4SeUl580SxXznr6KebVhjtIXCOIN6Y7q99up9ZY-HsQvEyNCyd63JEzQlMhDtxGSZIXiqpAlDMaCLUqywJOwyksNEpOIk-AYrXoRCwocPRF45rvHxWtl36btoOcgijHRu3FmbvkP9tRUAS4qWuXv2ZufKYDnDvBnJYdhb0R8qd3fSvejQODisazNev5I9fY0mPnJ9q1LWI9g5ZMQTb5Zk4',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuDkoM2ePqafjfeTuRIu7-BB9fA7OeTVk94Sbw0XpewdZ_5HItF_yWbxvw5LSCqvn2yAskDW6IyfZmS4_iXe5rWuDPiAMFDcUUu7kN6lKSXZc2c1_lyPIi0ChPjr6ckU02F65JC-BFhi_TERir1FtnCODUk-T1B9VI6fdios0qQnMt3bz7ShRtUai05lNVQC93W0hstYodj01l8DtDBv-mBZQh-bMDWcp5I5-ei-UVzj8Wa8D22PXPLdVJbsOBMkERnek3yL6tCH6FM',
  ];

  // ── 30 Users ──
  const users = [
    ['eco01@example.invalid', 'priya_pawmom',   hash, 'Priya Sharma'],
    ['eco02@example.invalid', 'arjun_woofs',    hash, 'Arjun Nair'],
    ['eco03@example.invalid', 'sneha_meows',    hash, 'Sneha Reddy'],
    ['eco04@example.invalid', 'rohan_treats',   hash, 'Rohan Kapoor'],
    ['eco05@example.invalid', 'divya_petcare',  hash, 'Divya Iyer'],
    ['eco06@example.invalid', 'vikram_doggos',  hash, 'Vikram Singh'],
    ['eco07@example.invalid', 'ananya_catmom',  hash, 'Ananya Mukherjee'],
    ['eco08@example.invalid', 'karthik_fetch',  hash, 'Karthik Rajan'],
    ['eco09@example.invalid', 'meera_pawlife',  hash, 'Meera Chatterjee'],
    ['eco10@example.invalid', 'aditya_bork',    hash, 'Aditya Deshmukh'],
    ['eco11@example.invalid', 'ishita_purrrs',  hash, 'Ishita Goswami'],
    ['eco12@example.invalid', 'rahul_dogdad',   hash, 'Rahul Menon'],
    ['eco13@example.invalid', 'kavya_wags',     hash, 'Kavya Pillai'],
    ['eco14@example.invalid', 'nikhil_pawfect', hash, 'Nikhil Joshi'],
    ['eco15@example.invalid', 'pooja_whiskers', hash, 'Pooja Banerjee'],
    ['eco16@example.invalid', 'siddharth_bark', hash, 'Siddharth Verma'],
    ['eco17@example.invalid', 'lakshmi_meow',   hash, 'Lakshmi Sundaram'],
    ['eco18@example.invalid', 'devika_pawpal',  hash, 'Devika Krishnan'],
    ['eco19@example.invalid', 'amit_woofer',    hash, 'Amit Patel'],
    ['eco20@example.invalid', 'tanvi_kittyqn',  hash, 'Tanvi Choudhury'],
    ['eco21@example.invalid', 'gaurav_tailwag', hash, 'Gaurav Bhatt'],
    ['eco22@example.invalid', 'riya_sniffing',  hash, 'Riya Saxena'],
    ['eco23@example.invalid', 'akash_goodboy',  hash, 'Akash Rao'],
    ['eco24@example.invalid', 'nandini_purrs',  hash, 'Nandini Hegde'],
    ['eco25@example.invalid', 'varun_doglife',  hash, 'Varun Tiwari'],
    ['eco26@example.invalid', 'shalini_paws',   hash, 'Shalini Das'],
    ['eco27@example.invalid', 'harsh_barkley',  hash, 'Harsh Agarwal'],
    ['eco28@example.invalid', 'deepa_catclub',  hash, 'Deepa Subramaniam'],
    ['eco29@example.invalid', 'manish_fetchit', hash, 'Manish Gupta'],
    ['eco30@example.invalid', 'swathi_whisker', hash, 'Swathi Narayanan'],
  ];

  const userIds = [];
  users.forEach(u => {
    const r = db.run('INSERT INTO users (email, username, password_hash, full_name) VALUES (?, ?, ?, ?)', u);
    userIds.push(Number(r.lastInsertRowid));
  });

  // ── Location distribution around Chennai (13.0827, 80.2707) ──
  // Groups: very close (<2km), nearby (2-10km), medium (10-30km), far (30-80km), distant (80-150km)
  const locations = [
    // Very close to demo user (<2km from Chennai center)
    { lat: 13.0845, lng: 80.2720, city: 'Chennai', area: 'Egmore',          state: 'Tamil Nadu' },
    { lat: 13.0800, lng: 80.2650, city: 'Chennai', area: 'Nungambakkam',    state: 'Tamil Nadu' },
    { lat: 13.0860, lng: 80.2780, city: 'Chennai', area: 'Triplicane',      state: 'Tamil Nadu' },
    { lat: 13.0810, lng: 80.2690, city: 'Chennai', area: 'Thousand Lights', state: 'Tamil Nadu' },
    { lat: 13.0790, lng: 80.2740, city: 'Chennai', area: 'Teynampet',       state: 'Tamil Nadu' },
    // Nearby (2-10km)
    { lat: 13.0418, lng: 80.2341, city: 'Chennai', area: 'T Nagar',         state: 'Tamil Nadu' },
    { lat: 13.0550, lng: 80.2570, city: 'Chennai', area: 'Mylapore',        state: 'Tamil Nadu' },
    { lat: 13.0670, lng: 80.2370, city: 'Chennai', area: 'Kodambakkam',     state: 'Tamil Nadu' },
    { lat: 13.1060, lng: 80.2840, city: 'Chennai', area: 'Royapuram',       state: 'Tamil Nadu' },
    { lat: 13.0340, lng: 80.2670, city: 'Chennai', area: 'Adyar',           state: 'Tamil Nadu' },
    { lat: 13.0500, lng: 80.2500, city: 'Chennai', area: 'Saidapet',        state: 'Tamil Nadu' },
    // Medium distance (10-30km)
    { lat: 12.9900, lng: 80.2200, city: 'Chennai', area: 'Tambaram',        state: 'Tamil Nadu' },
    { lat: 13.1500, lng: 80.2100, city: 'Chennai', area: 'Ambattur',        state: 'Tamil Nadu' },
    { lat: 12.9500, lng: 80.1400, city: 'Chennai', area: 'Chengalpattu',    state: 'Tamil Nadu' },
    { lat: 13.0100, lng: 80.2100, city: 'Chennai', area: 'Guindy',          state: 'Tamil Nadu' },
    { lat: 12.9600, lng: 80.2500, city: 'Chennai', area: 'Medavakkam',      state: 'Tamil Nadu' },
    { lat: 13.1200, lng: 80.1500, city: 'Chennai', area: 'Porur',           state: 'Tamil Nadu' },
    // Far (30-80km)
    { lat: 12.8300, lng: 80.0400, city: 'Kanchipuram', area: 'Kanchipuram', state: 'Tamil Nadu' },
    { lat: 12.6900, lng: 79.9800, city: 'Vellore',     area: 'Arcot',       state: 'Tamil Nadu' },
    { lat: 13.3500, lng: 80.1800, city: 'Tiruvallur',  area: 'Tiruvallur',  state: 'Tamil Nadu' },
    { lat: 12.8700, lng: 80.2200, city: 'Mamallapuram', area: 'Mamallapuram', state: 'Tamil Nadu' },
    // Distant (80-150km)
    { lat: 12.5200, lng: 79.8800, city: 'Tiruvannamalai', area: 'Tiruvannamalai', state: 'Tamil Nadu' },
    { lat: 11.9400, lng: 79.8100, city: 'Puducherry', area: 'White Town',     state: 'Puducherry' },
    { lat: 12.9716, lng: 77.5946, city: 'Bangalore',  area: 'Indiranagar',    state: 'Karnataka' },
    { lat: 11.6600, lng: 78.1600, city: 'Salem',       area: 'Salem',          state: 'Tamil Nadu' },
  ];

  // ── 55 Pets across 30 users ──
  const petData = [
    // User 1 (eco01) — 2 pets
    { uid: 0, name: 'Simba',    username: '@simba_king',    type: 'dog', gender: 'Male',   age: 3, breedType: 'Purebred', breed: 'Golden Retriever', bio: 'King of the couch and conqueror of tennis balls 🎾👑', vaccinated: 1, kyc: 1, score: 85, loc: 0 },
    { uid: 0, name: 'Cleo',     username: '@cleo_queen',    type: 'cat', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Siamese',           bio: 'Blue-eyed beauty who rules this house with velvet paws 💙', vaccinated: 1, kyc: 0, score: 72, loc: 1 },
    // User 2 — 2 pets
    { uid: 1, name: 'Bruno',    username: '@bruno_boi',     type: 'dog', gender: 'Male',   age: 4, breedType: 'Purebred', breed: 'Rottweiler',        bio: 'Big softie who thinks he\'s a lap dog. Spoiler: he is. 🐻', vaccinated: 1, kyc: 1, score: 78, loc: 2 },
    { uid: 1, name: 'Whiskers', username: '@whiskers_mcg',  type: 'cat', gender: 'Male',   age: 1, breedType: 'Mixed',    breed: 'Tabby Mix',         bio: 'Professional bird watcher and string chaser 🐦', vaccinated: 1, kyc: 0, score: 60, loc: 3 },
    // User 3 — 2 pets
    { uid: 2, name: 'Pixie',    username: '@pixie_dust',    type: 'cat', gender: 'Female', age: 1, breedType: 'Purebred', breed: 'Scottish Fold',     bio: 'Folded ears, unfolded love 💕 Treat negotiator extraordinaire', vaccinated: 1, kyc: 0, score: 70, loc: 4 },
    { uid: 2, name: 'Thor',     username: '@thor_thunder',  type: 'dog', gender: 'Male',   age: 5, breedType: 'Purebred', breed: 'German Shepherd',   bio: 'Guarding the neighbourhood one bark at a time ⚡', vaccinated: 1, kyc: 1, score: 90, loc: 5 },
    // User 4 — 2 pets
    { uid: 3, name: 'Cinnamon', username: '@cinnamon_roll', type: 'dog', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Pomeranian',        bio: 'Fluffy cloud who barks at her own reflection ☁️', vaccinated: 1, kyc: 0, score: 65, loc: 6 },
    { uid: 3, name: 'Shadow',   username: '@shadow_cat',    type: 'cat', gender: 'Male',   age: 3, breedType: 'Purebred', breed: 'Bombay',            bio: 'Midnight prowler. Socks thief. Professional napper. 🌙', vaccinated: 0, kyc: 0, score: 45, loc: 7 },
    // User 5 — 2 pets
    { uid: 4, name: 'Rosie',    username: '@rosie_pawsup',  type: 'dog', gender: 'Female', age: 1, breedType: 'Purebred', breed: 'Cavalier King Charles', bio: 'Will do anything for belly rubs. ANYTHING. 🌹', vaccinated: 1, kyc: 0, score: 80, loc: 8 },
    { uid: 4, name: 'Ginger',   username: '@ginger_snap',   type: 'cat', gender: 'Female', age: 4, breedType: 'Mixed',    breed: 'Orange Tabby',      bio: 'One brain cell, infinite chaos. I regret nothing. 🧡', vaccinated: 1, kyc: 0, score: 55, loc: 9 },
    // User 6 — 2 pets
    { uid: 5, name: 'Max',      username: '@max_power',     type: 'dog', gender: 'Male',   age: 3, breedType: 'Purebred', breed: 'Labrador Retriever', bio: 'I\'ve never met a stranger. Or a snack I didn\'t like. 🍖', vaccinated: 1, kyc: 1, score: 88, loc: 10 },
    { uid: 5, name: 'Muffin',   username: '@muffin_fluff',  type: 'dog', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Shih Tzu',          bio: 'Bow game strong 🎀 Will judge you silently', vaccinated: 1, kyc: 0, score: 62, loc: 10 },
    // User 7 — 2 pets
    { uid: 6, name: 'Misty',    username: '@misty_eyes',    type: 'cat', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Russian Blue',      bio: 'Elegant. Mysterious. Will knock your coffee off the table. 🩶', vaccinated: 1, kyc: 0, score: 75, loc: 11 },
    { uid: 6, name: 'Patches',  username: '@patches_quilt', type: 'cat', gender: 'Male',   age: 5, breedType: 'Mixed',    breed: 'Calico Mix',        bio: 'Named after my coat. Stay for my personality. 🎨', vaccinated: 0, kyc: 0, score: 40, loc: 11 },
    // User 8 — 2 pets
    { uid: 7, name: 'Rocky',    username: '@rocky_fighter',  type: 'dog', gender: 'Male',   age: 4, breedType: 'Purebred', breed: 'Boxer',             bio: 'Float like a butterfly, drool like a Boxer 🥊', vaccinated: 1, kyc: 1, score: 82, loc: 12 },
    { uid: 7, name: 'Noodle',   username: '@noodle_doodle', type: 'dog', gender: 'Male',   age: 1, breedType: 'Mixed',    breed: 'Goldendoodle',      bio: 'Hypoallergenic and hyperactive. A winning combo! 🍝', vaccinated: 1, kyc: 0, score: 70, loc: 12 },
    // User 9 — 1 pet
    { uid: 8, name: 'Duchess',  username: '@duchess_royal', type: 'cat', gender: 'Female', age: 3, breedType: 'Purebred', breed: 'Maine Coon',        bio: 'I\'m not fat, I\'m majestic. 20 pounds of pure royalty 👑', vaccinated: 1, kyc: 0, score: 78, loc: 13 },
    // User 10 — 2 pets
    { uid: 9, name: 'Ace',      username: '@ace_pilot',     type: 'dog', gender: 'Male',   age: 2, breedType: 'Purebred', breed: 'Beagle',            bio: 'My nose knows. Following scent trails since 2024 🔍', vaccinated: 1, kyc: 1, score: 76, loc: 14 },
    { uid: 9, name: 'Pepper',   username: '@pepper_spice',  type: 'dog', gender: 'Female', age: 3, breedType: 'Mixed',    breed: 'Indie Mix',         bio: 'Street smart turned couch smart. Rescue queen 💪', vaccinated: 1, kyc: 0, score: 85, loc: 14 },
    // User 11 — 2 pets
    { uid: 10, name: 'Latte',   username: '@latte_sippy',   type: 'cat', gender: 'Female', age: 1, breedType: 'Purebred', breed: 'Ragdoll',           bio: 'I go limp when you hold me. It\'s a feature, not a bug ☕', vaccinated: 1, kyc: 0, score: 68, loc: 15 },
    { uid: 10, name: 'Biscuit', username: '@biscuit_boy',   type: 'dog', gender: 'Male',   age: 2, breedType: 'Purebred', breed: 'Cocker Spaniel',    bio: 'Ears flapping in the wind is my superpower 🍪', vaccinated: 1, kyc: 0, score: 72, loc: 15 },
    // User 12 — 2 pets
    { uid: 11, name: 'Zeus',    username: '@zeus_mighty',   type: 'dog', gender: 'Male',   age: 5, breedType: 'Purebred', breed: 'Great Dane',        bio: 'Yes, I\'m a dog. No, I\'m not a horse. Happens daily. ⚡', vaccinated: 1, kyc: 1, score: 88, loc: 16 },
    { uid: 11, name: 'Tinker',  username: '@tinker_bell',   type: 'cat', gender: 'Female', age: 2, breedType: 'Mixed',    breed: 'Tuxedo',            bio: 'Dressed for every occasion. Bow tie is permanent. 🎩', vaccinated: 1, kyc: 0, score: 58, loc: 16 },
    // User 13 — 2 pets
    { uid: 12, name: 'Peanut',  username: '@peanut_butter', type: 'dog', gender: 'Male',   age: 1, breedType: 'Purebred', breed: 'Dachshund',         bio: 'Long body, short legs, big dreams 🥜', vaccinated: 1, kyc: 0, score: 74, loc: 5 },
    { uid: 12, name: 'Mocha',   username: '@mocha_swirl',   type: 'cat', gender: 'Female', age: 3, breedType: 'Purebred', breed: 'Abyssinian',        bio: 'Adventure cat who judges you from high places ☕', vaccinated: 1, kyc: 0, score: 66, loc: 6 },
    // User 14 — 2 pets
    { uid: 13, name: 'Buddy',   username: '@buddy_forever', type: 'dog', gender: 'Male',   age: 6, breedType: 'Mixed',    breed: 'Indie',             bio: 'Rescued from the streets. Now I rescue hearts ❤️', vaccinated: 1, kyc: 1, score: 95, loc: 7 },
    { uid: 13, name: 'Mittens', username: '@mittens_paws',  type: 'cat', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Persian',           bio: 'My face says grumpy but my purrs say otherwise 🧤', vaccinated: 1, kyc: 0, score: 60, loc: 8 },
    // User 15 — 1 pet
    { uid: 14, name: 'Tofu',    username: '@tofu_soft',     type: 'cat', gender: 'Male',   age: 1, breedType: 'Purebred', breed: 'British Shorthair', bio: 'Chonky, dignified, and very opinionated about dinner time 🫧', vaccinated: 1, kyc: 0, score: 70, loc: 9 },
    // User 16 — 2 pets
    { uid: 15, name: 'Duke',    username: '@duke_noble',    type: 'dog', gender: 'Male',   age: 4, breedType: 'Purebred', breed: 'Doberman',          bio: 'Look intimidating. Am actually scared of butterflies 🦋', vaccinated: 1, kyc: 1, score: 83, loc: 17 },
    { uid: 15, name: 'Oreo',    username: '@oreo_cookie',   type: 'cat', gender: 'Male',   age: 2, breedType: 'Mixed',    breed: 'Black & White Mix', bio: 'Half darkness, half light, fully obsessed with cardboard boxes 🍪', vaccinated: 0, kyc: 0, score: 52, loc: 17 },
    // User 17 — 2 pets
    { uid: 16, name: 'Honey',   username: '@honey_drip',    type: 'dog', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Cocker Spaniel',    bio: 'Sweet as my name. Twice as sticky after walks 🍯', vaccinated: 1, kyc: 0, score: 77, loc: 18 },
    { uid: 16, name: 'Bagel',   username: '@bagel_bite',    type: 'dog', gender: 'Male',   age: 3, breedType: 'Purebred', breed: 'Pug',               bio: 'I snore louder than I bark. That\'s a promise 🥯', vaccinated: 1, kyc: 0, score: 68, loc: 18 },
    // User 18 — 2 pets
    { uid: 17, name: 'Jasmine', username: '@jasmine_bloom', type: 'cat', gender: 'Female', age: 1, breedType: 'Purebred', breed: 'Turkish Angora',    bio: 'White coat, green eyes, zero regrets about the vase 🌸', vaccinated: 1, kyc: 0, score: 73, loc: 19 },
    { uid: 17, name: 'Tiger',   username: '@tiger_stripes', type: 'cat', gender: 'Male',   age: 4, breedType: 'Mixed',    breed: 'Bengal Mix',        bio: 'Wild at heart, domestic by contract 🐯', vaccinated: 1, kyc: 0, score: 80, loc: 19 },
    // User 19 — 2 pets
    { uid: 18, name: 'Charlie', username: '@charlie_chews', type: 'dog', gender: 'Male',   age: 3, breedType: 'Purebred', breed: 'Beagle',            bio: 'Arooo! That\'s my love language 🎵', vaccinated: 1, kyc: 0, score: 75, loc: 20 },
    { uid: 18, name: 'Snowball', username: '@snowball_puff', type: 'cat', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Persian',          bio: 'Pure white, pure attitude. Handle with love ❄️', vaccinated: 1, kyc: 0, score: 62, loc: 20 },
    // User 20 — 1 pet
    { uid: 19, name: 'Kiwi',    username: '@kiwi_chirps',   type: 'dog', gender: 'Female', age: 1, breedType: 'Mixed',    breed: 'Spitz Mix',         bio: 'Tiny but fierce. The mailman knows. 🥝', vaccinated: 1, kyc: 0, score: 69, loc: 21 },
    // User 21 — 2 pets
    { uid: 20, name: 'Atlas',   username: '@atlas_strong',  type: 'dog', gender: 'Male',   age: 3, breedType: 'Purebred', breed: 'Husky',             bio: 'Dramatic. Vocal. High maintenance. Worth it. 🌍', vaccinated: 1, kyc: 1, score: 87, loc: 22 },
    { uid: 20, name: 'Olive',   username: '@olive_green',   type: 'cat', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Egyptian Mau',      bio: 'Spotted coat, spotted attitude. Fastest cat on this app 🫒', vaccinated: 1, kyc: 0, score: 71, loc: 22 },
    // User 22 — 2 pets
    { uid: 21, name: 'Willow',  username: '@willow_tree',   type: 'dog', gender: 'Female', age: 4, breedType: 'Purebred', breed: 'Irish Setter',      bio: 'Red hair don\'t care. Beach runs are my therapy 🌿', vaccinated: 1, kyc: 0, score: 79, loc: 23 },
    { uid: 21, name: 'Nimbus',  username: '@nimbus_cloud',  type: 'cat', gender: 'Male',   age: 1, breedType: 'Mixed',    breed: 'Grey Tabby',        bio: 'Cloud-soft fur, thunderstorm-level zoomies ⛅', vaccinated: 1, kyc: 0, score: 63, loc: 23 },
    // User 23 — 2 pets
    { uid: 22, name: 'Rusty',   username: '@rusty_nails',   type: 'dog', gender: 'Male',   age: 5, breedType: 'Mixed',    breed: 'Indie',             bio: 'Old soul, young heart. Rescued and loving life 🧡', vaccinated: 1, kyc: 1, score: 91, loc: 0 },
    { uid: 22, name: 'Socks',   username: '@socks_fancy',   type: 'cat', gender: 'Female', age: 3, breedType: 'Mixed',    breed: 'Tuxedo',            bio: 'White paws = naturally fancy. It\'s genetics. 🧦', vaccinated: 1, kyc: 0, score: 55, loc: 1 },
    // User 24 — 1 pet
    { uid: 23, name: 'Luna',    username: '@luna_moon2',    type: 'cat', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Norwegian Forest',  bio: 'Forest princess in an apartment. The windowsill is my kingdom 🌙', vaccinated: 1, kyc: 0, score: 74, loc: 2 },
    // User 25 — 2 pets
    { uid: 24, name: 'Scout',   username: '@scout_explore', type: 'dog', gender: 'Male',   age: 2, breedType: 'Purebred', breed: 'Border Collie',     bio: 'Smartest dog in the park. I\'ve trained MY human well 🧠', vaccinated: 1, kyc: 1, score: 92, loc: 3 },
    { uid: 24, name: 'Maple',   username: '@maple_sweet',   type: 'dog', gender: 'Female', age: 1, breedType: 'Purebred', breed: 'Corgi',             bio: 'Short legs, long body, maximum cute factor 🍁', vaccinated: 1, kyc: 0, score: 84, loc: 4 },
    // User 26 — 2 pets
    { uid: 25, name: 'Felix',   username: '@felix_lucky',   type: 'cat', gender: 'Male',   age: 3, breedType: 'Purebred', breed: 'Sphynx',            bio: 'No fur, no problems. Maximum cuddles needed for warmth 🫶', vaccinated: 1, kyc: 0, score: 67, loc: 10 },
    { uid: 25, name: 'Daisy',   username: '@daisy_chain',   type: 'dog', gender: 'Female', age: 2, breedType: 'Purebred', breed: 'Maltese',           bio: 'Tiny but my bark fills the house. Fear me. 🌼', vaccinated: 1, kyc: 0, score: 71, loc: 10 },
    // User 27 — 2 pets
    { uid: 26, name: 'Bear',    username: '@bear_hugger',   type: 'dog', gender: 'Male',   age: 4, breedType: 'Purebred', breed: 'Chow Chow',         bio: 'Am I a dog or a bear? The debate continues. 🐻', vaccinated: 1, kyc: 1, score: 81, loc: 24 },
    { uid: 26, name: 'Chai',    username: '@chai_time',     type: 'cat', gender: 'Female', age: 2, breedType: 'Mixed',    breed: 'Brown Tabby',       bio: 'Warm, comforting, and spicy when provoked ☕', vaccinated: 0, kyc: 0, score: 50, loc: 24 },
    // User 28 — 1 pet
    { uid: 27, name: 'Waffles', username: '@waffles_crispy', type: 'dog', gender: 'Male', age: 1, breedType: 'Mixed', breed: 'Goldendoodle',     bio: 'Fluffy, sweet, and golden. The complete breakfast 🧇', vaccinated: 1, kyc: 0, score: 76, loc: 13 },
    // User 29 — 2 pets
    { uid: 28, name: 'Roxy',    username: '@roxy_rebel',    type: 'dog', gender: 'Female', age: 3, breedType: 'Purebred', breed: 'Jack Russell',      bio: 'Tiny tornado. Catches frisbees twice her size 🌪️', vaccinated: 1, kyc: 0, score: 77, loc: 14 },
    { uid: 28, name: 'Marble',  username: '@marble_cake',   type: 'cat', gender: 'Female', age: 4, breedType: 'Mixed',    breed: 'Tortoiseshell',     bio: 'Multi-colored coat, multi-layered sass 🎂', vaccinated: 1, kyc: 0, score: 59, loc: 15 },
    // User 30 — 1 pet
    { uid: 29, name: 'Cosmo',   username: '@cosmo_star',    type: 'dog', gender: 'Male',   age: 2, breedType: 'Purebred', breed: 'Samoyed',           bio: 'Cloud dog. Professional smiler. Will brighten your day ✨', vaccinated: 1, kyc: 1, score: 93, loc: 16 },
  ];

  const petIds = [];
  petData.forEach((p, idx) => {
    const l = locations[p.loc];
    const r = db.run(
      `INSERT INTO pets (user_id, name, pet_username, type, gender, age, breed_type, breed_name, avatar_url,
       latitude, longitude, location_text, bio, vaccinated, pet_kyc, pawsitive_score, country, state, city, area,
       last_updated_location_timestamp, is_flagged, reported_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'India', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0, 0)`,
      [
        userIds[p.uid], p.name, p.username, p.type, p.gender, p.age, p.breedType, p.breed,
        avatars[idx % avatars.length],
        l.lat, l.lng, `${l.area}, ${l.city}`, p.bio, p.vaccinated, p.kyc, p.score,
        l.state, l.city, l.area
      ]
    );
    petIds.push(Number(r.lastInsertRowid));
  });

  // Set active_pet_id for each user (first pet)
  const userPetMap = {};
  petData.forEach((p, i) => {
    if (!userPetMap[p.uid]) userPetMap[p.uid] = petIds[i];
  });
  Object.entries(userPetMap).forEach(([uidIdx, petId]) => {
    db.run('UPDATE users SET active_pet_id = ? WHERE id = ?', [petId, userIds[uidIdx]]);
  });

  // ── Posts: 2 posts per user with pet (first 20 pets) ──
  const captions = [
    'Morning walk vibes! Nothing beats fresh air and zoomies 🌅🐾',
    'Someone stole my spot on the couch... again 😤🛋️',
    'Beach day with my best furry friend! Sand between the paws 🏖️',
    'Just got groomed and feeling fabulous! 💅✨',
    'Found a new hiding spot. Good luck finding me! 🙈',
    'That post-bath shake is an Olympic sport 🏊‍♂️💦',
    'My human made me wear this outfit. Send help. 👗',
    'Park playdate was a success! Made 3 new friends today 🎉',
    'Sunset walks hit different when you\'re this photogenic 📸',
    'Monday mood: back to guarding the house 🛡️',
    'Treat? Did someone say treat? I heard treat! 🦴',
    'Rain check on the walk today. Blanket fort instead 🌧️',
    'Learning to shake paws! My human is SO impressed 🤝',
    'Window watching is a full-time job and I\'m employee of the month 🏆',
    'Nap count today: 7. It\'s only 2 PM. Personal best. 😴',
    'Went to the vet. Survived. Barely. Need treats for emotional damage 🏥',
    'My tail wag could power a small city ⚡',
    'Caught the red dot today. Life goals achieved. 🔴',
    'First time at the dog park! So many butts to sniff! 🐕',
    'Adopted 2 years ago today. Best decision my human ever made ❤️',
  ];

  const postIds = [];
  for (let i = 0; i < 20 && i < petIds.length; i++) {
    const r = db.run(
      'INSERT INTO posts (pet_id, caption, media_url, media_type) VALUES (?, ?, ?, ?)',
      [petIds[i], captions[i], avatars[i % avatars.length], 'image']
    );
    postIds.push(Number(r.lastInsertRowid));
  }

  // ── Likes: random realistic engagement ──
  postIds.forEach(postId => {
    const likerCount = 3 + Math.floor(Math.random() * 8); // 3-10 likes per post
    const shuffled = [...userIds].sort(() => Math.random() - 0.5).slice(0, likerCount);
    shuffled.forEach(uid => {
      try { db.run('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [postId, uid]); } catch(e) {}
    });
  });

  // ── Comments: 1-3 per post ──
  const commentTexts = [
    'So adorable! 🥰', 'Looking gorgeous! ✨', 'Boop that snoot! 🐽',
    'Pack walk soon? 🐾', 'Living the best life!', 'Can I come play? 🎾',
    'This made my day! 💕', 'What a cutie! 🐶', 'Goals honestly!',
    'The tail wag! 😍', 'Need to meet this floofer!', 'SO precious!!'
  ];
  postIds.forEach(postId => {
    const commentCount = 1 + Math.floor(Math.random() * 3);
    for (let c = 0; c < commentCount; c++) {
      const uid = userIds[Math.floor(Math.random() * userIds.length)];
      const text = commentTexts[Math.floor(Math.random() * commentTexts.length)];
      try { db.run('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)', [postId, uid, text]); } catch(e) {}
    }
  });

  // ── Swipes, Matches & Conversations ──
  // Create 8 mutual matches with conversations
  const matchPairs = [
    [0, 2], [1, 4], [3, 6], [5, 8], [7, 10], [9, 12], [11, 14], [13, 16],
  ];
  matchPairs.forEach(([a, b], idx) => {
    try {
      db.run('INSERT INTO swipes (from_pet_id, to_pet_id, action) VALUES (?, ?, ?)', [petIds[a], petIds[b], 'like']);
      db.run('INSERT INTO swipes (from_pet_id, to_pet_id, action) VALUES (?, ?, ?)', [petIds[b], petIds[a], 'like']);
      const matchR = db.run('INSERT INTO matches (pet1_id, pet2_id) VALUES (?, ?)', [petIds[a], petIds[b]]);
      const convR = db.run('INSERT INTO conversations (match_id) VALUES (?)', [Number(matchR.lastInsertRowid)]);
      const convId = Number(convR.lastInsertRowid);

      // Seed 2-3 messages per conversation
      const msgs = [
        ['Hey! Want to go on a playdate this weekend? 🐾', 'seen'],
        ['Yes! That sounds pawsome! Where should we meet? 🏖️', 'seen'],
        ['How about the park near Marina Beach? Saturday 6 AM?', 'delivered'],
      ];
      msgs.forEach((m, mi) => {
        const sender = mi % 2 === 0 ? petData[a].uid : petData[b].uid;
        db.run('INSERT INTO messages (conversation_id, sender_id, content, status) VALUES (?, ?, ?, ?)',
          [convId, userIds[sender], m[0], m[1]]);
      });
    } catch(e) {}
  });

  // Create 5 pending meet requests (one-way likes) — for testing Notifications
  const pendingLikes = [
    [15, 0], [17, 2], [19, 4], [21, 6], [23, 8],
  ];
  pendingLikes.forEach(([from, to]) => {
    try {
      db.run('INSERT INTO swipes (from_pet_id, to_pet_id, action) VALUES (?, ?, ?)', [petIds[from], petIds[to], 'like']);
    } catch(e) {}
  });

  // ── Calls history ──
  matchPairs.slice(0, 4).forEach(([a, b]) => {
    try {
      db.run('INSERT INTO calls (caller_pet_id, receiver_pet_id, type, status, duration) VALUES (?, ?, ?, ?, ?)',
        [petIds[a], petIds[b], Math.random() > 0.5 ? 'video' : 'audio', 'completed', 30 + Math.floor(Math.random() * 300)]);
    } catch(e) {}
  });

  console.log(`✅ Ecosystem seeded: ${userIds.length} users, ${petIds.length} pets, ${postIds.length} posts, ${matchPairs.length} matches`);
}
