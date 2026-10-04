---
tags: [audit, security, quality]
updated: 2026-10-04
---

# Admin Audit 2026-10

The pre-production audit of the admin system before Nick is handed the keys: the sign-in door
(`/admin/login`, the reset flow, Discord, the device grant), the admin console (dashboard, map,
meetups, news, media, import), accessibility, stability of the admin API and data layer, the
tests, and the docs. Branch `audit/admin-preprod`; one PR; merging to `main` is the release.

It closes two items the [[Backlog]] has carried since August: "Admin console and moderation
authorisation boundaries" (an auditor that never reported) and "Admin with a real session".

## Method

Part 1, discovery: five subagents with narrow charters verified a list of hypotheses gathered
from a code read, against the local dev server (`astro dev`, local D1/R2/KV) with throwaway
fixture accounts, one set per agent so no agent's lockout or reset test could sign another out.
Part 2, remediation: four file-disjoint agents fixed the ledger, each fix with a test in the
layer that can reach it, then one `test:worker` build.

Rails: `.dev.vars` had its live `DISCORD_WEBHOOK_URL` and `DISCORD_BOOTSTRAP_ADMIN_ID`
commented out and `IMPORT_TOKEN` replaced with an audit-only value for the duration (backup
restored afterwards). Production was only ever read with GET, no cookies, no credentials.
Nothing ran `import-legacy?force=1` or `import-media` locally. No build ran while the dev
server was up.

Fixtures (local D1 only, torn down at the end; names, never values): `admin:auditadmin`
(browser work), `admin:audit-lock` (lockout), `admin:audit-reset` (reset via a seeded token
row, because mail is inert locally), `admin:audit-b` (API probes), `audit:ambassador` and
`audit:member` (sessions only).

## Baseline (before any change)

| Check | Result | Time |
|---|---|---|
| `npm run typecheck` | clean | 12 s |
| `npm test` | 16 suites, all "All checks passed." | 7 s |
| `npm run test:worker` | 29 files, 1124 tests passed (vault said 900) | 57 s incl. build |

## Ledger

Severity: **blocker** (would stop Nick doing his job or lose data), **major** (a real failure
somebody will hit), **minor** (wrong but survivable), **polish**. Status: `open`,
`fixed-on-spot`, `part-2`, `wontfix` (with why), `needs-decision`.

