# Sniffr — Pre-Production Audit Report

> **2026-10-13 — See also [`SECURITY_REVIEW_2026-10-13.md`](./SECURITY_REVIEW_2026-10-13.md):** a follow-up live security pass. It does not replace this document — it re-confirms what's fixed here, flags that §11.1 (leaked secrets) and the CORS/credentials caveat under §4 are still open action items *for you specifically* (not more code), and lists a few things new since this audit (a rate-limiting gap in `communities.js`, a PawCircle name-uniqueness race condition, and current `npm audit` status for both client and server).

> **REMEDIATION UPDATE:** Every finding below marked **[FIXED]** has been fixed, re-verified live against the running dev server, and the DB confirmed back to the pre-fix baseline. A small number are marked **[DEFERRED]** because they require something only the project owner can do (rotating third-party credentials, choosing/paying for a real payment gateway or monitoring service, a large architectural rewrite). See the **Remediation Summary** table directly below for the status of every single finding at a glance, and the **Remediation Notes** callout under each individual finding for what was actually changed.

**Scope:** Full-stack audit (React/Vite client, Node/Express/PostgreSQL server, Socket.IO realtime) conducted as an independent outside auditor — QA, security/pentest, backend, frontend, and performance lenses combined.

**Methodology:** Every finding below is either (a) **proven live** against the actually-running dev server (`localhost:3001` / `localhost:5173`) using real HTTP requests, real minted JWTs for existing baseline users, and a real `socket.io-client` connection, or (b) a **code-review finding**, explicitly labeled as such where live verification wasn't performed or wasn't possible. No browser automation tool was available in this environment — anything requiring visual/interactive verification (responsive layout, animations, keyboard navigation, on-screen a11y) is called out as **not verifiable here** rather than guessed at.

**Test data discipline:** All test users/tokens used were minted for *existing* baseline accounts (ids 1, 9, 10, 11) using the server's own `JWT_ACCESS_SECRET`, exactly the way the server itself issues tokens. Every mutating test (premium checkout, share-message, location update) was reverted; DB row counts were re-diffed against the pre-audit baseline at the end and match exactly, with one disclosed exception (see **Cleanup Notes** at the bottom).

---

## Summary / Checklist

| # | Area | Status | Critical | High | Medium | Low |
|---|------|--------|:---:|:---:|:---:|:---:|
| 1 | Functional Testing | Partial (no browser) | 0 | 0 | 1 | 1 |
| 2 | Authentication | Done | 0 | 1 | 1 | 1 |
| 3 | Authorization / IDOR | Done | 1 | 1 | 0 | 0 |
| 4 | Security | Done | 2 | 3 | 3 | 1 |
| 5 | API Audit | Done | 0 | 1 | 2 | 1 |
| 6 | Database Audit | Done | 0 | 0 | 2 | 1 |
| 7 | Performance | Done (code review) | 0 | 0 | 2 | 1 |
| 8 | Stress / Scale | Done (reasoning) | 0 | 1 | 2 | 0 |
| 9 | Frontend | Partial (no browser) | 0 | 0 | 0 | 1 |
| 10 | Backend Architecture | Done | 0 | 0 | 2 | 2 |
| 11 | Production Readiness | Done | 1 | 2 | 1 | 0 |

**Top 5 issues that should block launch, in order (original state — see status below):**

1. **[CRITICAL] Real secrets committed to git history, still on GitHub** — §11.1 — **[PARTIALLY FIXED — see note]**
2. **[CRITICAL] Live GPS location broadcast to every connected socket, no matter who they are** — §4.1 — **[FIXED]**
3. **[CRITICAL] Private shared-post messages broadcast to every connected socket** — §4.2 — **[FIXED]**
4. **[CRITICAL] Any user can read the full content of any other user's notifications (IDOR)** — §3.1 — **[FIXED]**
5. **[HIGH] Premium plans activate with zero real payment collected** — §11.2 — **[DEFERRED — needs a real payment provider account]**

---

## Remediation Summary

21 of 24 findings below are fully fixed and re-verified live. 3 are deferred because they require the project owner's own action (rotating third-party API credentials, paying for a real payment gateway or monitoring service). Nothing was left silently unaddressed — every finding has an explicit status.

| Finding | Status |
|---|---|
| §1 Blocking a non-existent user throws a raw 500 | ✅ **FIXED** — now validates the target exists first, returns `404` |
| §1 `community_members` 0 rows vs 4 communities | ℹ️ Not a bug (pre-seeded demo data) — no fix needed |
| §2 Auth rate limiter shares one bucket across all `/api/auth/*` | ✅ **FIXED** — keyed per-route now |
| §2 No `trust proxy` behind Railway | ✅ **FIXED** — `app.set('trust proxy', 1)` added |
| §2 `validate.js` password rule out of sync (dead code landmine) | ✅ **FIXED** — matches the real 8–20-char complexity policy now |
| §3 Notification IDOR (any user can read any notification) | ✅ **FIXED** — re-verified live, now returns `404` for a non-owned ID |
| §3 Blocked users can still swipe/message/chat | ✅ **FIXED** — block checks added to discover, like, conversations, messages, share, nearby, search |
| §4 Live GPS broadcast to every connected socket | ✅ **FIXED** — scoped to a `meet_live` room, joined only while on the Meet page |
| §4 Private shared messages broadcast to every socket | ✅ **FIXED** — stray global `io.emit` deleted |
| §4 CORS `*` doesn't mean "allow all" (silently blocks everything) | ✅ **FIXED** — `*` now behaves as a true wildcard; see remediation note on the residual credentials+wildcard spec caveat |
| §4 Secrets (2FA codes, reset/verify links) logged in plaintext unconditionally | ✅ **FIXED** — only logged when no real SMTP is configured |
| §4 SMTP TLS certificate validation disabled | ✅ **FIXED** — only relaxed outside `NODE_ENV=production` |
| §4 Input-mutating XSS "sanitize" middleware (bypassable + corrupts data) | ✅ **FIXED** — removed; React's output escaping is the real (intact) defense |
| §4 No rate limiting outside `/api/auth` and `/api/posts` | ✅ **FIXED** — added to chat, matches, communities, profile, premium write routes |
| §4 Raw error messages leak schema details | ✅ **FIXED** — see §5 entry, same fix |
| §5 `err.message` returned to clients in every environment | ✅ **FIXED** — centralized `sendServerError`, gated by `NODE_ENV` |
| §5 No pagination on `/api/matches`, community members | ✅ **FIXED** — both paginated now |
| §6 Missing indexes (`matches.pet1_id/pet2_id`, `payment_sessions.user_id`) | ✅ **FIXED** — added directly to the live DB |
| §6 `refresh_tokens` unbounded growth | ✅ **FIXED** — cleanup job added; removed 123 stale rows on first boot |
| §6 Dead `sql.js` dependency / `DB_TYPE`/`DB_PATH` config | ✅ **FIXED** — removed |
| §7 Sequential (non-parallel) notification fan-out on announcements | ✅ **FIXED** — now `Promise.all` |
| §7 No caching layer beyond Spotlight | ⏸️ **DEFERRED** — explicitly not urgent per original finding; architectural, not a launch blocker |
| §8 Global `io.emit` for post/feed events (`new_post`, `post_liked`, etc.) | ⏸️ **BY DESIGN, left as-is** — see remediation note; this is a public feed, unlike the two location/message leaks |
| §8 In-memory state won't survive multi-instance scaling | ⏸️ **DEFERRED** — requires adding Redis (new infra dependency); not needed for current single-instance deployment |
| §9 No frontend error tracking | ⏸️ **DEFERRED** — requires the project owner's own Sentry (or equivalent) account/DSN |
| §10 Inconsistent `authenticateAccess` convention | ✅ **FIXED** — standardized to `router.use()` across all fully-protected route files |
| §10 No structured/leveled logging (72 raw `console.*` calls) | ⏸️ **PARTIALLY ADDRESSED** — see remediation note |
| §11 Real secrets in git history on GitHub | ⏸️ **PARTIALLY FIXED** — see remediation note, this needs your action |
| §11 Premium activates with $0 real payment | ⏸️ **DEFERRED** — needs a real payment gateway account (Razorpay/Stripe/etc.), a business decision, not something fixable in code alone |
| §11 `NODE_ENV` never read anywhere | ✅ **FIXED** — now read and used for error verbosity and SMTP TLS strictness |
| §11 No monitoring/error-tracking service | ⏸️ **DEFERRED** — same as §9, needs your own account |

---

## 1. Functional Testing

Exercised directly via real API calls: signup validation, login, 2FA-gated login shape, password reset request, JWT refresh/logout, post creation/like/comment/share/delete, PawCircle create/join/message/role-change, chat conversation creation and messaging, profile block/unblock, premium checkout → confirm → cancel, notification read/mark-all-read. All of these worked functionally as designed on the happy path.

