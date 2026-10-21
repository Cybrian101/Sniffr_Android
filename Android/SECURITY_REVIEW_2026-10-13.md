# Sniffr — Security Review, 2026-10-13

**Scope:** A live, chief-security-officer-level pass over the whole app (client + server), covering authentication/session handling, authorization/IDOR, injection, XSS, secrets handling, file upload validation, rate limiting, CORS, and dependency vulnerabilities. Done alongside (and building directly on top of) the PawCircle/navigation bug-fix work from the same session — see `version1.md` and the git log for that functional work; this file covers security specifically.

**Relationship to `AUDIT_REPORT.md`:** That file is a full prior audit and stays the canonical historical record — do not merge this into it. This file is additive: it re-confirms nothing already fixed there, calls out what's still genuinely open from it, and lists what's new since. Read both; this one assumes you've seen that one.

**Method:** Static code review across both client and server, plus live verification of specific claims against an isolated local test database (not production) and a live, read-only check of today's `POST /communities` fix against your real production database. No destructive or exploit-style testing was run against production.

---

## Top line

The app's core security posture is **good and already deliberately hardened** — this is not a green-field review. `AUDIT_REPORT.md` (a prior full audit) already found and fixed the serious stuff: IDOR on notifications, unauthenticated GPS broadcast, unauthenticated shared-post broadcast, CORS wildcard-plus-credentials behavior, secret-logging. What's below is what's new, what's still open from that prior audit and needs *your* action (not code), and some dependency hygiene.

**Nothing found today required a tradeoff decision from you** — the two real findings (rate-limit gap, npm vulnerabilities) are both fixed/partially fixed already, described below.

---

## New findings (this session)

### 1. [FIXED] `communities.js` had no default rate limit — `POST /` (create circle) had none at all

Every other route file in the app (`auth.js`, `calls.js`, `notifications.js`, `spotlight.js`) applies a blanket `router.use(rateLimiter(...))` so nothing is reachable without *some* limit, falling back to stricter per-route limiters where warranted. `communities.js` never got that blanket default — it only had ad-hoc `rateLimiter(...)` added to individual `POST` routes, and `POST /` (create a new PawCircle) was missed entirely. Every `GET` in that file (list/search circles, fetch messages, members, photos, announcements, polls) was also unlimited.

**Risk:** mild DoS / resource-abuse surface — unlimited circle creation (each call does a duplicate-name check, a `generateUniqueSlug` loop that queries the DB per candidate, and two more DB round-trips), plus unlimited read traffic on every circle endpoint.

**Fix:** added `router.use(rateLimiter(config.RATE_LIMIT.GET))` as the file's default (60 req/min/IP), and `rateLimiter(config.RATE_LIMIT.POST)` (10 req/min/IP) explicitly on `POST /`, matching the pattern used everywhere else. `server/routes/communities.js`.

### 2. [FIXED] Duplicate PawCircle names — check-then-insert race, no DB-level backstop

`POST /communities`' name-uniqueness check was a `SELECT` followed by an `INSERT`, with nothing at the database level actually enforcing uniqueness. Two near-simultaneous creates (a double-tap, a client retry after a slow response that actually succeeded) could both pass the `SELECT` before either `INSERT` committed. This is how your production database ended up with two circles both named "Simba."

Verified live: fired two identical `POST /communities` requests at once against a local test instance — before the fix, both would succeed; after, exactly one does.

**Fix:**
- `server/db/sql/2026-10-13_community_name_unique.sql` — trims existing untrimmed names (production had one circle stored as `"Indies "` with a trailing space — the check trimmed before comparing but nothing trimmed before storing), renames any existing name collision (`"Simba"` → the newer one became `"Simba (2)"`), then adds a case-insensitive unique index.
- `server/routes/communities.js` — names are now trimmed before use everywhere, and the insert is wrapped to catch the `23505` unique-violation Postgres error and return the same friendly `DUPLICATE_NAME` response, closing the race at the database level (same pattern already used in `subscriptionService.js` for a different table).
- **Already run against your real production database** (you approved this live during the session) and verified by reading back every row afterward.

