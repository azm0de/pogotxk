---
tags: [planning]
updated: 2026-08-10
---

# Backlog

Everything in the original plan is built. This is what is left, roughly by value.

## Left in the working tree on purpose

The whole design pass — repaint, logo, hero video, icons, the home page as it now stands — shipped
on 2026-08-10. These are the only things still uncommitted, and they were **left out
deliberately** because they are Justin's rather than the agent's:

- The **`.gitignore` edit** and the untracked **`.github/`**. That ignore rule is
  `.github\instructions\codacy.instructions.md` — backslashes, which gitignore does not match, so
  the file it is trying to exclude would be committed anyway. Change it to forward slashes before
  committing either
- **`public/art/go.webp`**, **`pogoeve.png`** and **`Pokemon_Go.svg.webp`** — untracked and
  referenced by no code. The last is the Pokémon GO wordmark used as the reference for generating
  our own logo; committing it would serve a trademarked logo from `/art/` for no reason

## Blocked on the owner

- [x] ~~Web push~~ — VAPID keypair generated and set 2026-08-06;
      `/api/push/subscribe` reports `enabled: true`. See [[Configuration]]
- [ ] **Test the bubble on a real phone**, ideally over Pokémon GO. See [[Android App]]
- [ ] **Rotate the Discord client secret** — it passed through a chat transcript during setup

## Blocked on Discord admin — to raise with Nick

Justin does not have admin on the community Discord. Nick is the Community Ambassador who
does. Everything here needs **Manage Webhooks** or **Server Settings** access, so it waits
for that conversation rather than being a task anyone can pick up.

This is also the real reason the guild and role IDs stalled during setup — it was never a
matter of finding the right menu.

- [ ] **`DISCORD_WEBHOOK_URL`** — needs *Manage Webhooks*. Server Settings → Integrations →
      Webhooks. Then, keeping it out of any transcript:
      `printf '%s' 'PASTE_URL' | npx wrangler secret put DISCORD_WEBHOOK_URL`.
      Only `discord.com` / `discordapp.com` hosts are accepted — see [[Notifications]].
      This is the last piece of notifications; push itself is already live
- [ ] **`DISCORD_ROLE_ADMIN` / `_AMBASSADOR` / `_MEMBER`** — needs Server Settings → Roles.
      Until these are set, nobody is promoted automatically and roles stay hand-assigned in
      the database. See [[Auth and Roles]]
- [ ] **A second admin.** Right now the site has exactly one, promoted by hand. If Nick is
      going to be an ambassador on the site as well, do it in the same sitting
- [ ] **Tell Nick his GO Fest photo is now the landing banner**, and ask whether he has a frame
      without the refuse bin in it. His photo, his byline, and the crop currently loses two
      members at the right edge — a wider or different frame would let everyone back in. See
      [[Design System]] for why the bin was not retouched out

### Nick also owns the Discord *application*, not just the server

Worth separating, because it was assumed the other way round for a while: the Developer Portal
app (client id `1534670096256073778`) and the Discord server are different systems with
different permissions. Nick holds both. Everything below is Developer Portal, so none of it
needs server admin — it needs him.

- [ ] **Ask to be added to the application's Team**, rather than asking for the two items below
      one at a time. The Developer Portal supports Teams: the owner creates one, moves the app
      into it, and adds members. After that, redirect URIs and secret rotation stop being a
      favour with a wait attached. This is the ask worth making
- [ ] **Confirm the redirect URI is registered**, exactly, no trailing slash:
      `https://pogotxk.gnomelabz.workers.dev/auth/callback`. This cannot be checked from
      outside — Discord serves the same 44KB app shell for a registered and an unregistered
      URI and only validates after sign-in. It *can* be checked in ten seconds by opening the
      sign-in link and looking: the approval screen means it is registered, "Invalid OAuth2
      redirect_uri" means it is not. Do that before raising it
- [ ] **Rotate the client secret** — it passed through a chat transcript during setup. Have him
      send the new one via a password manager share, never chat or email, then
      `printf '%s' 'NEW' | npx wrangler secret put DISCORD_CLIENT_SECRET`