| id | sev | area | where | what | evidence | commit seen | status |
|---|---|---|---|---|---|---|---|
| A-01 | **major** | session | `src/lib/auth/session.ts:49-54`, `middleware.ts:36` | The session cookie is set once for 14 days and never re-issued; only the D1 row slides. Every admin is signed out on day 14 regardless of activity, contradicting the "rolling window" comment | every login answers `Max-Age=1209600`; nothing else in the middleware sets a cookie | a6854ce | part-2 (P2-A) |
| A-03 | minor | gate | `middleware.ts:78` | Redirect to `/admin/login` keeps the path and drops the query, so a bounced admin loses `?status=draft` | `/admin/posts?status=draft` → `302 …next=%2Fadmin%2Fposts` | a6854ce | part-2 (P2-A, via safeNext; flip pages.test.ts:260) |
| A-04 / B-09 / E-01 | **major** (docs mislead an operator) | ops | `middleware.ts:63-79`, `config-check.ts:5-12`, `vault/Configuration.md:204`, `vault/Routes.md:88` | The documented token-only call to config-check can never work: the path is not `import-`-prefixed so the middleware answers 401 before the bearer check. An ambassador with a session gets 401+WWW-Authenticate instead of 403 | bearer only → `401 {"error":"Forbidden"}`; admin → 200; ambassador → 401 | a6854ce | needs-decision → part-2 (P2-B/P2-D) |
| A-05 / B-11 | minor | docs | `import-legacy.ts:9-10`, `vault/Importing Legacy Data.md:26` | The documented bootstrap curl (POST, bearer, no Origin, no content-type) is refused by Astro's origin check with a plain-text 403 and never reaches the route | bearer, no Origin → 403; with Origin or JSON content-type → 409 | a6854ce | part-2 (P2-D docs; P2-B test) |
| A-06 | minor | login | `admin-login.ts:312-314,448-457` | The 5th wrong password trips the lock but still answers `error=bad`; the admin only learns about the lock on the 6th try, even if that try is the right password | wrong ×5 → `bad`; next correct → `locked` | a6854ce | part-2 (P2-A) |
| A-07 | minor | login | `login.astro:165-176` | The locked message never says how long is left although `locked_until` is known; otherwise clear and kind | 1-minute lock observed; correct password while locked → `locked`; after the minute → 303, counter cleared | a6854ce | part-2 (P2-A, show the wait) |
| A-08 | minor | login | `admin-login.ts:279-286` vs `:303` | `locked` is only ever answered for identifiers that exist, so five guesses confirm an account and lock its owner out. Documented trade (the lock is the control; cap is 60 min) | unknown name ×6 → `bad`; real ×5 → `locked` | a6854ce | wontfix-by-design (recorded in Auth and Roles) |
| A-09 | minor | logout | `logout.ts:37-40`, `Admin.astro:105`, `Base.astro:487` | Sign-out is a GET link, so any site can sign an admin out with a link (SameSite=Lax rides along). Nuisance, not takeover | cross-site top-level GET with cookie → 302, Max-Age=0, row deleted | a6854ce | part-2 (P2-A: POST form button) |
| A-10 | polish | login | `login.astro:83`, `middleware.ts:70` | A credential row whose user is below ambassador signs in and is bounced straight back to a blank form with no message. Only reachable by hand-written SQL | reasoned from code + pages.test.ts:148 | a6854ce | part-2 (P2-A, one clear message) |
| A-11 | polish | login | `login.astro` headers | `/admin/login` sends no `Cache-Control: no-store`; no page sends frame protection | `curl -I` | a6854ce | part-2 (P2-A) |
| A-12 | polish | docs | `login.astro:57-75`, `vault/Auth and Roles.md:638` | "No JavaScript on this page" is not true as served: Base.astro adds three inline scripts and a module. The form still posts without JS, so the break-glass promise holds; the "password never touches app code" claim does not | 3 inline scripts observed | a6854ce | part-2 (P2-A: correct the comment) |
| A-13 / C-01 / C-02 | polish | login | `login.astro:202-211` | After a wrong password the username box is empty and focus lands on `<body>`; the admin retypes both fields | observed in browser | a6854ce | part-2 (P2-A) |
| A-14 | polish | auth | `auth/error.astro:7,51` | `?reason=` text is rendered (escaped) after "Discord reported:", allowing content spoofing | `<b>` rendered as text | a6854ce | part-2 (P2-A: allowlist of reasons) |
| A-16..A-20 | — | gate, redirects, cookies, timing, reset | `admin-path.ts`, `next.ts`, `session.ts`, `confirm.ts` | All gate near-misses hold; `safeNext` refuses every payload tried; cookie flags as designed; no usable timing gap; the reset flow does exactly what the vault says (names the account, single-use, kills sessions, clears the lock) | workstream A | a6854ce | verified OK |
| B-01 | **major** | stability | `admin/meetups/[id].ts:43-54`, `index.astro:219` | A PATCH that sends only `tz` skips zone validation and stores it; if that meetup is next-up the public home page returns 500 | PATCH `{"tz":"Bad/Zone"}` → 200; `GET /` → **500** `Invalid time zone specified`; POST with bad tz → 422 | a6854ce | part-2 (P2-B: validate tz everywhere; tolerant page; test) |
| B-02 / E-02 | **major** (stored XSS from an ambassador account) | security | `admin/meetups/index.ts:32`, `index.astro:185,687`, `events.astro:207,260`, `EventCard.astro:232,348` | `campfireUrl` accepts any scheme; a `javascript:` value is rendered as the RSVP button href on `/` and `/events` | POST/PATCH `javascript:alert(1)` → 201/200; published HTML carries the href | a6854ce | part-2 (P2-B: http(s) refine + test) |
| B-03 | **major** | security | `admin/media.ts:121` vs `media/[id].ts:87-97`, `MapView.tsx:301,875` | Upload stores `sourceUrl` unchecked while PATCH requires http(s); the value is public in `/api/map.json` and becomes an href on the map | upload with `sourceUrl=javascript:alert(1)` → 201 | a6854ce | part-2 (P2-B: reuse the PATCH rule) |
| B-04 | minor (latent) | media | `media/[id].ts:44,87`, `MediaLibrary.tsx:113-121,257` | PATCH validates the merged `source_url`, so a row with a bad stored URL cannot have any field edited; `kind` allows only photo/community_photo while the DB allows doc/import and the island always sends kind, so a doc/import row could never be saved. No such rows exist locally | alt-only PATCH on a bad-URL row → 400; `{"kind":"import"}` → 422 | a6854ce | part-2 (P2-B enum + P2-C) |
| B-05 | minor | API | `pois/index.ts:72`, `posts/[id].ts:57`, `meetups/index.ts:81`, `pois/[id].ts:80`, `meetups/[id].ts:78` | A bad foreign key (zoneId, heroMediaId, poiId) is an unhandled 500 instead of a 422. Body does not leak internals | each → `500 {"error":"Internal error"}`; dev log: `FOREIGN KEY constraint failed` | a6854ce | part-2 (P2-B) |
| B-06 | **major** | data | `admin/media.ts:138-156` | Upload with a bad `poiId` returns 500 but leaves the media row and the R2 object behind, writes no audit row, and a retry creates a duplicate | media count 73→74, orphan served 200 | a6854ce | part-2 (P2-B) |
| B-07 | minor | upload | `admin/media.ts:83-86`, `media/[...key].ts:112-118` | Magic bytes are not compared with the declared type; WebP/AVIF skip the check; `/media` sends no `nosniff` | GIF bytes as image/png → 201; HTML bytes as image/webp → 201 and served as image/webp | a6854ce | part-2 (P2-B) |
| B-08 | minor | upload | `admin/media.ts:68-77,117-125` | Upload text fields have no length limits and lat/lng no range check; PATCH caps alt at 500 | 100,011-char alt and lat 999 → 201 | a6854ce | part-2 (P2-B: share the PATCH schema) |
| B-10 / E-20 | minor | ops | `config-check.ts:29-42,75-90` | EXPECTED omits `RESEND_API_KEY`, `RESEND_FROM`, `DISCORD_BOT_TOKEN`; bindings omit `LIVE`; the typo detector flags the working `DISCORD_BOT_TOKEN` | `unrecognisedSimilarNames:["DISCORD_BOT_TOKEN"]` | a6854ce | part-2 (P2-B) |
| B-12 | minor | import | `import-legacy.ts:86-98`, `ImportPanel.tsx:186-196` | `force=1` deletes all meetups (and RSVPs), all POIs (reports cascade, flares unlinked), every photo media row including uploads (R2 orphaned), shapes and the zone, then re-imports from the live old site. The UI warning omits RSVPs, reports and uploads | code read only (never run) | a6854ce | part-2 — Justin's decision: remove the force path and the button (P2-B + P2-C) |
| B-13 | minor | time | `lib/time.ts:47` | An impossible date like `2026-02-30T18:00` is accepted and silently rolled to March 2 | PATCH → 200 with `startsAt 2026-03-03T00:00:00Z` | a6854ce | part-2 (P2-B) |
| B-14 | minor | schema | `0001_initial.sql:201,338` (no AUTOINCREMENT) | Row ids are reused once the highest row is deleted, so audit history mixes entities and a stale tab could PATCH the wrong row | after post 3 was deleted a new post got id 3 | a6854ce | deferred (table rebuild migration; record in Backlog) |
| B-15 | minor | audit | all mutating routes | Audit rows are correct but written after the mutation as a separate statement; posts also replace tags in a third. A failure midway leaves a mutation with no audit row | seen in B-06 | a6854ce | part-2 (P2-B: batch where D1 allows) |
| B-16 | minor | account | `account.ts:23-32`, `deletion.ts:66-117` | A standalone admin can `DELETE /api/account`: no last-admin guard, no re-auth, no audit row. Menu hides it; server does not refuse | 200, credential and sessions gone, re-login fails | a6854ce | part-2 (P2-B: refuse `admin:` identities + audit) |
| B-17 | polish | import auth | `admin-auth.ts:36` | Bearer scheme check is case-sensitive | `bearer <tok>` → 401 | a6854ce | part-2 (P2-A, backlog) |
| B-18 | polish | gate | `middleware.ts:72-75` | Anonymous callers get 401 with the body `"Forbidden"` | observed | a6854ce | part-2 (P2-A) |
| B-19 | polish | roles | admin routes | No ownership model: any ambassador edits anything | PATCH on another's post → 200 | a6854ce | wontfix-by-design (intended boundary) |
| B-20 | polish | API | `api.ts:13-18`, list routes | Admin JSON carries no `Cache-Control: private, no-store`; pois and meetups GET unbounded; posts silently capped at 200; media at 500 | headers observed; 104 POIs = 34.5 KB | a6854ce | part-2 (P2-B) |
| B-21 | — | API | `api.ts:73-79` | 422 bodies are `{error, detail:[{path,message}]}` with raw zod paths; `{}` → 200 changed:false; null clears nullable fields; bad id 400; missing 404 | observed | a6854ce | verified OK (copy improved by P2-C) |
| B-22 | minor | media | `api/admin/media*` | No media DELETE route; removing an upload needs SQL plus `wrangler r2` | — | a6854ce | deferred (record in Backlog) |
| B-23 | polish | upload | `admin/media.ts:51-60` | `formData()` buffers the whole body before the 10 MB check (11 MB → 413 in 396 ms); SVG → 415; traversal → 400/404 | observed | a6854ce | verified acceptable |
| B-24 | polish | meetups | `meetups/index.ts:33` | `recurrenceRule` accepts free text; the parser ignores junk | → 200 | a6854ce | part-2 (P2-B) |
| E-03..E-10 | minor | docs | `README.md:50-54`, `vault/Home.md:77`, `vault/Local Development.md:24,89,95,98,122,127`, `vault/Auth and Roles.md:668` | Test counts are stale everywhere: real numbers are 16 tsx suites / 688 assertions, 29 Worker files / 1124 tests, 25 API route files (22 import cloudflare:workers directly) | measured 2026-10-04 | a6854ce | part-2 (P2-D) |
| E-11 / E-12 | minor | docs | `migrations/README.md` (last para), `vault/Backlog.md:463` | "next free is 0005" / "next is 0003"; the next is `0006` | disk | a6854ce | part-2 (P2-D) |
| E-13 | minor | docs | `vault/Backlog.md:467` | "Unbounded admin queries — bounded" is wrong for meetups and pois GET | code | a6854ce | part-2 (P2-D after P2-B) |
| E-14..E-19 | minor | docs | `.dev.vars.example:15,17,24-26,31,39-41,89-93,100-103` | Public Client OFF advice contradicts the device grant; `DISCORD_GUILD_ID` defined twice (second wins); "no bot token needed" is false for Next meetup; IMPORT_TOKEN "stopgap" wording stale; invites setting the retired bootstrap secret and never mentions `set:password` | read | a6854ce | part-2 (P2-D) |
| E-21..E-24 | minor | docs | `vault/Notifications.md:8-11`, `vault/Routes.md` API table, `vault/Auth and Roles.md:34`, `vault/Backlog.md:82,166` | Notifications says push/webhook "not switched on" (they are); Routes misses `/api/account`, device start/poll, mobile, `/img/discord`, `/account/delete`; Auth says only admins hard-delete (posts/meetups hard-delete for ambassadors today); duplicate "rotate client secret" items | read | a6854ce | part-2 (P2-D) |
| E-25 | polish | tests | `admin-login.test.ts:1232-1275` | Timing guards are weak: floor `unknown >= 0.4 x wrong`, ceiling `< 250 ms` cannot catch a 10x iteration bump; low flake risk, low power | read | a6854ce | part-2 (P2-A: tighten or document) |
| E-CI-1 | minor | CI | `package.json` `check`, `.github/workflows/ci.yml` | `npm run check` is dead (`@astrojs/check` not installed) and CI runs only `tsc --noEmit`, which never type-checks `.astro` files | read | a6854ce | part-2 (P2-D) |
| E-CI-2 | polish | scripts | `scripts/test-discord-webhook.mjs` | Sends a REAL Discord embed; excluded from every chain but named `test-*` with no DANGER label | read | a6854ce | part-2 (P2-D: rename + warning) |
| C-10 | **blocker** (data loss in daily use) | map editor | `MapEditor.tsx:147-149` | Typing a change to a location, then clicking another location, throws the typed change away with no warning. The same reset fires after a photo upload, a pin drag, or saving a different location | typed "Bramlett Field EDITED", clicked Main Course Hole #8, clicked back → "Bramlett Field"; no prompt | a6854ce | part-2 (P2-C: dirty guard + confirm, keep draft across reload) |
| C-11 | major | all editors | `PostEditor.tsx`, `MeetupEditor.tsx`, `MapEditor.tsx` (`api()` error path) | When the session has expired, Save shows a red "Forbidden" toast and nothing else: no explanation, no sign-in link. The draft is at least kept | cleared cookie, submitted → `POST /api/admin/posts 401`, toast "Forbidden" | a6854ce | part-2 (P2-C: on 401 say "You were signed out" with a sign-in link carrying `next`; P2-A: 401 body "Unauthorized") |
| C-12 | major | dashboard | `index.astro:50,54` | "Awaiting review" and "Open reports" cards both link to `/admin/map`, which has no status filter and no reports screen | hrefs read in browser; both → `/admin/map` | a6854ce | part-2 — Justin's decision: hide until built (P2-C) |
| C-13 | major | all editors | `PostEditor.css:53-58`, `MeetupEditor.css:45-52`, `MapEditor.css:216-223`, `ImportPanel.css` | Success and error toasts are the same red (`rgb(200,7,28)` for "Post created", "Meetup created", "Deleted"; `--live` for errors). Colour is the only difference and it is no difference | computed styles in browser | a6854ce | part-2 (P2-C: neutral/ink success, red reserved for errors, plus an icon or word) |
| C-14 | major | map editor | `MapEditor.tsx:443-454,464-468` | Type filter chips read as "66", "16", "22" to a screen reader (no `aria-label`); the selected location in the list carries no `aria-current`/`aria-pressed` | DOM read: chip text is the count only; list buttons have no state attribute | a6854ce | part-2 (P2-C) |
| C-15 | minor | news, meetups | `PostEditor.tsx:231,248`, `MeetupEditor.tsx:149-164` | Edit, New and Create never move focus into the form; focus stays on the button (or on `<body>` after submit). On a long list the form opens off-screen above | `document.activeElement` after each action: BUTTON:Edit / BODY | a6854ce | part-2 (P2-C: focus the title field, scroll the form into view) |
| C-16 | minor | news, media | `PostEditor.css:315`, `MediaLibrary.css:81` | The post body textarea and the media search box are 14px; iOS zooms the viewport on focus. Every other admin input is 16px | `getComputedStyle` 14px on both | a6854ce | part-2 (P2-C) |
| C-17 | minor | map editor | `MapEditor.tsx:152-177` | "Add POI" creates a pending "New location" row in the database the moment the map is clicked, before any name is typed; abandoning it leaves a stray pin that shows as "Awaiting review" | map click → `POST /api/admin/pois 201`, dashboard showed 1 awaiting review | a6854ce | part-2 (P2-C: name first, or auto-discard an unnamed pending pin) |
| C-18 | minor | map editor | `MapEditor.tsx:290` | After a drag the PATCH is rounded to 7 decimals but local state keeps the unrounded value, so the lat/lng inputs can show 14+ decimals and `step` validation can refuse Save until reload | code read (drag not simulated); place path rounds correctly | a6854ce | part-2 (P2-C: store the rounded pair) |
| C-19 | minor | meetups | `MeetupEditor.tsx:289,341-343` | Intro says "This replaces editing meetup.js every week" (old-site jargon) and the time preview prints the raw zone id `America/Chicago` where the post editor says "Central" | page text | a6854ce | part-2 (P2-C copy) |
| C-20 | minor | meetups, news | `MeetupEditor.tsx:118`, `PostEditor.tsx` hero select | The location dropdown lists every POI with duplicates indistinguishable ("Boy Scouts of America" twice, "Walk Through History" ×3) and no type; the hero-image dropdown is keyed by alt text with the same problem | select options read in browser | a6854ce | part-2 (P2-C: add type/id suffix; filter archived) |
| C-21 | minor | dashboard | `index.astro:130-135`, `ImportPanel.tsx:145-162` | Recent activity shows raw codes ("update", "poi #105") and a bare UTC time with no zone; the import panel says "Safe to re-run — it upserts" beside a "Re-run import" button that elsewhere warns of total deletion, and hard-codes "104 locations and 76 photos" | page text | a6854ce | part-2 (P2-C copy; import button removed per decision) |
| C-22 | minor | media | `MediaLibrary.tsx` sheet | The sheet traps focus, Escape closes and focus returns to the tile (good), but the page behind still scrolls, and backdrop/Escape discard edits without asking | body overflow visible; Escape → closed | a6854ce | part-2 (P2-C: lock scroll; confirm if dirty) |
| C-23 | minor | ambassador | `PostEditor.tsx`, `MeetupEditor.tsx` | An ambassador sees the same editors as an admin minus the import panel, including permanent Delete on posts and meetups | ambassador cookie walk | a6854ce | changes with the archive-by-default decision (P2-B/P2-C) |
| C-24 | polish | map editor | `MapEditor.tsx:679` | The primary button reads "Saved" in a disabled state as the status indicator (≈3:1 white on washed red) | observed | a6854ce | part-2 (P2-C) |
| C-25 | polish | login | `login.astro` on `Base.astro` | The admin sign-in page wears the public header whose own "Sign in" link goes to Discord, a different door | header link href observed | a6854ce | part-2 (P2-A: hide the Discord sign-in control on this page) |
| C-26 | — | news | `PostEditor.tsx` | Failed save against a row deleted underneath keeps the draft and shows "Post not found" (persistent). Slug auto-fills from the title. Body loads separately and is editable | observed | a6854ce | verified OK |
| C-27 | — | dev only | `node_modules/.vite` | A Vite error overlay from stale SSR deps (`manifest-*.js does not exist`) covered the page and swallowed clicks; cause is the baseline build run before the dev server started (documented trap in Local Development). Not a production issue | dev server log 10:45 | a6854ce | wontfix (dev artefact) |
| C-28 | polish | news | first load | On first load the island fetched `/api/admin/posts` twice, the first answering 401 and the second 200 (React StrictMode double-mount in dev, or the request fires before cookies attach). Harmless in production but worth a look if a "Forbidden" flashes | network log | a6854ce | part-2 (P2-C: check; likely dev-only) |
| C-29 | minor | layout | `Admin.astro:423-434` | At 375px only Dashboard, Map and Meetups fit in the admin nav; News and Media are off-screen in a row that scrolls with a hidden scrollbar and no visual cue | nav `scrollWidth 389 vs clientWidth 121`; visible items: Dashboard, Map, Meetups | a6854ce | part-2 (P2-C: fade edge or wrap) |
| C-30 | — | layout | all admin pages | No horizontal overflow at 375px on dashboard, map, news, meetups or media; map keeps ~365px of height on an 812px phone with nothing selected (the "~140px" hypothesis was too pessimistic; untested with the form open); dark mode renders correctly | `scrollWidth === clientWidth` on every page | a6854ce | verified OK |