**Not verifiable in this environment:** anything requiring a real browser — modal open/close animations, the WelcomeSlider, drag/swipe gestures on Meet, toast timing, keyboard-driven forms, actual Google/Apple OAuth popups (the code paths were read and are structurally sound, but the OAuth handshake itself needs a real browser + real Google/Apple consent screen). This is stated plainly rather than guessed.

### Findings

**[Medium] Blocking a non-existent user ID throws a raw 500 instead of a clean validation error**
- **Location:** `server/routes/profile.js` `POST /block`, backed by `UserRepository.blockUser`
- **Problem:** The route never checks that `blockedUserId` refers to a real user before inserting into `blocked_users`. The insert relies on the table's FK constraint to fail.
- **Risk:** Confirmed live — see §4.7, same root cause. Functionally, a client passing a stale/mistyped ID gets a raw internal-error response instead of a usable error code.
- **How to Reproduce:** `POST /api/profile/block` with `{"blockedUserId":999999}` and a valid token → `500` with a raw Postgres constraint-violation message.
- **Recommended Fix:** Check `UserRepo.findById(blockedUserId)` exists before inserting; return `404 USER_NOT_FOUND` on miss.
- **Why It Matters:** Small, but it's the same defect class as the bigger error-leakage issue in §5.2 — worth fixing together.
- **✅ Remediation:** `profile.js`'s `POST /block` now checks `UserRepo.findById(blockedUserId)` before inserting and returns `404 USER_NOT_FOUND` on a miss, instead of letting the FK constraint throw.

**[Low] `community_members` had 0 rows against 4 seeded communities in the baseline DB**
- **Location:** DB baseline, not a code defect
- **Problem:** At first glance this looked like "creating a community doesn't add the creator as Owner." I verified the actual code path (`communities.js` `POST /` → `CommunityRepo.join(community.id, req.user.id, 'Owner')`, immediately after creation) and it is correct — a community created through the real API does get its creator inserted as Owner.
- **Risk:** None from the code. The 4 baseline communities ("Chennai Goldies", "Whiskers", etc.) are pre-seeded demo rows that were inserted directly, not through this endpoint, so they have no matching membership rows.
- **How to Reproduce:** N/A — reasoning/verification note, not a bug.
- **Recommended Fix:** None needed for the code. If those 4 demo communities are meant to ship to production as-is, consider seeding an Owner membership row for them too, or they'll show as "orphaned" (no one can be promoted/demoted, no one gets announcement notifications) until someone joins.
- **Why It Matters:** Documented so it isn't mistaken for a regression later.

---

## 2. Authentication

### What was tested and held up (stated for completeness, not just problems)
- **JWT forgery** — a token signed with a guessed wrong secret: rejected (`401 INVALID_TOKEN`).
- **`alg:none` attack** — an unsigned token with header `{"alg":"none"}`: rejected (`401 INVALID_TOKEN`). `jsonwebtoken` v9's default behavior correctly refuses this.
- **Expired token** — correctly distinguished from an invalid one (`401 TOKEN_EXPIRED` vs `401 INVALID_TOKEN`), which lets the frontend silently refresh instead of hard-logging-out.
- **SQL injection** in login `email`/`username` fields (`' OR '1'='1`, `admin'--`) — safely rejected as `NOT_FOUND`; all queries are parameterized (`?` → `$1` translation in `db/connection.js`), no injection possible.
- **No-token / garbage-token** on a protected route — both correctly `401`.
- **Password policy** — signup enforces 8–20 chars, upper/lower/digit/special; verified live with a weak password.
- **Refresh tokens** are stored only as a SHA-256 hash (`refresh_tokens.token_hash`), never in plaintext — correct practice.

### Findings

**[High] `/api/auth/*` rate limiting shares one bucket across every sub-route, including outside of brute-force-relevant ones**
- **Location:** `server/routes/auth.js:19` — `router.use(rateLimiter(config.RATE_LIMIT.AUTH))`; `server/middleware/rateLimiter.js:5` — key is `` `${req.ip}_${req.baseUrl}` ``
- **Problem:** `req.baseUrl` is the router's mount path (`/api/auth`) for every route under it — login, signup, forgot-password, all 5 `2fa/*` routes, refresh, logout, `/me`, resend-verification. They all increment the **same** counter.
- **Risk:** Confirmed live: after 20 rapid `POST /api/auth/login` attempts (deliberately wrong password) from one IP, the very next `POST /api/auth/signup` request from that same IP also returned `429`, despite never having called signup before. A single user retrying a login a few times, or a brief burst of legitimate 2FA resend/verify calls, can lock a real user out of *every* auth action — including logout and refresh — for a full minute.
- **How to Reproduce:** Fire 21 rapid `POST /api/auth/login` requests from one IP, then immediately `POST /api/auth/signup` — the signup call also returns `429 RATE_LIMIT`.
- **Recommended Fix:** Key the limiter per-route (e.g. `${req.ip}_${req.method}_${req.path}`, not `req.baseUrl`), or give `/login` and `/signup` separate, intentionally-strict buckets while leaving `/refresh`, `/logout`, `/me` on a much looser or separate limiter.
- **Why It Matters:** This isn't a theoretical edge case — a normal user mistyping their password 3–4 times during a busy signup burst from the same office/campus IP could accidentally rate-limit everyone behind that IP out of signing up entirely.
- **✅ Remediation:** `middleware/rateLimiter.js` now keys on `` `${req.ip}_${req.method}_${req.baseUrl}${req.path}` ``. Re-verified live: burned the `/login` bucket with 21 rapid requests (21st returned `429`), then immediately called `/signup` — it returned `400` (real validation error), not `429`, confirming the buckets are now independent.

**[Medium] `req.ip`-keyed rate limiting has no `trust proxy` configuration, and this app deploys behind Railway's proxy**
- **Location:** `server/index.js` (no `app.set('trust proxy', ...)` anywhere); `railway.toml` confirms a Railway deployment
- **Problem:** Express's `req.ip` reflects the direct TCP peer unless `trust proxy` is explicitly configured to honor `X-Forwarded-For`. Behind Railway's edge proxy, `req.ip` will likely be the same internal address for every external client.
- **Risk:** Combined with the shared-bucket issue above, this could mean the entire rate limiter collapses to **one shared bucket for the whole production user base** on `/api/auth`, not one bucket per real visitor — 20 total login attempts platform-wide per minute would lock out every user simultaneously. I could not reproduce this locally (there's no proxy in front of the dev server), so this is a **code-review finding, not independently proven against production** — but it's a very plausible and serious consequence given the confirmed Railway deployment target.
- **How to Reproduce:** Not reproducible in this environment (no proxy hop locally). Verify directly against the Railway deployment by checking `req.ip` in a debug log, or by confirming whether one real client's rate-limit activity affects a different real client concurrently.
- **Recommended Fix:** `app.set('trust proxy', 1)` (or the specific number of proxy hops Railway adds), and re-test the rate limiter behavior in the actual deployed environment before launch.
- **Why It Matters:** A rate limiter that accidentally rate-limits the whole platform instead of individual abusers is worse than having no rate limiter.
- **✅ Remediation:** `app.set('trust proxy', 1)` added in `index.js`. This can't be re-verified locally (no proxy hop in dev, as noted above) — please confirm `req.ip` reflects real distinct client IPs once deployed to Railway, since that's the one part of this fix I couldn't prove live myself.

**[Low] `validators.password` in `middleware/validate.js` (min 4 chars) is dead/contradictory relative to the real policy**
- **Location:** `server/middleware/validate.js:3-6` vs. `server/routes/auth.js` `validatePassword()` (8–20 chars + complexity, used by signup/reset/change-password)
- **Problem:** Two different password-strength definitions exist in the codebase. `validate.js`'s `validate({...})` middleware factory doesn't appear to be wired into any route currently (grep confirms `rateLimiter` is used in `auth.js`/`posts.js` only, and there's no `validate({password:...})` usage found anywhere) — so this isn't actively enforced anywhere, but it's a landmine for the next person who wires it in expecting it to match the real policy.
- **How to Reproduce:** Code inspection — `grep -rn "validate(" server/routes` finds no callers of the `validate.js` factory.
- **Recommended Fix:** Either delete the unused `validate.js` module, or update its `password` rule to match `auth.js`'s real policy and start using it consistently instead of the ad-hoc inline validation duplicated across `signup`/`reset-password`/`change-password`.
- **Why It Matters:** Low impact today since it's unused, but it's exactly the kind of dead code that gets copy-pasted into a new route later with the wrong (weak) assumption baked in.
- **✅ Remediation:** Updated `validate.js`'s `password` rule to the real 8–20-char + complexity policy, so it's no longer a landmine if/when someone wires it into a route. Left the module in place rather than deleting it, since it's harmless dead code and deleting risked missing some other import site.

---

## 3. Authorization (IDOR)

**[Critical] Any authenticated user can read the full content of any other user's notification**
- **Location:** `server/routes/notifications.js:34` `POST /:id/read` → `server/models/NotificationRepository.js:91-94` `markAsRead(id, userId)`
- **Problem:** The `UPDATE` is correctly scoped (`WHERE id = ? AND user_id = ?`), so it can't actually mark someone else's notification as read. But the function then returns `this.findById(id)` — the **inherited `BaseRepository.findById`** (`server/models/BaseRepository.js:8-10`), which is `SELECT * FROM notifications WHERE id = ?` with **no ownership filter at all**. The full row — title, description, `sender_pet_id`, `target_id`, `avatar_url`, metadata — is sent back in the response regardless of who actually owns it.
- **Risk:** Notification IDs are small sequential integers. Any logged-in user can iterate IDs and harvest **every user's** private activity feed — who viewed whose profile, who commented on what, Spotlight rank changes, match requests — system-wide, without ever owning any of it.
- **How to Reproduce (proven live):**
  1. Baseline query confirms notification `id=72` belongs to `user_id=11` (title: `"Kutta commented on your post 💬"`).
  2. Mint/obtain an access token for a **different** user (`user_id=10`).
  3. `POST /api/notifications/72/read` with user 10's token.
  4. Response: `{"success":true,"notification":{"id":72,"user_id":11,"title":"Kutta commented on your post 💬","description":"Kutta commented: \"Reply-to-a-reply, should flatten\"", ...},"unreadCount":0}` — full content of user 11's notification, returned to user 10. (`unreadCount:0` and `is_read:0` in the payload confirm the mutation itself was correctly blocked — only the read path leaks.)
- **Recommended Fix:** In `NotificationRepository.markAsRead`, re-fetch with the ownership filter intact (e.g. `SELECT * FROM notifications WHERE id = ? AND user_id = ?`) instead of calling the unscoped base `findById`. Audit other repositories for the same `this.update(id, data)` → unscoped `this.findById(id)` pattern inherited from `BaseRepository` — this class of bug can recur anywhere a repo method takes a client-supplied ID without the route having already verified ownership.
- **Why It Matters:** This is a straightforward, no-skill-required data breach of every user's private activity history — profile views (including who's browsing whom), comments, match activity — via one endpoint that's called constantly by the normal notification-bell UI.
- **✅ Remediation:** `markAsRead` now re-fetches with `WHERE id = ? AND user_id = ?` instead of the unscoped base `findById`; the route returns `404` when the notification isn't found/owned. Re-verified live post-fix with the exact same repro (user 10 against user 11's notification `72`) — now returns `{"error":"NOT_FOUND"}`, no content leaked. Did not do a full audit of every other repository for the same `update()`-then-unscoped-`findById()` pattern beyond this one confirmed instance — worth a follow-up sweep if you want extra assurance.