> [!note] None of this blocks signing in
> `DISCORD_BOOTSTRAP_ADMIN_ID` short-circuits `resolveRole` to `admin` regardless of guild
> membership — asserted in `scripts/test-auth.ts` as "bootstrap id → admin even outside guild".
> Provided that secret holds Justin's own Discord user id, admin access does not wait on any of
> this. If sign-in lands as a guest instead, that id is the thing to check.

- [x] ~~`DISCORD_GUILD_ID` + `DISCORD_BOOTSTRAP_ADMIN_ID`~~ — set 2026-08-06. Neither needed
      admin: Developer Mode plus right-click → Copy ID. The membership check is now **on**,
      so people outside the Discord sign in as guests

> [!tip] A role id can be read without Server Settings
> Type `\@RoleName` in any channel — the backslash makes Discord send the raw form
> `<@&123456789>` instead of a mention. Only works for roles you are allowed to mention,
> but it may save waiting on the meeting.

> [!warning] Everyone in the guild is a plain `member` until the role ids land
> That is the intended interim state, not a bug. `DISCORD_BOOTSTRAP_ADMIN_ID` is the only
> thing keeping Justin an admin — see the ordering warning in [[Configuration]] before
> changing any of this.

## The calendar feeds are live but unreachable

The subscribe panel came off `/events` on 2026-08-10 by request. The consequence is worth
stating plainly, because it is invisible:

- `/calendar/meetups.ics`, `/calendar/all.ics` and `/calendar/game.ics` **still serve**.
  Anyone already subscribed keeps getting updates — a calendar client polls the URL it
  stored and never revisits the page — so nothing broke for existing subscribers
- What is gone is any way to **find** them. There is no `<link rel="alternate">`
  autodiscovery either, so the feeds are effectively unlisted
- `SubscribeCard.astro` and its CSS are still in the tree, now unimported. An unimported
  Astro component ships nothing, so it costs nothing to keep, and it is the whole widget
  back in one line if it is ever wanted

- [ ] Decide: leave them unlisted, add head autodiscovery, or delete the routes and the
      component together. Leaving it undecided is the only bad option — half a feature that
      still costs a build

## The one real Lighthouse finding left

Audited 2026-08-10, mobile and desktop, against production. Accessibility 93 → **97** and
SEO 92 → **100** are done and live. Best Practices is 100. What remains is payload, and it
is transport-independent — it does not go away at the edge:

- [ ] **One community photograph is 1.8MB.** `legacy/2025gofest.jpg` is served at full size
      into a 400×300 grid tile, and is most of the page's 4.4MB. Lighthouse puts the
      recoverable total at ~2.8MB across the photo set.
      `/media/[...key].ts` documents why resizing is not done there: Astro's Cloudflare
      image service rewrites through `/cdn-cgi/image/`, which needs the zone, so it lands
      with the custom domain. Until then the options are to generate WebP derivatives under
      new R2 keys and point the grid at those — the existing objects must stay untouched,
      they are served `immutable` for a year — or to accept it. **Not** a rewrite in place
- [ ] **`target-size` will not reach 100 and should not.** 104 pins in one small park sit
      closer than 24px apart. WCAG 2.5.8 exempts targets whose position is essential, which
      a geographic pin is; spreading them out to satisfy a checker would break the map. The
      cluster icons are already 38×38
- [ ] **Mobile LCP is ~5s** against a ~1.5s FCP, and the hero logo is the LCP element at
      102KB. Worth a look, but see [[Bugs Worth Remembering]] before reaching for
      `fetchpriority` — that has already been tried and measured, and it made it worse

## Worth doing next

- [ ] **Custom domain.** Point `pokemontxk.com` at the Worker and retire the old site, then set
      `SITE_URL=https://pokemontxk.com` in the Workers Builds environment — that one variable
      moves canonical URLs, RSS and the ICS `SOURCE` field together. The Discord redirect URI
      needs adding separately in the Developer Portal. Until then `site` deliberately names the
      `workers.dev` host, because pointing it at a domain that 404s is exactly what broke every
      subscribe link (see [[Bugs Worth Remembering]])