### 3. [NOTE — theoretical, not currently exploited] `BaseRepository`'s generic query builder

`models/BaseRepository.js`'s `findAll`, `update`, and `create` interpolate object *keys* (column names) and the `orderBy` string directly into SQL, parameterizing only *values*. That's an inherent SQL-injection shape if a caller ever passed user-controlled strings as a `where` key or as `orderBy`. I checked every call site in the codebase — **none currently does this**; `orderBy` is never passed by any caller (always the hardcoded default), and nothing passes `req.body`/`req.query` directly as `update`/`create` data (which would also be a mass-assignment risk — a client setting `is_admin` or `current_plan` directly — on top of the injection risk). Not a live bug. Worth a defensive whitelist at the `BaseRepository` layer itself at some point so this class of mistake can't be introduced later without you noticing, but not urgent.

---

## Still open from `AUDIT_REPORT.md` — needs your action, not more code

These were already found, already explained in full, and the code-side fix is already in place. What's left is a decision/action only you can make:

### 4. [YOUR ACTION] Confirm production `CORS_ORIGINS` is a real origin list, not `*`

`AUDIT_REPORT.md` §4/§11 already found and fixed the *bug* (`CORS_ORIGINS=*` was being silently turned into a literal array `['*']` that matched nothing — now correctly means "any origin"). The *residual* issue is spec-level, not a bug: a browser refuses `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true` for any authenticated request, so `*` in production means real cross-origin authenticated calls fail outright, not "allow everything."

Today's local `server/.env` (the copy on this machine, used for local dev and for the "connect to real Supabase" testing earlier this session) still has `CORS_ORIGINS=*`. **I cannot see what your actual deployed Render service has configured** — that's set independently in Render's dashboard, not from this file. Please confirm it there and set it to your real deployed frontend origin(s) (and the Capacitor app's origin, if that also calls the API directly) if it isn't already. `.env.example` already documents this correctly, so whoever deploys next will see the warning.

### 5. [YOUR ACTION — unverified, please check] Old leaked-secrets finding — is it still relevant to *this* repo?