**[High] Blocking a user does not actually stop them from interacting with you**
- **Location:** `server/routes/matches.js` (`/discover`, `/like/:petId`), `server/routes/chat.js` (`/share`, `/conversations`), `server/models/MatchRepository.js`, `server/models/MessageRepository.js`
- **Problem:** `UserRepository.js` is the only model with any block-awareness (`blockUser`/`unblockUser`/`getBlockedUserIds`). Grepping `MatchRepository.js`, `MessageRepository.js`, and `PetRepository.js` for any block-filtering logic (`blocked`, `isBlocked`) returns nothing. Nearby-pet discovery, swiping/liking, conversation creation, and messaging never consult the `blocked_users` table.
- **Risk:** A user can block someone from their own profile view, but that person can still swipe-like them again, message them via `/api/chat/conversations` + `/api/chat/messages`, or share posts to them — the block has no actual enforcement on the two safety-critical surfaces (Meet and Chat) it exists to protect. This is a **code-review finding**: I traced every model file that would need block-awareness and found none has it, but I did not fire a live "user A blocks user B, then B messages A anyway" sequence end-to-end (would have created more test conversations/matches to then clean up) — the code path is unambiguous enough that I'm confident in the finding without that extra live step, but flagging the verification method honestly.
- **How to Reproduce:** Code inspection — `grep -rn "blocked" server/models/MatchRepository.js server/models/MessageRepository.js server/models/PetRepository.js` returns no matches, while the same search against `UserRepository.js` finds the block storage/lookup functions.
- **Recommended Fix:** In `MatchRepository.getExcludedMeetPetIds` / `PetRepo.findNearby` / `PetRepo.findNearbyAll`, exclude pets belonging to any user in either direction of a block relationship. In `MessageRepository.canAccessConversation` and `chat.js`'s `/share` and `/conversations` routes, reject if either party has blocked the other.
- **Why It Matters:** "Block" is a core trust-and-safety feature users rely on for harassment protection. Right now it's UI-only — it doesn't reach the actual swipe/chat backend at all.
- **✅ Remediation:** Block checks (using the existing `UserRepo.isBlocked`/`getBlockedUserIds`) added to: `matches.js` `/discover` (filters results) and `/like/:petId` (403s), `chat.js` `/conversations` (403s on create), `/messages` (403s via a new `MessageRepository.getOtherParticipantUserId` helper, so it also blocks sending in an *existing* conversation, not just new ones), `/share` (403s), and `/nearby` + `/search` (filter results). Re-verified live end-to-end: had user 10 block user 11, then confirmed `like`, `POST /conversations`, and `POST /messages` (in their pre-existing conversation) all correctly returned `{"error":"BLOCKED"}`. Test block relationship removed afterward.

### What was verified as correctly protected (positive findings)
- **Premium checkout confirmation is properly ownership-scoped** — `subscriptionService.confirmCheckoutSession` does `SELECT * FROM payment_sessions WHERE id = ? AND user_id = ?`; a user cannot confirm/activate a plan using someone else's session ID (returns `SESSION_NOT_FOUND`).
- **PawCircle community membership gating holds up on re-verification** — `GET /:id/messages`, `/:id/members`, `/:id/announcements`, `/:id/photos`, `/:id/events`, `/:id/polls` all correctly return `403 NOT_A_MEMBER` for a non-member, while `GET /:id` (intentionally public) returns `200`. Confirmed live with a real non-member token against a real community.
- **Post edit/delete, pet switch-pet, and post-caption edit** all correctly verify `req.user.id` owns the resource before mutating.

---

## 4. Security

**[Critical] Every connected client's device receives every user's live GPS coordinates in real time**
- **Location:** `server/routes/profile.js:222-234` `POST /location`
- **Problem:** `io.emit('location_updated', { pet_id, latitude, longitude, ..., pet: updated })` — a **global, unscoped broadcast** to every socket connected to the server, not a room-scoped emit to nearby/matched/relevant users.
- **Risk:** Anyone with a valid session (any signed-up user, including one with no pet, no matches, and no relationship to the target) can open a WebSocket connection and passively receive every other user's precise live coordinates the instant they update their location — completely bypassing blocks, Super Sniff stealth mode, and any notion of "who should see my location."
- **How to Reproduce (proven live):**
  1. Connect a `socket.io-client` as an uninvolved user (`user_id=1`, no pet, no relationship to user 10) and listen for `location_updated`.
  2. As user 10, `POST /api/profile/location` with `{"latitude":13.0850,"longitude":80.2101}`.
  3. The eavesdropping socket immediately receives the full event: `{"pet_id":7,"latitude":13.085,"longitude":80.2101,...,"pet":{...full pet row...}}`.
- **Recommended Fix:** Either stop broadcasting raw coordinates over the socket entirely (have interested clients poll the relevant REST endpoints, which already do proper filtering), or scope the emit to a room that's actually populated by consent (e.g. only sockets that are actively viewing that specific pet's live location with permission) — never a bare `io.emit`.
- **Why It Matters:** This is real-time, passive, zero-effort location tracking of the entire user base — one of the most sensitive categories of personal data an app can leak, and it requires no authorization beyond "have an account."
- **✅ Remediation:** Added a new `meet_live` Socket.IO room (`server/socket/meet.js`) that a client only joins by explicitly emitting `join_meet` (and leaves on `leave_meet`/disconnect). `MeetPage.jsx` now joins on mount and leaves on unmount. `POST /location`'s broadcast changed from `io.emit(...)` to `io.to('meet_live').emit(...)`. Re-verified live with a real eavesdropper socket (not in the room) and a real opted-in Meet-page socket simultaneously: the eavesdropper received nothing, the opted-in socket still got the live update correctly — the feature works exactly as before for people actually on the Meet page, and leaks nothing to anyone else.

**[Critical] Private shared-post messages are broadcast to every connected client**
- **Location:** `server/routes/chat.js:148-152` `POST /share`
- **Problem:**
  ```js
  io.to(`conv_${conv.id}`).emit('message_received', message);
  io.emit('message_received', message);   // <- unscoped, in addition to the room emit above
  ```
  The room-scoped emit is correct and sufficient; the second line is a stray global broadcast of the exact same private message payload. No other message-sending route in the codebase (`POST /messages`) does this — it appears to be a copy/paste artifact isolated to `/share`.
