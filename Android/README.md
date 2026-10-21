# 🐾 Sniffr

Sniffr is a social network + dating app for pets. Owners create a profile for their pet, swipe to match with nearby pets, post to a shared feed, join breed/location-based communities ("PawCircles"), chat and video/audio call matches in real time, and get featured in a rotating local "Spotlight."

The project ships as a single web app built with React + Vite, wrapped with Capacitor to also produce a native Android APK, backed by an Express/Socket.IO API.

---

## Monorepo layout

```
Sniffr-main/
├── client/                  React (Vite) frontend + Capacitor Android shell
│   ├── src/
│   │   ├── pages/           Route-level screens (Auth, Home, Meet, Chat, Profile, Spotlight, Community, ...)
│   │   ├── components/      Reusable UI (modals, cards, nav, notifications, chat bubbles, ...)
│   │   ├── context/         React context providers (Auth, Socket, Call, Permission, App)
│   │   ├── services/        api.js (REST client), socket.js, location & permission services
│   │   └── hooks/           Custom hooks (e.g. usePullToRefresh)
│   ├── android/             Capacitor-generated native Android project
│   └── public/              Static assets (paw icons, images)
│
├── server/                  Express API + Socket.IO backend
│   ├── routes/              REST endpoints (auth, posts, matches, chat, profile, spotlight, privacy, communities, notifications)
│   ├── socket/               Socket.IO namespaces (chat, calls, notifications, communities)
│   ├── models/               Repository layer (one per entity: User, Pet, Post, Match, Message, Call, Community, Notification, Spotlight)
│   ├── middleware/            auth (JWT), rate limiting, input sanitization, validation
│   ├── storage/                Pluggable media storage (LocalStorage adapter / Cloudinary in production)
│   ├── db/                     Postgres connection pool + migrations
│   └── uploads/                 Local media storage (avatars, posts, chat, community media) — used when STORAGE_TYPE=local
│
├── create_profile/, home_feed/, loading/, meet_matches/, my_pet_profile/,
│   paws_chat/, pet_selection/, privacy_policy/, sign_up_*/, spotlight/,
│   terms_conditions/, velvet_paws/            Static Stitch/design-export HTML mockups (reference only, not built/served by the app)
│
└── walkthrough.md            Changelog-style notes from a past feature checkpoint
```

---

## Tech stack

**Frontend** — React 18, React Router 6, Vite 6, Tailwind CSS 4, Socket.IO client, Capacitor 8 (Android), lucide-react icons.

**Backend** — Node.js (ESM) + Express 4, Socket.IO 4, PostgreSQL (via the `pg` driver, hosted on Supabase in this project), JWT auth (access + rotating refresh tokens), bcrypt password hashing, Helmet + CORS, Multer for uploads, Sharp for image processing, Cloudinary for hosted media storage, Nodemailer for transactional email.

---

## Core features

- **Auth** — email/password signup with email verification, Google & Apple sign-in, login, JWT access + refresh tokens, forgot/reset password, optional "Pawprint" 2FA via emailed code, session refresh.
- **Pet profiles** — multi-pet support per account, active-pet switching, avatar upload, location (Google Places autocomplete), "pawsitive score," KYC/vaccination flags.
- **Home feed** — image/video posts, likes, comments, emoji reactions, shares, reporting/moderation, infinite/incremental loading.
- **Meet** — swipe-based matching between pets (like/pass), match creation, match-request accept/decline flow.
- **Chat** — 1:1 messaging with media attachments, message replies, delivery/seen receipts, conversation search, "nearby" suggestions, shared posts, meetup proposals, real-time delivery over Socket.IO.
- **Calls** — audio/video calling between matched pets with call history logging (WebRTC signaling over Socket.IO).
- **PawCircle (communities)** — create/join/leave communities, roles, group chat, announcements (pinned/unpinned), photo galleries, events, polls, join requests for private communities, member moderation.
- **Spotlight** — cyclical local leaderboard of top-scoring pets by area.
- **Notifications** — categorized (matches, activity, pawcircle, nearby, offers, email) with per-category preferences, unread counts, mark-as-read/all, deep links, real-time push via Socket.IO.
- **Privacy & safety** — user/content reporting, user blocking, account deletion, sanitized inputs, rate-limited auth/write endpoints.
- **Static legal pages** — Privacy Policy and Terms & Conditions.