`AUDIT_REPORT.md` §11.1 (Critical) found real `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`GOOGLE_CLIENT_SECRET`/Apple Sign-In private key committed in git history on a GitHub remote `github.com/sherin132005-ux/Sniffr`, confirmed via `git show <commit>:server/.env`. JWT secrets were rotated; Google/Apple credentials were explicitly left un-rotated (needs your developer-console access) and the repo's public/private visibility was never confirmed (no `gh` access in that session either).

I checked *this* repository's full history (all 47 commits, `git log --all`) for any committed `.env`, and for that specific referenced commit hash — **neither exists here.** This repo's remote is `github.com/sherin132005-ux/SniffrWeb` (note: different name, `SniffrWeb` not `Sniffr`), and its history starts at a commit literally titled "Initial Sniffr production source" with no earlier history. This strongly suggests this is a different/fresh repository from the one in the original finding, not the same one with history rewritten — but **I can't confirm that from here, and you should, specifically:**
- Does `github.com/sherin132005-ux/Sniffr` (the old one, no `Web`) still exist, and is it public?
- If so, were `GOOGLE_CLIENT_SECRET` / the Apple Sign-In key ever actually rotated? (The prior audit explicitly says this part was *not* done.)
- Whichever repo is the one actually deployed from, make sure its history is clean or those credentials are rotated — this is the single highest-value action item carried over from the prior audit, and it's one only you can close out.

---

## Dependency vulnerabilities (`npm audit`)

Ran on both `server/` and `client/`, applied everything `npm audit fix` could do without a breaking change, rebuilt both to confirm nothing broke.

**Server:** 10 → 3 vulnerabilities fixed automatically (safe). Remaining 3 need a deliberate, tested major-version bump — not done today, listed so you can schedule it:
| Package | Severity | Needs |
|---|---|---|
| `nodemailer` | High (DNS/TLS cross-tenant credential disclosure, DoS) | Major bump past what `^9.0.3` in `package.json` allows — test the whole email flow (verification, reset, 2FA codes) before shipping |
| `qs` (transitive, via `express`→`body-parser`) | Moderate (DoS) | Comes from Express's own dependency tree; needs an Express bump or an `overrides` entry in `package.json` |
| `sharp` | High (inherited libvips/libheif/librsvg CVEs) | `npm audit fix --force` installs `sharp@0.35.5` — breaking change; test every image-processing path (avatars, posts, community photos) before shipping |

**Client:** 13 → 2 vulnerabilities fixed automatically (safe). Remaining:
| Package | Severity | Needs |
|---|---|---|
| `react-router` / `react-router-dom` | Moderate (open-redirect via backslash in `<Link>`/`useNavigate`, arbitrary constructor injection in SSR hydration — the latter doesn't apply here, this app isn't SSR) | Major bump to v7 — a real breaking change for a v6 app (different data-router APIs); needs its own dedicated upgrade pass with full regression testing, not a drive-by fix |

None of these four are urgent/actively-exploited-looking for this app's actual usage (the SSR one flatly doesn't apply; the open-redirect needs an attacker-controlled link a user clicks, scoped to internal `<Link>`/`navigate()` calls which are all developer-authored, not user input), but they're real CVEs with fixes available and should go on the backlog rather than be ignored indefinitely.

---

## What was checked and found solid (no changes needed)

- **Auth/session** (`middleware/auth.js`): JWT algorithm pinned explicitly (no algorithm-confusion risk), purpose-scoped tokens that can't be reused across purposes, refresh-token rotation wrapped in a real transaction closing the exact same race-condition class as finding #2 above, 2FA session binding via GoTrue's `session_id` claim, every request re-checks account-deleted status straight from the table (a still-valid JWT for a deleted account stops working immediately, not at token expiry).
- **Admin authorization** (`middleware/admin.js`): every one of the 4 admin routes gated by both `authenticateAccess` and `requireAdmin`; `is_admin` deliberately kept out of the JWT payload so revoking it takes effect on the very next request instead of waiting for token expiry.
- **File upload validation** (`utils/fileSignature.js`): real magic-byte verification against the claimed MIME type for every upload path (posts, chat, avatars, community media, payment proofs) — not just trusting the client-supplied `Content-Type`, which is the common mistake this avoids. Unknown types are rejected by default.
- **XSS:** no `dangerouslySetInnerHTML`, no `eval`/`new Function` anywhere in the client. React's default JSX escaping is doing the work here and nothing bypasses it.
- **Secrets hygiene (this repo):** `.env` properly gitignored and never committed in this repo's history; no hardcoded API keys/credentials found in source.
- **IDOR spot-check:** `GET /chat/messages/:conversationId` (and the pattern it follows) explicitly verifies the requester is a participant before returning anything — not just checking the record exists.

---

## Summary table

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `communities.js` missing default rate limit; `POST /` unlimited | Medium | ✅ Fixed |
| 2 | PawCircle name uniqueness — race condition, no DB backstop | Medium | ✅ Fixed, migration run on production |
| 3 | `BaseRepository` generic query builder — theoretical injection shape | Low (no live exploit) | 📝 Noted, no live call site affected |
| 4 | Confirm production `CORS_ORIGINS` isn't `*` | Medium | ⏸️ Your action — check Render dashboard |
| 5 | Old leaked-secrets finding — confirm it doesn't apply to this repo/rotate if it does | **Critical if unresolved** | ⏸️ Your action — only you can check the old repo + rotate Google/Apple creds |
| 6 | Server npm vulnerabilities (nodemailer, qs, sharp) | 1 Moderate, 2 High (of originally 1 Critical) | ✅ 7/10 auto-fixed; 3 need a scheduled, tested major-version bump |
| 7 | Client npm vulnerabilities (react-router) | Moderate (of originally 2 Critical) | ✅ 11/13 auto-fixed; 1 needs a scheduled v7 migration |