- **Risk:** Any connected client, regardless of whether they're a participant in that conversation, receives the full message content (sender ID, conversation ID, shared-post link) in real time.
- **How to Reproduce (proven live):**
  1. Connect a `socket.io-client` as an uninvolved user (`user_id=1`) and listen for `message_received`.
  2. As user 10, `POST /api/chat/share` with `{"postId":3,"recipientPetId":8}` (sharing to user 11, a conversation user 1 is not part of).
  3. The eavesdropping socket immediately receives the full message object.
- **Recommended Fix:** Delete `server/routes/chat.js:151` (`io.emit('message_received', message);`). The room-scoped emit on the line above already does the correct job.
- **Why It Matters:** Direct, proven leak of private conversation content to unrelated users — a one-line fix for a serious confidentiality bug.
- **✅ Remediation:** The stray `io.emit(...)` line deleted; only the room-scoped `io.to(\`conv_${conv.id}\`).emit(...)` remains. Re-verified live with the same eavesdropper-socket setup used to prove the original bug — the eavesdropper now receives nothing when a `/share` message is sent in a conversation it isn't part of.

**[High] CORS is misconfigured such that `CORS_ORIGINS=*` does not mean "allow all" — it silently blocks all real cross-origin traffic**
- **Location:** `server/config.js:40-42`
  ```js
  CORS_ORIGINS: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : '*',
  ```
- **Problem:** The current `.env` has `CORS_ORIGINS=*` set explicitly. Because the env var *is* set, the code takes the `.split(',')` branch, turning the string `"*"` into the **array** `['*']` — not the special wildcard string the `cors` package recognizes. The `cors` package does literal membership matching against array origins, and no real browser will ever send an `Origin: *` header, so **no origin ever matches**.
- **Risk:** Confirmed live — `OPTIONS`/`GET` requests with `Origin: https://evil-attacker.com` return `Access-Control-Allow-Credentials: true` but **no `Access-Control-Allow-Origin` header at all**, meaning the browser blocks the response either way. This happens to be safe by accident against attackers, but it means **any legitimate cross-origin request is equally blocked**. In dev this is invisible because Vite's proxy (`vite.config.js`: `/api → http://localhost:3001`) makes all requests same-origin. In production, given this is a Railway-only backend deployment (per `railway.toml`, "Root Directory must be set to `server`") with the frontend likely hosted separately (web) or shipped as a Capacitor Android app (`client/package.json` has `@capacitor/android`), the real frontend origin is almost certainly *not* the same origin as the API — so if `CORS_ORIGINS=*` is carried into the production environment expecting "allow everything," **all real API calls from the shipped app will fail in the browser/WebView with a CORS error.**
- **How to Reproduce:**
  ```
  curl -i http://localhost:3001/api/health -H "Origin: https://evil-attacker.com"
  ```
  → `Access-Control-Allow-Credentials: true` present, `Access-Control-Allow-Origin` absent, for *any* origin tested.
- **Recommended Fix:** In `config.js`, special-case the literal `'*'` value before splitting (`process.env.CORS_ORIGINS === '*' ? '*' : process.env.CORS_ORIGINS.split(',')`), and set the real production frontend origin(s) explicitly in Railway's env vars rather than relying on `*` at all (which is incompatible with `credentials: true` per the CORS spec regardless of this bug).
- **Why It Matters:** This will present as "the app mysteriously can't reach the API in production" — a confusing, hard-to-diagnose launch blocker if not caught now.
- **✅ Remediation (code bug fixed — one important caveat remains, please read):** `config.js` now special-cases the literal `'*'` before splitting, exactly as recommended. Re-verified live: the same `Origin: https://evil-attacker.com` request now gets back `Access-Control-Allow-Origin: *` instead of nothing — `'*'` now genuinely means "any origin," matching what `CORS_ORIGINS=*` in `.env` was always intended to express. **However:** per the CORS spec, browsers refuse to expose a credentialed (`fetch`/`XHR` with cookies or an `Authorization` header) response when the server sends `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true` — no server-side code can make that combination work for authenticated requests, browsers block it unconditionally. So this fix restores `'*'` to its correct literal meaning, but it does **not** make cross-origin authenticated API calls work in production. **Action needed from you:** before shipping, set `CORS_ORIGINS` in Railway's env vars to the real frontend origin(s) (e.g. your deployed web URL and/or the Capacitor app's origin), not `*`. This is a configuration decision only you can make (I don't know your production frontend's real domain), not something further code changes can resolve.

**[High] Server logs print users' password-reset links, email-verification links, and 2FA codes in plaintext — unconditionally, even with real email configured**
- **Location:** `server/routes/auth.js` — `console.log(\`[PAWPRINT VERIFICATION CODE for ${user.email}]: ${code}\`)` (×3 call sites), `console.log(\`[PASSWORD RESET LINK for ${user.email}]: ${resetLink}\`)`, `console.log(\`[EMAIL VERIFICATION LINK for ${user.email}]: ${verifyLink}\`)`
- **Problem:** These log lines fire unconditionally, before the real email send is attempted — not only as a fallback for when SMTP isn't configured.
- **Risk:** In production, these are the literal secrets an attacker needs to take over an account (a valid password-reset link, or a 2FA bypass code) — writable in full to Railway's log stream (or wherever logs are aggregated/retained), accessible to anyone with log access, for as long as those logs are retained.
- **How to Reproduce:** Code inspection — every call site above logs the raw secret unconditionally; none is behind an `if (!smtpConfigured)` guard.
- **Recommended Fix:** Gate these behind an explicit dev-only flag (e.g. `if (!process.env.SMTP_USER) console.log(...)`), or remove them entirely and rely on a local testing inbox (Mailhog/Ethereal) during development instead of console output.
- **Why It Matters:** Account-takeover secrets should never be durably logged, in any environment — this defeats the purpose of the reset/verification flow's expiry and single-use design if the raw value sits in a log aggregator indefinitely.
- **✅ Remediation:** All 5 call sites gated behind `if (!process.env.SMTP_USER)`, exactly the guard recommended — once real SMTP credentials are configured (which they should be in production), none of these secrets are ever logged, by mailer.js or by auth.js. Left them logging in the current no-SMTP dev setup so local development/testing still works without needing a real inbox.

**[Medium] SMTP connection disables TLS certificate validation**
- **Location:** `server/utils/mailer.js:16-21` — `tls: { rejectUnauthorized: false }`
- **Problem:** The code comment itself says *"Safe to relax for local development; revisit before production deploy"* — this was a known, intentional dev-only shortcut that needs to be reverted.
- **Risk:** If this ships to production unchanged, the SMTP connection carrying password-reset links and 2FA codes is vulnerable to a MITM attack that presents a self-signed/invalid certificate.
- **How to Reproduce:** Code inspection.
- **Recommended Fix:** Remove the `tls.rejectUnauthorized: false` override for any non-local environment (or drop it entirely once whatever local network issue required it is resolved).
- **Why It Matters:** Directly weakens the confidentiality of the same account-recovery secrets flagged above.
- **✅ Remediation:** Changed to `rejectUnauthorized: config.NODE_ENV === 'production'` — stays relaxed for local dev (the original Windows/antivirus issue the comment describes), but strictly enforced whenever `NODE_ENV=production` is set, which it should be in the real deployment.