---

## REST API overview

All routes are mounted under `/api` (see `server/index.js`).

| Base path | File | Responsibility |
|---|---|---|
| `/api/auth` | `routes/auth.js` | Signup, login, Google/Apple OAuth, email verification, 2FA, password reset/change, token refresh, logout, `/me` |
| `/api/posts` | `routes/posts.js` | Feed CRUD, likes, reactions, comments, shares, reports |
| `/api/matches` | `routes/matches.js` | Notification-style match feed, match-request respond, preferences *(shares the notifications repository)* |
| `/api/notifications` | `routes/notifications.js` | Notification feed, unread counts, mark read, preferences |
| `/api/chat` | `routes/chat.js` | Conversations, messages (with media), seen receipts, sharing, call history/log, search, nearby, meetup proposals |
| `/api/profile` | `routes/profile.js` | Profile CRUD, avatar upload, pet switching, blocking, places autocomplete, location updates, pawsitive score |
| `/api/spotlight` | `routes/spotlight.js` | Current spotlight ranking + history |
| `/api/communities` | `routes/communities.js` | PawCircle CRUD, membership, roles, messages, announcements, photos, events, polls |
| `/api/privacy` | `routes/privacy.js` | Account deletion |
| `/api/health` | `index.js` | Liveness check |

Real-time channels (`server/socket/`): `chat.js`, `calls.js`, `notifications.js`, `communities.js` — all authenticated via JWT in the socket handshake (`middleware/auth.js#authenticateSocket`).

---

## Database