- [ ] **Announce posts and meetups to Discord.** `announceToDiscord` exists and has no caller —
      wire the "also announce" toggle in the post editor to it
- [x] ~~Media library page (`/admin/media`)~~ — built 2026-08-06. Browse everything in R2,
      filter by kind or by what is missing, and edit alt text, caption, credit and the
      source-attribution fields. Added `PATCH /api/admin/media/[id]`, which did not exist:
      credits were captured on upload and then frozen, so fixing one meant SQL against
      production. **63 of 72 items still have no credit** — the filter counts them
- [ ] **The "no credit" filter over-reports.** Those 63 are exactly the POI photographs, which
      are the community's own and owe no credit; all 9 community photos are credited. The filter
      reads as 63 outstanding tasks when the real number is zero. It should exempt
      `kind = 'photo'`, or say "no credit recorded" rather than implying one is missing
- [ ] **Settings page (`/admin/settings`).** Same story, but with no API either. Social links,
      hero copy, theme colours, Code of Conduct PDF. It is the only `adminOnly` nav entry the
      layout was built for
- [ ] **Community POI submissions.** `poi_reports` and the moderation queue exist in the schema;
      no UI yet
- [ ] **KMZ import in admin.** Their source of truth is Google Earth. `lib/kml.ts` was planned
      and never built — upload a KMZ, diff against the database, approve changes

## Known rough edges

- [x] ~~Unbounded admin queries~~ — bounded, and the post list no longer carries bodies
- [x] ~~`--live` contrast below AA~~ — split into `--live` and `--live-text`, both pass
- [x] ~~Live board not announced to screen readers~~ — announces a count on change
- [x] ~~`SEQUENCE` can decrease~~ — pinned for global events, still derived for meetups
- [ ] **Photo carousel** — the API and schema support multiple photos per POI; nothing uploads a
      second one yet, so the UI is unbuilt
- [ ] **`src/lib/scrapedduck.ts` cannot be unit tested.** It imports `cloudflare:workers` at
      module scope, alongside ~10 pure helpers (`raidTierRank`, `relativeTime`, `formatCp`…).
      Splitting the presentation helpers into their own module would make them testable, but it
      rewrites imports across six components — a refactor, not a fix
- [x] ~~Events page uses `Astro.site` in prod~~ — it now always builds calendar links from the
      request origin. The old behaviour shipped six subscribe links that 404'd
- [x] ~~Open redirect via `next=`~~ — `/\host` and tab-smuggled variants are blocked, the
      callback re-validates, and 21 assertions cover it
- [x] ~~Leaving the Discord kept your role~~ — `fetchGuildRoles` now distinguishes
      "not configured" from "not a member"

### From the design pass, 2026-08-06

- [x] ~~Every page scrolled sideways on a phone~~ — 169px of overhang at 375px, on all twelve
      routes, in production. One missing `min-width: 0`. See [[Bugs Worth Remembering]]
- [x] ~~The footer floated mid-page on short pages~~ — body is a flex column now
- [x] ~~`/live`, `/eggs`, `/research` unreachable from the nav~~ — `/live` has a slot; the
      other two link to each other and `/raids` through a GameNav chip row
- [x] ~~`/map` had no `<h1>`~~ — the only page without one, now `sr-only`
- [x] ~~Three links under the 24px minimum target size~~ — the home page's `→` actions
- [x] ~~Gallery captions unreadable over bright photos~~ — the scrim only reached full
      strength at its final pixel
- [x] ~~Posts skipped a heading level~~ — the offset is measured from the shallowest heading
      the author actually used, so `##`-first documents still open on `<h2>`
- [x] ~~Markdown tables rendered as literal pipes~~ — supported now, with alignment, escaped
      pipes, and cells that cannot open a tag
- [x] ~~Sixteen places where a word was glued to the next link~~ — Astro trims the trailing
      space before an element on the next line; `{' '}` survives reformatting
