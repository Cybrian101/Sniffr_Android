# Version 2 — Change Log

This document records every modification made to the Sniffr codebase in this working session, grouped by feature area — same convention as `version1.md`. Covers frontend, backend, and database changes, plus manual steps applied (or still needed) on the live Supabase database.

---

## ⚠️ Manual database steps

Same situation as `version1.md` flagged: `runMigrations()` in `server/db/migrations.js` is still dead code — never invoked at server startup. Every schema change below is its own dated file in `server/db/sql/`, meant to be run by hand against Supabase (see each file's own header comment, and the updated "Database" section in `README.md`).

1. **`server/db/sql/2026-10-13_community_slug.sql`** — adds `communities.slug`, backfills every existing row, unique index. **Already run against production** during this session (verified: existing circles `352`–`356` got slugs `indies`, `simba`, `simba-354`, `husky`, `ebe`).
2. **`server/db/sql/2026-10-13_community_name_unique.sql`** — trims existing untrimmed names, renames any existing name collision, case-insensitive unique index on `communities.name`. **Already run against production** during this session (the two circles both named "Simba" — the newer one is now "Simba (2)"; "Indies " lost its trailing space).
3. For any *other* environment (a fresh Supabase project, a staging DB) these two files need to be applied by hand before deploying this session's backend code, same as every other file in `server/db/sql/`. `node server/scripts/apply-local-sql.mjs` does this automatically for local dev against the throwaway Postgres `npm run db:local` spawns.
4. Restart the server after applying either of the above, and after every backend code change in this log.

---

## 1. Back-button / navigation fixes

**Files:** `client/src/pages/AuthPage.jsx`, `client/src/hooks/useGoBack.js` (new), `client/src/pages/ProfilePage.jsx`, `client/src/pages/CreateProfilePage.jsx`, `client/src/pages/PrivacyPage.jsx`, `client/src/pages/TermsPage.jsx`, `client/src/pages/FAQPage.jsx`

- **Duplicate history entry after signup:** `AuthPage.jsx`'s `applySession()` had three branches; two used `navigate(..., { replace: true })`, the pet-less-signup branch didn't. Combined with `App.jsx`'s own `<Navigate replace>` for the same destination, a brand-new signup pushed a *second*, identical `/pet-selection` history entry — so the first press of the hardware/UI back button after signup silently did nothing (landed on the same page), and the "press back again to exit" prompt appeared one press earlier than expected. Fixed: that branch now also uses `replace: true`.
- **`navigate(-1)` on pages with no history to go back to:** ten "Go back" buttons (`ProfilePage` ×5, `CreateProfilePage` ×2, `PrivacyPage`/`TermsPage`/`FAQPage` ×1 each) called `navigate(-1)` unconditionally. A session that *starts* on one of these pages — a shared pet-profile link (`ProfilePage`'s back arrow only renders when reached by `id`, i.e. a shared link), a direct `/privacy`/`/terms`/`/faq` link from outside the app — has no prior in-app history, so the button did nothing. New `useGoBack(fallback)` hook checks `location.key === 'default'` (react-router's marker for "first entry of this session") and falls back to a sensible route instead.

## 2. Chat: "new chat" X icon never disappeared / media-only messages showed "Start chatting!" forever

**Files:** `client/src/pages/ChatPage.jsx`, `client/src/components/PawCircleTab.jsx`, `server/models/CommunityRepository.js`

- Both the 1:1 chat list and the PawCircle list decided whether a conversation/circle counted as "started" by checking `last_message` — the message's *text content*. A photo/video/voice/file sent with no caption has empty text content, so even after real chatting, `last_message` stayed falsy: the "remove empty chat" X never went away, and the preview stayed frozen on "Start chatting!"/"No messages yet" forever.
- Fixed in `ChatPage.jsx` by switching both checks to `last_message_at` (set the instant *any* message, media included, lands).
- `PawCircleTab.jsx`'s equivalent was worse — the server's community-list query (`CommunityRepository.getDetailsWithStatus`) never sent `last_message`/`last_message_at` at all, so **every** circle, regardless of activity, permanently showed "No messages yet." Added the missing fields server-side and fixed the client check the same way.

## 3. Chat: tap-to-enlarge photos/videos was dead code (1:1) / entirely missing (PawCircle)

**Files:** `client/src/components/MediaViewerModal.jsx` (new), `client/src/hooks/useMessageInteractions.js`, `client/src/pages/ChatPage.jsx`, `client/src/pages/CommunityPage.jsx`

- 1:1 chat already had a fully-built fullscreen photo/video viewer (`mediaViewer` state, prev/next, download) — but nothing ever called the function that opens it. Tapping a photo/video bubble was wired only to the reply/reaction gesture handler (`useMessageInteractions`), which does nothing for media message types — a single tap on media was a dead end. PawCircle chat had the identical dead-end tap behavior and didn't even have a viewer built.
- Extracted the viewer into a shared `MediaViewerModal.jsx`. Added an `onMediaTap` callback to `useMessageInteractions` (the shared tap/long-press/double-tap gesture logic both chats use) so a single tap on an image/video now opens the fullscreen viewer, in both 1:1 and PawCircle chat.

## 4. PawCircle: "PawCircle Unavailable" on every single open — `loadTransfer`/`loadJoinRequests` temporal-dead-zone crash

**File:** `client/src/pages/CommunityPage.jsx`

- `loadTransfer` and `loadJoinRequests` were declared as `const` *after* the component's `if (loading) return` / `if (!community) return` early returns. On the very first render — `community` still `null`, nothing fetched yet — the function body returns before ever reaching those two declarations, so *that render's* closure permanently has them in a temporal dead zone. `loadCommunityDetails` (declared earlier, so its own closure is fine) and the socket-event handlers call them from an effect built on that same early-returning render, throwing `ReferenceError: Cannot access 'loadTransfer' before initialization` on every single attempt to open any PawCircle — caught by a blanket `catch` that then wiped the community data it had just successfully fetched, surfacing as "PawCircle Unavailable / could not be found."
- Reproduced live (console error confirmed, exact repro: open list → click a circle → "PawCircle Unavailable"), fixed by moving both declarations above both early returns, re-verified the same repro now works end-to-end (list → open → send message → leave → reopen, no console errors).

## 5. PawCircle: readable URLs (`/community/claude-qa-pack` instead of `/community/312`)

**Files:** `server/db/sql/2026-10-13_community_slug.sql` (new), `server/models/CommunityRepository.js`, `server/routes/communities.js`, `client/src/pages/CommunityPage.jsx`, `client/src/components/PawCircleTab.jsx`, `client/src/pages/CreateCommunityPage.jsx`

- Added a `slug` column, generated once at creation from the circle's name (never changed afterward, so an existing link never breaks even if the circle is renamed later) and backfilled for every existing circle.
- `routes/communities.js` gained a `router.param('id', ...)` resolver: every route under this router that declares `:id` (there are ~30) now transparently accepts either the numeric id or the slug, resolved once in one place rather than touching every handler.
- `CommunityPage.jsx` now upgrades the address bar to the slug URL once it's known (`replace: true`, same pattern `ProfilePage.jsx` already uses for pet usernames), and a parallel `numericId` (derived from the loaded `community.id`) replaces ~20 `parseInt(id)` call sites that fed Socket.IO room names/event-payload comparisons — those need the *real* numeric id regardless of what's in the URL, which a slug obviously isn't. The old `cleanId = parseInt(String(id...).replace(/\D+/g,'')) || 1` hack (which silently mangled any slug into garbage and defaulted to community #1 on failure) is gone — the server resolves whichever form the client passes.
- Every client-side `navigate(`/community/${...}`)` call site (`PawCircleTab.jsx` ×5, `CreateCommunityPage.jsx`, the invite-link builder in `CommunityPage.jsx`) now prefers `comm.slug` with `comm.id` as a fallback.

## 6. PawCircle: name uniqueness — race condition closed

See **Manual database steps** above and `SECURITY_REVIEW_2026-10-13.md` finding #2 for the full writeup — `routes/communities.js`'s duplicate-name check was a `SELECT`-then-`INSERT` race with no database-level backstop, which is how production ended up with two circles both named "Simba." Closed with a case-insensitive unique index plus a caught `23505` error, verified live with a real concurrency test.

## 7. Security review

See `SECURITY_REVIEW_2026-10-13.md` in full. Short version: core auth/session/admin/upload-validation/XSS posture was already solid (built on top of the existing `AUDIT_REPORT.md` hardening pass). New: closed a rate-limiting gap in `communities.js`, applied every non-breaking `npm audit fix` to both client and server (server 10→3 vulnerabilities, client 13→2), and flagged two items from the prior audit that are still open and need the project owner's action specifically (confirming production `CORS_ORIGINS`, and confirming the old leaked-secrets finding doesn't apply to this repo).

---

## Known follow-ups / things to verify live

- Apply both `db/sql/2026-10-13_*.sql` files to any environment other than production (already applied there) before deploying this session's backend code to it.
- `SECURITY_REVIEW_2026-10-13.md` findings #4 and #5 need your direct action — not more code. Read those first.
- Three server npm vulnerabilities (`nodemailer`, `qs`, `sharp`) and one client one (`react-router`) need a deliberate, tested major-version bump — not done this session since each is a real breaking change; see the security review's dependency table.
- `client/src/components/BottomNav.jsx` / PawCircle's placement inside the Chat tab (Messages/PawCircle/Calls) was discussed but deliberately left as-is per explicit feedback mid-session — see chat history if revisiting.