Postgres. `server/db/migrations.js` documents the original full DDL, but its `runMigrations()` is dead code — **it is never invoked at server startup** (see the file's own header comment). Key tables:

`users`, `refresh_tokens`, `pets`, `posts`, `likes`, `comments`, `reactions`, `shares`, `post_reports`, `swipes`, `matches`, `conversations`, `messages`, `calls`, `communities`, `community_members`, `community_messages`, `community_announcements`, `community_photos`, `community_events`, `community_polls`, `community_join_requests`, `blocked_users`, `spotlight_history`, `notifications`, `notification_preferences`, `trusted_devices`.

**Every schema change since the initial DDL lives as a dated, hand-run file in `server/db/sql/*.sql`** — each one's own header comment says so explicitly ("Run by hand in the Supabase SQL editor, BEFORE deploying the backend that uses it"). They're written to be additive/idempotent (`IF NOT EXISTS`, `ON CONFLICT`, etc.), so re-running one that already applied is a safe no-op. For local dev, `node server/scripts/apply-local-sql.mjs` applies every one of them in order against the throwaway local Postgres `npm run db:local` spawns — see `server/scripts/local-db.js`. There is no automatic migration runner for the real database: after pulling a change that adds a new `db/sql/*.sql` file, it must be applied by hand to Supabase before that code is deployed, or the new code's queries will fail against columns/indexes that don't exist yet.

---

## Getting started

### Prerequisites
- Node.js 18+
- A PostgreSQL database (the project is configured for Supabase, but any Postgres instance works)
- (Optional) Cloudinary account for cloud media storage, Google OAuth credentials, a Resend API key (or SMTP credentials) for email

### 1. Install dependencies
```bash
npm run install:all
```
This installs the root, `server/`, and `client/` dependencies in one go.

### 2. Configure environment variables

**`server/.env`**
```
PORT=3001
NODE_ENV=development
CLIENT_URL=http://localhost:5173

DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<db>
DB_POOL_MIN=2
DB_POOL_MAX=20

JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

STORAGE_TYPE=local        # or "cloud" to use Cloudinary
UPLOAD_DIR=./uploads

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

CORS_ORIGINS=*

RESEND_API_KEY=            # email via Resend's HTTP API; SMTP_* below is the fallback
# EMAIL_FROM=Sniffr <no-reply@sniffrweb.com>

SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=

GOOGLE_PLACES_API_KEY=
```

**`client/.env`**
```
VITE_API_URL=http://localhost:3001    # origin only, no /api suffix -- api.js and socket.js both append paths themselves
VITE_GOOGLE_CLIENT_ID=
VITE_APPLE_SERVICE_ID=
```

> Both `.env` files are git-ignored. Never commit real secrets — rotate any credentials that have been shared or exposed.

### 3. Run in development
```bash
npm run dev
```
This runs the Express API (`:3001`) and the Vite dev server (`:5173`) concurrently. Vite proxies `/api`, `/uploads`, and `/socket.io` to the backend, so the client can be developed against `/api` directly.

Alternatively, run each side independently:
```bash
npm run server   # server/ → node index.js
npm run client   # client/ → vite --host
```

### 4. Build for production
```bash
cd client && npm run build     # outputs client/dist
cd server && npm start         # serves the API (index.js)
```

### 5. Android (Capacitor)
```bash
cd client
npm run cap:sync    # build web assets + sync into the Android project
npm run cap:open    # open in Android Studio
npm run cap:build   # build + sync + open in one step
```

---

## Deployment

The server is deployed on [Render](https://render.com) as a Web Service: set the service's **Root Directory** to `server`, build command `npm install`, start command `node index.js`. The client is a static Vite build (`client/dist`) that can be hosted on any static host/CDN, with `VITE_API_URL` pointed at the deployed Render server.

**`CORS_ORIGINS`:** `*` is fine for local dev but **does not work in production** — the server sends `Access-Control-Allow-Credentials: true` (needed for authenticated requests), and per the CORS spec browsers refuse a wildcard origin together with credentials. Set this in Render's own env vars to your real deployed frontend origin(s) before going live; see `.env.example` and `SECURITY_REVIEW_2026-10-13.md` finding #4.

---

## Security

- `AUDIT_REPORT.md` — a full pre-production security/pentest audit (auth, authorization/IDOR, injection, CORS, secrets, API, database, performance). Most findings are fixed and re-verified live; a few are explicitly deferred because they need the project owner's own action (rotating third-party credentials, a real payment provider).
- `SECURITY_REVIEW_2026-10-13.md` — a follow-up live review. Re-confirms the audit's fixes still hold, flags what's still genuinely open from it (confirming `CORS_ORIGINS` in production, and whether the old leaked-secrets finding applies to this repo), and covers what's new since (a rate-limiting gap, a PawCircle name-uniqueness race condition, current `npm audit` status for both client and server).
- Read both before a production deploy, especially the still-open items in the newer one — they need your action, not more code.

---

## Notes

- `sniffr.db` at the repo root and in `server/` are leftover local SQLite artifacts from an earlier `sql.js`-based setup; the app now runs entirely on Postgres via `server/db/connection.js`.
- The top-level `create_profile/`, `home_feed/`, `pet_selection/`, `spotlight/`, etc. folders are standalone HTML/CSS design exports (from a Stitch prototyping tool) kept for visual reference — they are not part of the build pipeline.
- `walkthrough.md` documents a specific past change set (interaction bar, share sheet, reporting flow, user blocking) rather than the project as a whole.
- `version1.md` documents a specific past working session's change set (responsive UI/UX refinement) rather than the project as a whole — same convention as `walkthrough.md`.
- `version2.md` documents this session's change set (PawCircle slug URLs, PawCircle reopen crash, chat media viewer, back-button navigation, today's security review) — same convention.