- [x] ~~`/events` opened on 900px of subscribe UI~~ — collapsed into a `<details>`; the first
      event moved from 927px to 386px down the page
- [x] ~~Two admin tabs led to 404s~~ — Media is built; Settings is out of the nav until it is
- [ ] **`/go` is sparse for a signed-out visitor.** The empty board is centred now rather than
      top-aligned, but the screen still says little about what the app does before you sign in

### From the visual pass, 2026-08-07

- [x] ~~Two design skills wired into `.claude/skills/`~~ — Anthropic's `frontend-design`
      (vendored, Apache 2.0) for taste, and `pogotxk-design` for our constraints. See
      [[Design System]]
- [x] ~~The 63 landmark photographs were invisible~~ — they existed only inside a map popup you
      had to tap a pin to open. Now a rail under the hero, each tile deep-linking to
      `/map?poi=<slug>`
- [x] ~~"The community" had no route onward~~ — the only section on the home page without one;
      now links to `/gallery`
- [x] ~~`.section-head` broke a link mid-phrase~~ — at 390px "All 104 on the map" wrapped and
      stranded the arrow on its own line
- [x] ~~No Pokémon artwork anywhere outside the game-data pages~~ — shiny Lucario, Mew and
      Magikarp bleed off a page edge in the hero, "Happening now" and the Campsite explainer,
      via a reusable `.art-band` utility. See [[Design System]]
- [ ] **Moltres is orphaned on `/about`.** It is the last survivor of the earlier three-teams
      bird set, which the home page no longer uses. Either give `/about` one of the current three
      or restore the birds — but it should not stay as an accident
- [ ] **Only the home page and `/about` carry artwork.** `/gallery`, `/live` and `/events` are
      the remaining candidates with room
- [x] ~~The palette was inherited navy and cream~~ — repainted red/white/black as a Poké Ball.
      The obvious Pokémon reds all fail AA on white and every red now sits at hue 353–354°;
      see [[Design System]] before touching any of it
- [x] ~~The home page opened on a headline, not on the community~~ — the GO Fest group photo is
      now the banner, art-directed for wide and narrow
- [ ] **Ask Nick for a GO Fest frame without the refuse bin.** The banner crop currently loses
      two members at the right edge because the bin could not be retouched out without inventing
      their legs — [[Design System]] has the full reasoning
- [ ] **The hero and the section headings are still system-ui at every level.** Typography is
      the largest remaining templated default on the site; a display face would change more than
      any new section. Needs self-hosting — no third-party font CDN
- [ ] **Per-page OG images.** A Discord link preview shows a placeholder rather than the park

## Audit still owed

Three of five production auditors reported before the run was stopped on 2026-08-05. Their
findings are fixed and deployed. **Two never reported** — the remaining surfaces have not had an
adversarial read:

- [ ] Admin console and moderation authorisation boundaries
- [ ] Durable Object / live board under concurrency

Worth finishing before the site is announced to the community, given that the three that did run
found a security defect apiece.

## Deliberately not doing

- **iOS Live Activity.** Needs a native app, an Apple Developer account and store review, for a
  strictly worse version of what the web app already does. See
  [[Why iOS cannot have a floating bubble]]
- **A cron.** See [[Why there is no cron]]. Re-examined 2026-08-07 and the decision holds. The
  feeds already refresh continuously — a 30-minute freshness window, verified live in production
  — so a *weekly* scan would be a downgrade, not an upgrade: raid bosses rotate, Spotlight Hours
  are weekly and events turn over daily. The only real gaps are that one visitor per window pays
  the upstream fetch, and that `HARD_TTL_S` would expire the cache outright after seven days of
  zero traffic, leaving the stale-fallback with nothing to serve. If that second case ever
  matters, an auxiliary worker calling `refreshAllFeeds` **hourly** closes it
- **Anything that reads the game.** See [[Never Touch the Game]]
- **Ads.** Would breach the Leek Duck terms. See [[Attribution Obligations]]

## See also

[[Home]] · [[Bugs Worth Remembering]]