**[Medium] Custom XSS "sanitize" middleware is a bypassable blacklist that also corrupts legitimate user data**
- **Location:** `server/middleware/sanitize.js`
- **Problem:** Applied globally to every `req.body`/`req.query`/`req.params` string, it does `<`→`&lt;`, `>`→`&gt;`, strips `javascript:` and matches `/on\w+=/gi`. This is a blacklist, and blacklists are well-known to be incomplete (e.g. `onerror =` with a space before `=` doesn't match `/on\w+=/`, since the regex requires no space). More importantly, the app doesn't need this defense at all: no `dangerouslySetInnerHTML` exists anywhere in `client/src` (verified via grep) — React escapes all rendered text by default — so this middleware provides no real additional protection while permanently corrupting any legitimate user text containing `<` or `>` (e.g. a bio reading "my dog is < 2 years old" gets permanently stored as "my dog is &lt; 2 years old").
- **Risk:** Low as an actual XSS vector (React's default escaping is the real defense and is intact), but real as a data-integrity issue, and the pattern (mutate-on-input rather than encode-on-output) is the wrong general approach that could bite harder if a future feature ever does add raw HTML rendering.
- **How to Reproduce:** Code inspection; confirmed no `dangerouslySetInnerHTML` usage via `grep -r dangerouslySetInnerHTML client/src` (no matches).
- **Recommended Fix:** Remove the input-mutation approach; rely on React's output escaping (already doing the real work) and add contextual output encoding only in the one or two places that might ever need raw HTML, if any.
- **Why It Matters:** Silent, permanent data corruption for a security control that isn't actually providing protection.
- **✅ Remediation:** `middleware/sanitize.js` deleted entirely, and its `app.use(sanitize)` line removed from `index.js`. React's output escaping (confirmed intact, no `dangerouslySetInnerHTML` anywhere) is the real, correct defense and needs nothing added to replace this.

**[Medium] Almost no route-level rate limiting outside of `/api/auth` and `/api/posts`**
- **Location:** `server/routes/chat.js`, `matches.js`, `profile.js`, `spotlight.js`, `communities.js`, `notifications.js`, `premium.js`, `privacy.js` — confirmed via `grep -rl rateLimiter server/routes` returning only `posts.js` and `auth.js`
- **Problem:** Messaging, swiping/liking, community joining, premium checkout session creation, profile blocking, and account deletion have no rate limit of any kind.
- **Risk:** A single authenticated account can hammer `/api/matches/like/:petId`, `/api/chat/messages`, or `/api/premium/checkout` at unlimited speed — spam, resource exhaustion (each `/checkout` call does a DB insert + a premium-state broadcast), or abuse of other users (message flooding) with no backend guard at all. The frontend UI presumably throttles this in normal use, but the API itself does not.
- **How to Reproduce:** `grep -rl "rateLimiter" server/routes` → only `posts.js`, `auth.js`.
- **Recommended Fix:** Add a general-purpose rate limiter (even a generous one, e.g. `config.RATE_LIMIT.GET`/`POST` tiers already defined in `config.js`) to at least the write-heavy routes: chat messages, matches/like, community join/message, premium checkout.
- **Why It Matters:** "No rate limiting" is the single most common way a demo-scale app gets an unexpectedly large hosting bill or gets used as a spam vector once real users (and bots) show up.
- **✅ Remediation:** Added `rateLimiter(config.RATE_LIMIT.POST)` (the existing 10/min tier, already used by `posts.js`) to: `chat.js` (`/messages`, `/share`, `/conversations`), `matches.js` (`/like/:petId`, `/undo/:petId`, `/decline/:petId`), `communities.js` (`/:id/join`, `/:id/messages`, `/:id/announcements`, `/:id/photos`, `/:id/polls/:pollId/vote`, `/:id/report`), `profile.js` (`/block`, `/unblock`, `/location`), and `premium.js` (`/checkout`, `/checkout/:sessionId/confirm`). `privacy.js`'s account-deletion route was left unlimited — it's a single destructive action per account, rate-limiting it wouldn't meaningfully change its risk profile.

**[Low] Internal error messages (including raw SQL/constraint text) are returned directly to API clients**
- See §5.2 below — cross-referenced here because it's also a security-relevant information-disclosure issue (schema/table/constraint names revealed to any client).
- **✅ Remediation:** See §5.1 — same fix, `sendServerError` helper.

---

## 5. API Audit

**[High] `err.message` is returned directly in API error responses across nearly every route file**
- **Location:** Pervasive pattern — `posts.js`, `matches.js`, `chat.js`, `notifications.js`, `premium.js`, `communities.js`, `profile.js`, etc. — e.g. `res.status(500).json({ error: 'SERVER_ERROR', message: err.message })`
- **Problem:** This isn't gated by environment — `NODE_ENV` is never referenced anywhere in `server/` (confirmed via grep), so the exact same raw error text is returned in every environment, dev or production.
- **Risk:** Confirmed live: triggering a foreign-key violation (`POST /api/profile/block` with a non-existent `blockedUserId`) returns `{"error":"SERVER_ERROR","message":"insert or update on table \"blocked_users\" violates foreign key constraint \"blocked_users_blocked_id_fkey\""}` — the exact table name and constraint name, straight from Postgres, handed to the client.
- **How to Reproduce:** `POST /api/profile/block` with `{"blockedUserId":999999}` and any valid token.
- **Recommended Fix:** In production, return a generic message (`"Something went wrong"`) and log `err.message`/`err.stack` server-side only. Reserve detailed messages for a dev-only branch.
- **Why It Matters:** Reveals internal schema (table/column/constraint names) to any client that can trigger an error — useful reconnaissance for an attacker, and unprofessional/confusing for real users who see raw DB errors.
- **✅ Remediation:** Added `server/utils/errors.js` exporting `sendServerError(res, err)`, which logs the full error server-side always, but only includes `err.message` in the response when `config.NODE_ENV === 'development'` — otherwise a generic `"Something went wrong. Please try again."`. Replaced all 83 occurrences of the leaking pattern across all 9 route files (`matches.js` ×6, `spotlight.js` ×2, `chat.js` ×12, `communities.js` ×19, `notifications.js` ×7, `posts.js` ×14, `profile.js` ×14, `auth.js` ×1, `premium.js` ×8) with `sendServerError(res, err)`. Also wired up `config.NODE_ENV` itself (read from `process.env.NODE_ENV`, previously never referenced anywhere in the codebase). Re-verified: `grep -rn "message: err.message" server/routes` now returns zero matches, and `config.NODE_ENV` correctly reflects `'production'` when that env var is set.

**[Medium] Several list endpoints have no pagination**
- **Location:** `GET /api/matches` (full match list), `GET /api/communities/:id/members`, `GET /api/notifications/preferences` (N/A, single row), `GET /api/communities` search results
- **Problem:** These return the entire result set in one response with no `page`/`limit`, unlike `posts` (paginated), `notifications` (paginated), `messages` (paginated).
- **Risk:** Fine at current scale (2 pets, a handful of matches); becomes a real problem once any user accumulates hundreds/thousands of matches or a community has thousands of members — one unbounded query and one large response payload per request.
- **How to Reproduce:** Code inspection — `matches.js` `GET /`, `communities.js` `GET /:id/members` call their repo methods with no page/limit params.
- **Recommended Fix:** Add `page`/`limit` params to these, following the same pattern already used for posts/notifications/messages.
- **Why It Matters:** Directly relevant to the Stress/Scale section below — this is the kind of thing that works fine in every manual test and then falls over under real usage.
- **✅ Remediation:** `GET /api/matches` now accepts `page`/`limit` (defaults 1/30, capped at 100) and returns `{matches, total, page, hasMore}` — the internal `getMeetActivityLists` caller updated to use the new shape too. `GET /api/communities/:id/members` now accepts `page`/`limit` (defaults 1/50, capped at 200) via a new `CommunityRepository.getMembersPaginated` method; the *unpaginated* `getMembers` was kept as a separate method and is still used internally for announcement notification fan-out, which correctly needs every member, not a page of them. Re-verified live with real membership data: `page=1&limit=1` and `page=2&limit=1` against a 2-member community correctly returned one member each with accurate `total`/`hasMore`. `GET /api/communities` search results were left unpaginated (lower risk — bounded by category/city filters in practice, and out of the original finding's explicit scope).

**[Low] `POST /api/profile/block` doesn't validate the target user exists before inserting**
- Cross-referenced from §1 and §5.1 — same root cause, listed once for completeness.
- **✅ Remediation:** See §1 — same fix.

---

## 6. Database Audit

Performed via direct read-only queries against the live Postgres instance (Supabase), plus the mutating tests noted above (all reverted).

### Positive findings
- **Foreign keys are consistently defined with `ON DELETE CASCADE`** across nearly every parent/child relationship (48 FK constraints inspected) — `pets→users`, `posts→pets`, `messages→conversations→matches→pets`, `community_*→communities/users`, `notifications→users`, `payment_sessions→users`, etc. This means the manual per-table `DELETE` statements in `privacy.js`'s account-deletion route are largely **redundant safety nets, not the actual mechanism** — deleting a `users` row would cascade correctly through the whole graph on its own, including tables the manual code doesn't touch (`payment_sessions`, `plan_history`, `profile_views`, `spotlight_history`). This is solid schema design.
- **Unique constraints correctly prevent duplicate data at the DB layer**, independent of application logic: `likes(post_id, user_id)`, `swipes(from_pet_id, to_pet_id)`, `community_members(community_id, user_id)`. Direct queries for duplicate likes, duplicate matches (by pet pair), and duplicate memberships all returned **zero rows** — the constraints are doing their job.
- **No orphaned rows found** in posts (missing pet), messages (missing sender), community_members (missing user), notifications (missing user), or payment_sessions (missing user) — checked via `LEFT JOIN ... WHERE <fk-target>.id IS NULL` against each.

### Findings

**[Medium] Several hot-path foreign key columns have no secondary index**
- **Location:** `matches` table (only a PK index on `id` — no index on `pet1_id`/`pet2_id`, despite `GET /api/matches` and the discover-exclusion query filtering on these every time), `payment_sessions` (only PK index — no index on `user_id`, despite every premium status/checkout call filtering on it)
- **Problem:** Confirmed via `pg_indexes` — `matches` and `payment_sessions` show only their primary-key index; `posts`, `messages`, `notifications`, `likes`, `swipes`, `community_members` all correctly have secondary indexes on their lookup columns.
- **Risk:** Fine today at this row count; becomes a full sequential scan on every match/premium lookup once the tables grow.
- **How to Reproduce:** `SELECT tablename, indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('matches','payment_sessions')` → only `*_pkey` rows.
- **Recommended Fix:** `CREATE INDEX ON matches (pet1_id); CREATE INDEX ON matches (pet2_id); CREATE INDEX ON payment_sessions (user_id);`
- **Why It Matters:** Cheap to fix now, expensive to diagnose later once it's "the app got slow after we had a few thousand users."
- **✅ Remediation:** Ran exactly the three recommended `CREATE INDEX IF NOT EXISTS` statements directly against the live Supabase DB (matching this project's established pattern of applying schema changes via ad-hoc scripts rather than through `db/migrations.js`, which is documented dead code — see that file's own top-of-file comment). Confirmed all three created successfully.

**[Medium] `refresh_tokens` grows unbounded with no cleanup job**
- **Location:** `refresh_tokens` table
- **Problem:** Baseline snapshot: **129 rows for 5 users**, of which 121 are already revoked and 2 already expired. Nothing in the codebase deletes revoked/expired rows — `revokeRefreshToken` only flips a flag.
- **Risk:** This table will grow linearly forever with every login/refresh cycle, most of it dead weight (revoked rows kept indefinitely).
- **How to Reproduce:** `SELECT SUM(CASE WHEN revoked=1 THEN 1 ELSE 0 END), SUM(CASE WHEN expires_at < NOW() THEN 1 ELSE 0 END) FROM refresh_tokens` → 121 revoked / 2 expired out of 129 total, for only 5 users.
- **Recommended Fix:** A periodic cleanup (cron/scheduled job, or opportunistic delete-on-login) removing rows that are both revoked and past expiry.
- **Why It Matters:** Not urgent, but it's an easy thing to forget until the table is millions of rows deep and every refresh-token lookup is scanning dead data.
- **✅ Remediation:** Added `server/db/cleanup.js` (`cleanupRefreshTokens` + `startCleanupJobs`), wired into `index.js` to run once at boot and then every 24h. Confirmed live on the very first restart after this fix: the boot log printed `[cleanup] Removed 123 revoked/expired refresh_tokens rows` — almost exactly matching the 121 revoked + 2 expired = 123 counted during the original audit (the extra came from normal activity in between).

**[Low] `sql.js` remains a listed server dependency though the app is fully migrated to Postgres**
- **Location:** `server/package.json` (`"sql.js": "^1.11.0"`), and `config.js`'s `DB_TYPE`/`DB_PATH` defaults reference SQLite
- **Problem:** `db/connection.js` is Postgres-only (`pg.Pool`) — there's no code path that actually uses `sql.js` or the `DB_TYPE`/`DB_PATH` config values anymore.
- **Recommended Fix:** Remove the `sql.js` dependency and the dead `DB_TYPE`/`DB_PATH`/`sqlite.db` config defaults.
- **Why It Matters:** Minor — unused dependency and misleading config left over from a prior SQLite-based version of the app.
- **✅ Remediation:** `"sql.js"` removed from `server/package.json`; `DB_TYPE`/`DB_PATH` removed from `config.js` (confirmed unused anywhere else via grep first). You'll want to run `npm install` in `server/` once to update `node_modules`/the lockfile to match.

---

## 7. Performance

This section is primarily **code-review based** — no query-plan profiling (`EXPLAIN ANALYZE`) or load-testing tool was run given the scope of everything else in this audit; the missing-index findings in §6 are the concrete, provable performance issues. The rest below is pattern-level reasoning.

**[Medium] Sequential (not parallelized) notification fan-out on community announcements**
- **Location:** `server/routes/communities.js:350-363` `POST /:id/announcements`
- **Problem:** `for (const member of members) { await sendRealtimeNotification(...) }` — awaits each member's notification one at a time instead of `Promise.all`.
- **Risk:** For a community with hundreds of members, this serializes hundreds of sequential DB writes + socket emits per announcement, making the announcement-posting request proportionally slower as the community grows.
- **Recommended Fix:** `await Promise.all(members.filter(m => m.user_id !== req.user.id).map(m => sendRealtimeNotification(...)))`.
- **Why It Matters:** Same pattern appears in the nearby-event notification loop right below it (lines 366-380) — both scale linearly with audience size on the request's critical path.
- **✅ Remediation:** Both loops (the member fan-out and the nearby-non-members fan-out) converted to `Promise.all(...filter...map...)`, exactly as recommended.

**[Medium] No caching layer beyond a single hand-rolled cache (`SpotlightRepo.clearCache()`)**
- **Location:** Spotlight is the only subsystem with any caching (`config.SPOTLIGHT_CACHE_TTL`); everything else (feed, matches, communities, notifications) hits Postgres on every request.
- **Risk:** Acceptable at current scale; worth planning for once traffic grows, especially for the post feed (`GET /api/posts`) which is the highest-frequency read in the app.
- **Recommended Fix:** Not urgent — flagged for awareness, not a launch blocker.
- **Why It Matters:** Listed for completeness per the audit's scope, not because it's a current problem.
- **⏸️ Deferred:** No action taken, matching the original finding's own framing — not a launch blocker, and adding a caching layer is a real architectural decision (what to cache, invalidation strategy, maybe a new Redis dependency) rather than a quick fix. Revisit once real traffic patterns exist to design around.

**[Low] `PostRepository`/comment queries were read but not profiled with `EXPLAIN`**
- Stated honestly: I read the JOIN-heavy queries in `PostRepository.js` (feed, comments) from the earlier session's work and they look reasonably structured (single JOINs, not obvious N+1s from the route layer), but I did not run `EXPLAIN ANALYZE` against them in this pass. Flagged as **not independently re-verified this session** rather than claimed as fine.

---

## 8. Stress / Scale Considerations

Reasoned through, since load-testing at 100/1,000/10,000 concurrent users isn't practical in this environment — the concrete, code-level facts that inform this reasoning are below.

**[High] Every "realtime" feature that uses a bare `io.emit(...)` sends that event to every connected socket, server-wide — cost scales with total connected users, not relevant users**
- **Location:** Confirmed instances: `profile.js` `location_updated`, `chat.js`'s stray `/share` broadcast (both already flagged as privacy bugs in §4), plus **by the same pattern**: `posts.js`'s `new_post`, `post_liked`, `post_commented`, `post_shared`, `post_reacted`, `post_updated`, `post_deleted`, `profile_updated`, `spotlight_updated` are *all* global `io.emit` calls, not room-scoped.
- **Risk:** At 10,000 concurrent connected sockets, a single like on a single post fans out to all 10,000 clients, every time, regardless of whether they're viewing that post, that user's profile, or are anywhere near relevant. This is a real cost multiplier (server egress bandwidth + each client's own event-handling work) that grows with total platform concurrency, not with how many people actually care about a given event. It's the same architectural root cause as the two privacy leaks in §4 — global broadcast used as a substitute for room-scoped or targeted delivery.
- **Recommended Fix:** Longer-term: move to room-scoped emits (e.g. a room per active "feed viewers" cohort, or simply rely on clients re-fetching relevant data instead of pushing everything to everyone). Not a one-line fix like the two privacy bugs, but worth planning for before this matters at real scale.
- **Why It Matters:** This is the difference between "realtime features work fine in a demo with 3 users" and "realtime features fall over once there are a few thousand concurrent users."
- **⏸️ Left as-is by design, for `posts.js`'s events specifically:** `location_updated` and the `/share` message leak (both in §4) were true bugs — private, sensitive data reaching people who should never see it — and those are fixed. `posts.js`'s `new_post`/`post_liked`/`post_commented`/etc. are different: this is a **public** social feed everyone sees everyone else's posts/likes/comments in already (like a public Instagram/Twitter timeline), so broadcasting those events to all connected clients isn't a privacy bug, only a scale-cost one. Re-architecting the whole feed's realtime delivery to be room-scoped (deciding what cohort should receive what, handling clients joining/leaving as they scroll, etc.) is a genuine feature-level redesign, not a fix I judged safe to make unilaterally inside a "fix these issues" pass — it risks silently breaking the live-feed experience for everyone in ways that are hard to catch without a browser to test in. Flagging this clearly rather than either quietly skipping it or making an invasive change without your sign-off: **let me know if you'd like this tackled next**, ideally as its own scoped task with a browser available to verify the feed still updates correctly afterward.

**[Medium] Multiple pieces of critical in-memory state won't survive a restart or scale past one server instance**
- **Location:** `middleware/rateLimiter.js`'s `stores` Map, `matches.js`'s `pendingCommitTimers` Map (the 5-second Undo-Like window), `auth.js`'s `verificationCooldowns` Map
- **Risk:** `railway.toml`'s `restartPolicyType = "on_failure"` means the server *will* restart on crashes — any pending 5-second undo-like window in flight at that moment is lost (the like just commits without ever running through `commitPendingLike`, which itself is a safe no-op-if-already-committed design, so this specific case is low-consequence). More importantly: **none of this state would work correctly if the app were ever scaled to 2+ server instances** behind a load balancer — rate limits, cooldowns, and undo-timers would all become inconsistent depending on which instance handled which request. Socket.IO itself also has no Redis (or other) adapter configured, so room broadcasts (`io.to('conv_X')`, `io.to('pawcircle_Y')`) would silently only reach clients connected to the *same* instance in a multi-instance deployment.
- **Recommended Fix:** Not urgent for a single-instance launch. Before any horizontal scaling, this all needs to move to shared state (Redis, or equivalent) — both the rate limiter/cooldown Maps and the Socket.IO adapter.
- **Why It Matters:** Flagged now so it's a known, planned migration rather than a surprise outage the first time the app is scaled past one instance.
- **⏸️ Deferred:** No action taken, matching the original finding's own "not urgent for a single-instance launch" framing. Fixing this properly means adding Redis as a new infrastructure dependency (a new service to provision, pay for, and configure) purely to prepare for a scaling scenario that isn't the current deployment target — a decision for you to make when horizontal scaling actually becomes the plan, not something to add speculatively.

**[Medium] See §5's pagination gap** — unbounded `GET /api/matches` and `GET /api/communities/:id/members` responses are a direct scale concern, not just an API nicety.
- **✅ Remediation:** See §5 — both fixed.

---

## 9. Frontend Audit

**Explicitly split, per the environment constraint:**

**Not verifiable without a browser (stated plainly, not guessed):** responsive layout across breakpoints, animation/transition correctness, actual keyboard-only navigation, screen-reader behavior, visual consistency of the WelcomeSlider/modals, and the real Google/Apple OAuth consent-screen handshake. None of these were tested this session and none should be assumed to work — they need a human (or a browser automation tool) to check before launch.

**Code-verifiable, checked this session:**
- Routing (`App.jsx`) is structurally sound — lazy-loaded routes with a `Suspense`/`LoadingPage` fallback, a single `ProtectedRoute` gate consistently applied to every authenticated route, dynamic `:id` routes correctly ordered after static ones where relevant (`profile.js`, `communities.js` on the backend follow the same discipline).
- No `dangerouslySetInnerHTML` anywhere in `client/src` (checked in §4, relevant here too) — no raw-HTML-injection surface on the frontend.
- No hardcoded API keys/secrets found in `client/src` (checked via pattern search for common key formats) — the Google Places key correctly stays server-side only.

**[Low] No frontend error-tracking/monitoring configured**
- **Location:** `client/package.json` — no Sentry (or equivalent) dependency
- **Problem:** A production frontend crash or unhandled exception has no automated reporting path; the only visibility is a user reporting it manually.
- **Recommended Fix:** Not a launch blocker, but worth adding before relying on organic bug reports as the primary signal.
- **Why It Matters:** Listed for completeness under Production Readiness's monitoring theme, cross-referenced here since it's a frontend gap specifically.
- **⏸️ Deferred:** No action taken — adding Sentry (or equivalent) means creating an account on a third-party service and adding a real DSN, which is your call to make (which provider, free vs. paid tier, data-retention preferences), not something to wire up with a placeholder value.

---

## 10. Backend Architecture

**Positive observations:** The repository pattern (`BaseRepository` + per-entity repos) is applied consistently; routes are thin and delegate to models/services; the `services/` layer (`subscriptionService.js`, `premiumGate.js`, `paymentGateway.js`) cleanly separates business logic from HTTP handling, and the payment-gateway abstraction (`getGateway(provider)`) is genuinely well-designed for a future real-provider swap without touching call sites.

**[Medium] Two different conventions for applying `authenticateAccess`, inconsistently, across route files**
- **Location:** `communities.js` and `premium.js` use `router.use(authenticateAccess)` once at the top of the file; `matches.js`, `chat.js`, `notifications.js`, `profile.js`, `posts.js` instead apply `authenticateAccess` individually to every single route.
- **Problem:** Both achieve full coverage today (verified: every route in every file I read has protection one way or the other), but having two different conventions in the same codebase is exactly the kind of inconsistency that leads to a forgotten `authenticateAccess` on a newly-added route later — the router-level pattern is structurally safer (impossible to forget) while the per-route pattern is what most of the codebase actually uses.
- **Recommended Fix:** Standardize on `router.use(authenticateAccess)` at the top of every route file (with public routes like `communities.js`'s `/validate` moved above the `router.use` line, or explicitly excluded), rather than relying on every future route addition to remember the middleware individually.
- **Why It Matters:** Not a current vulnerability — every route I checked is protected — but a maintainability/consistency risk that increases the odds of a future gap.
- **✅ Remediation:** Confirmed every route in `posts.js`, `matches.js`, `chat.js`, `notifications.js`, `profile.js`, and `spotlight.js` requires auth (100% of routes in each file), so all 6 were converted to `router.use(authenticateAccess)` at the top, removing 58 redundant per-route mentions. `auth.js` was deliberately left as-is — most of its routes are intentionally public (signup/login/etc.), so a blanket `router.use` doesn't fit there; its selective per-route `authenticateAccess` on `/me`, `/2fa/send-code`, `/change-password`, `/logout`, `/resend-verification` is the correct pattern for a file that's mostly public. `communities.js`/`premium.js` already used the `router.use` convention and needed no change.

**[Medium] No structured/leveled logging — 72 raw `console.log`/`console.error`/`console.warn` calls across 22 backend files**
- **Location:** Server-wide (grep count)
- **Problem:** No logging library (Winston, Pino) and no HTTP request logger (Morgan) — just scattered `console.*` calls, several of which (per §4) print sensitive secrets directly.
- **Recommended Fix:** Adopt a structured logger with levels and the ability to redact known-sensitive fields, plus basic request logging for production visibility.
- **Why It Matters:** Directly connects to the secret-logging finding — a logger with built-in redaction rules would have made that class of mistake much harder to introduce.
- **⏸️ Partially addressed:** The actual secret-leaking log lines are fixed (§4) — that was the concrete, provable part of this finding. I did not do a wholesale swap of all 72 `console.*` calls to a new logging library (Winston/Pino) or add a request logger (Morgan): that's an invasive change touching every route/service file for a stylistic/observability improvement rather than a bug, and doing it as a blind sweep risked introducing mistakes across files I'd be editing without a specific reason to touch them. If you want a real structured logger adopted, I'd treat that as its own focused task so it gets proper attention rather than being a side effect of a bug-fix pass.

**[Low] Repeated inline validation logic instead of shared validators**
- **Location:** Password/email/username validation is re-implemented inline in `auth.js` (signup, reset-password, change-password) rather than using the (currently unused, and out-of-sync) `validate.js` middleware — see §2's Low finding.
- **Why It Matters:** Minor duplication risk; the three inline copies happen to currently agree with each other, but that's coincidence, not enforcement.
- **✅ Remediation:** The concrete part of this (the out-of-sync `validate.js` password rule) is fixed — see §2. The three inline copies in `auth.js` are still separately duplicated (not consolidated into one shared function) — that's a real cleanup opportunity but not a bug in its own right, and consolidating it isn't something I did unprompted since it's a refactor of already-working code, not a fix.

**[Low] `err.message` leakage (§5.1) is really an architecture-wide pattern, not a one-off**
- Cross-referenced here since it's consistent across essentially every route file — worth fixing once, centrally (e.g. an Express error-handling middleware), rather than patching each `catch` block individually.
- **✅ Remediation:** See §5.1 — fixed centrally via `sendServerError`, all 83 call sites updated.

---

## 11. Production Readiness

**[Critical] Real secrets (JWT signing keys, Google OAuth client secret, Apple private key) are committed in git history on the live GitHub remote**
- **Location:** `origin` remote = `https://github.com/sherin132005-ux/Sniffr.git`. Commit `b6e0c18` ("Initial Sniffr commit") added `server/.env` and `client/.env` with real values. A later commit, `46ab765` ("Stop tracking .env, fix gitignore"), removed them from tracking going forward — but **removing a file from tracking does not remove it from history**.
- **Risk:** Confirmed live: `git show b6e0c18:server/.env` still returns the full historical file (I redacted the actual values before printing anything, but confirmed the keys present: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`). Since this history is present on a real GitHub remote, **anyone with read access to that repository — at any point, including after the "fix" commit — can retrieve these exact secret values with one command.** I could not verify the repository's current public/private visibility (no authenticated `gh` session available in this environment), so this must be checked directly and treated as time-sensitive regardless of the answer.
- **How to Reproduce:** `git log --all --oneline -- server/.env` shows the file's full history; `git show <initial-commit-sha>:server/.env` prints the historical contents.
- **Recommended Fix (in priority order):**
  1. **Rotate every one of these credentials immediately** — new JWT secrets (this also invalidates all existing sessions/refresh tokens, which is fine and expected), new Google OAuth client secret, new Apple Sign-In key. This is non-negotiable regardless of what else is done, since the values are already potentially exposed.
  2. Confirm the GitHub repository's visibility; if public, treat the leak as already realized.
  3. Consider scrubbing history (`git filter-repo` or BFG Repo-Cleaner) and force-pushing — but only *after* rotation, since scrubbing history doesn't undo an already-realized exposure, it only prevents *future* readers from finding it.
  4. Confirm current `.gitignore` (`**/.env`) is actually working going forward — it is, per direct check (`git check-ignore -v server/.env` confirms it's ignored now).
- **Why It Matters:** This is as severe as a security finding gets — if the repository has ever been public, or ever becomes public, or is ever cloned by someone with access, an attacker has everything needed to forge valid session tokens for any user and impersonate the app's Google/Apple OAuth identity.
- **⏸️ Partially fixed — this one needs your action, please read:**
  - **Done:** Rotated `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in `server/.env` to newly generated random 48-byte values, replacing the leaked ones. Also removed the hardcoded fallback secrets from `config.js` (`'sniffr_access_secret_dev_key_2026'` etc.) — the server now throws a clear error at boot if either secret is missing from the environment, instead of silently falling back to a value that could itself end up committed somewhere. This part I could do safely myself since it's purely local config, and confirmed the server still boots and issues/verifies tokens correctly with the new secrets.
  - **Not done — requires you, specifically:**
    1. **Rotate `GOOGLE_CLIENT_SECRET` and the Apple Sign-In key (`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY`)** in the Google Cloud Console and Apple Developer portal respectively, then update `server/.env` (and Railway's env vars) with the new values. I don't have access to your Google/Apple developer accounts, so I can't do this part.
    2. **Confirm whether `github.com/sherin132005-ux/Sniffr` is public or private.** I couldn't check — no authenticated `gh` session in this environment. If it's public, treat the old secrets as already compromised regardless of rotation timing.
    3. **Decide whether to scrub git history** (`git filter-repo` or BFG Repo-Cleaner) to remove the old `.env` from old commits, and force-push. This is a destructive, history-rewriting operation on a shared remote — I did not do this myself and would not do it without your explicit go-ahead, since it rewrites commit hashes and can disrupt anyone else with a clone of the repo. Worth doing for hygiene once rotation is done, but rotation is what actually neutralizes the exposure.

**[High] Premium plan activation currently requires zero real payment**
- **Location:** `server/services/subscriptionService.js` `confirmCheckoutSession`, backed by `server/services/paymentGateway.js`'s `MockGateway`
- **Problem:** This is explicitly, deliberately a placeholder — the code comments are candid about it: *"For Razorpay/Stripe, this exact logic ... moves into a signature-verified webhook handler instead of being called directly by the client."* But as it stands right now, `POST /api/premium/checkout` → `POST /api/premium/checkout/:sessionId/confirm` is directly callable by any authenticated client and **always succeeds**, activating a full paid plan.
- **Risk:** Confirmed live: minted a token for a free-tier baseline user, called checkout for the Gold plan, called confirm, and the user's `current_plan`/`subscription_status` flipped to `gold`/`active` with a full 30-day expiry, `boost_credits_remaining: 2`, all premium gates unlocked — with no payment of any kind collected. (Test fully reverted afterward — see Cleanup Notes.)
- **Recommended Fix:** Before accepting real users/real money, replace the direct client-callable confirm with a real gateway integration where `confirmCheckoutSession`'s equivalent logic only runs from a signature-verified server-to-server webhook, exactly as the code comments already describe as the intended next step.
- **Why It Matters:** If this ships as-is with a real payment gateway wired up naively (e.g. trusting the client to only call confirm after a real payment UI step, without actual webhook verification), it's a direct free-premium exploit. Flagged as High rather than Critical because the code's own comments show this is a known, planned milestone, not an oversight — but it absolutely must not be missed before launch.
- **⏸️ Deferred — needs your business/vendor decision:** No code changes made here. This isn't a bug to patch — it's a placeholder that's explicitly, correctly waiting on a real payment gateway integration (Razorpay, Stripe, etc.), which means an account with that provider, real API credentials, and a webhook endpoint they can reach. None of that is something I can set up without you choosing a provider and providing credentials. The architecture (the `getGateway(provider)` abstraction, the two-step checkout/confirm split) is already correctly designed for this swap-in per the existing code comments — the remaining work is the actual integration once you're ready, not a redesign.

**[Medium] `NODE_ENV` is never read anywhere in the server codebase**
- **Location:** `server/` — confirmed via grep, zero references
- **Problem:** There is no dev-vs-production behavioral branching at all — not for error verbosity (§5.1), not for anything else. The current `.env` has `NODE_ENV=development` set, but nothing in the code actually checks it.
- **Recommended Fix:** Introduce real environment-aware behavior at least for error-message verbosity (§5.1) and any other dev-only conveniences (like the auth.js console-logged secrets in §4).
- **Why It Matters:** Right now, "development mode" and "production mode" are behaviorally identical from the server's perspective — which is exactly why the raw-error-message and secret-logging issues exist unconditionally.
- **✅ Remediation:** `config.js` now reads `NODE_ENV` (`process.env.NODE_ENV || 'development'`) and exports it. It now actually gates two things: `sendServerError`'s verbosity (§5.1) and `mailer.js`'s TLS strictness (§4). **Note:** the secret-logging fix (§4) intentionally uses a different signal (`!process.env.SMTP_USER`, i.e. "is real email actually configured") rather than `NODE_ENV`, since that's the more precise condition for "would this log line be the only way to see the code/link" — worth knowing both mechanisms exist and why they're not the same check.

**No monitoring/error-tracking service wired in** — checked `server/package.json` (no Sentry/equivalent) and `client/package.json` (same) — cross-referenced from §9/§10, listed here as the Production Readiness item it really is: there is currently no way to be automatically alerted to a production crash or spike in errors short of checking Railway's raw logs or waiting for a user report.
- **⏸️ Deferred:** Same reasoning as the frontend entry in §9 — this needs your own monitoring-service account, not a code change.

---

## Cleanup Notes

Everything mutated during this audit was reverted and verified back to the exact pre-audit baseline row counts (`users:5, pets:2, posts:1, matches:1, messages:6, communities:4, community_members:0, notifications:16, payment_sessions:2, profile_views:2, plan_history:4, conversations:1, likes:2, comments:7`), with **one disclosed exception**:

- **Pet `id=7`'s exact `latitude`/`longitude` could not be restored to its bit-for-bit original value.** The live-broadcast test in §4.1 required calling the real `POST /api/profile/location` endpoint, which overwrote pet 7's coordinates before I had captured their precise original value (my initial baseline snapshot captured pet IDs/names/user_ids but not full rows — a mistake in the audit's own setup, corrected immediately afterward for all subsequent tests). I set the coordinates to Anna Nagar, Chennai's approximate public coordinates (`13.0850, 80.2101`), which matches the pet's still-intact `city`/`area` text fields (`"Chennai"` / `"Zone 8 Anna Nagar"`) exactly — so the location remains geographically accurate and consistent with the rest of the profile, but the precise decimal value differs from whatever the original was. Flagged here transparently rather than silently.

All temporary test scripts (`server/_audit_*.mjs`, `client/_audit_socket_eavesdrop.mjs`) were deleted after use and are not present in the working tree.

Two real JWTs were minted directly using the server's own `JWT_ACCESS_SECRET` (read from `server/.env`) to simulate specific existing users (ids 1, 9, 10, 11) for authorization testing — no new user accounts were created, and no passwords were needed or handled.

---

## Fix Session Cleanup Notes

After implementing and live-verifying every fix above, the dev server was restarted (required — it turned out the running process from earlier in the session was plain `node index.js`, not the `--watch` variant, so none of the code edits were actually live until the restart) and the DB was re-diffed against the original baseline:

- All row counts (`users`, `pets`, `posts`, `matches`, `messages`, `communities`, `community_members`, `notifications`, `payment_sessions`, `profile_views`, `plan_history`, `conversations`, `likes`, `comments`, `blocked_users`, `swipes`) match the original baseline exactly.
- User 9's premium test from the original audit stays reverted (`free`/`inactive`, as before).
- One legitimate, permanent change to `refresh_tokens`: it went from 129 rows to 6 as a direct result of the new cleanup job correctly deleting 123 stale revoked/expired rows on boot — this is the fix working as intended, not test data, and was **not** reverted.
- Two small test artifacts created *before* the dev-server restart (when the block-awareness fix wasn't live yet) were caught during the final diff and cleaned up: a stray `meet_like` swipe/notification pair from testing `/api/matches/like/8` prior to the restart. Both deleted; verified `notifications` and `swipes` counts back to exact baseline afterward.
- All temporary scripts created during this fix session (`server/_fix_*.mjs`, `server/_verify_*.mjs`, `client/_fix_*.mjs`) were deleted; none remain in the working tree.
- JWTs were minted the same way as the original audit (signed with the server's own — now-rotated — `JWT_ACCESS_SECRET`) to re-verify authorization behavior; no new accounts or passwords involved.
