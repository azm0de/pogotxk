---
tags: [planning]
updated: 2026-09-05
---

# Backlog

Everything in the original plan is built. This is what is left, roughly by value.

## The redesign branch — `impeccable-redesign`, September 2026

The Trail-Map Kiosk world shipped on the branch: two finish reviews passed, `DESIGN.md` at the
repo root is the visual reference, and the working ledger for the redesign's own leftovers is
`.impeccable/surfaces/promotions.md`. As of 2026-09-05 the branch is 53 commits ahead of
`origin/main` and is **not pushed, PR'd or merged** — Justin's decision (2026-09-03) until he says otherwise.

- [ ] **Smoke-test the signed-in paths with a real Discord session** — the `/go` sheets, a
      populated `/live`, the `/account/delete` success page, `/auth/device` approval. Every one
      of them has only ever been verified against fixtures
- [ ] **Admin with a real session** — PATCH on drag and on the lat/lng inputs, a media upload,
      the markdown preview against real posts
- [ ] **Discord location resolver.** Board post 1 shows the scheduled event's raw
      `entity_metadata.location` string ("Street A" in the fixture); `discord-events-map.ts`
      passes it straight through. Decide how organisers fill that field — a POI name, an
      address, free text — then match it against the surveyed POIs and hand back a map link
- [ ] **One source for meetups.** `/events` "Meetups at the Campsite" lists database meetups
      only; the home page's next-up also takes Discord scheduled events, so the two pages can
      disagree about what is next
- [ ] **The closing panel's "Open the map" button** was not carried over when the next meetup
      moved onto board post 1 (`0fe7bcd`); the hero's button sits directly above. Confirm or
      restore
- [ ] **`Attribution.astro`'s first paragraph** was reworded during the redesign ("cached on our
      own origin, so the pictures on this page do not spend their bandwidth"); both links and
      the no-ads sentence are intact. Confirm the wording
- [ ] **Merge and deploy** — owner's call
- [x] ~~Fixed on the branch, never listed here~~ — recurring meetups roll forward to their next
      occurrence instead of falling into `past` (`25b0d24`); the admin editors joined the world
      and the admin audit's findings closed with them (`b976fe0`, `f026d90`, see
      `.impeccable/critique/audit-admin.md`)

## Source art is out of `public/` — closed 2026-08-18

Both items that used to sit here are done, and the second one closed badly enough to be worth
recording rather than just ticking.

- [x] ~~The **`.gitignore` edit** and the untracked **`.github/`**~~ — fixed in `03facef`. The
      rule read `.github\instructions\codacy.instructions.md`, and gitignore patterns are POSIX
      paths always: a backslash there is an escape character, not a separator, so it matched
      nothing and the file it was meant to hide kept showing up as untracked
- [x] ~~**`public/art/go.webp`**, **`pogoeve.png`** and **`Pokemon_Go.svg.webp`**~~ — this entry
      warned that committing the last one "would serve a trademarked logo from `/art/` for no
      reason". It was committed anyway in `7791fec`, with seven more, on the reasoning that they
      were *already* being deployed and git was the only place they did not exist. Both halves of
      that were true and the conclusion still went the wrong way: the answer to "an unreferenced
      trademark is being served" is to stop serving it, not to start tracking it

> [!danger] `public/` is a publishing decision, not a storage location
> Everything under it is copied into the build and uploaded as a static asset, whether or not a
> single line of code references it. **9.1 MB of the 9.3 MB in `public/art/` answered `200` in
> production and was loaded by no page** — including the Pokémon GO wordmark at
> `/art/Pokemon_Go.svg.webp`, which [[Attribution Obligations]] §3 forbids the site from using
> at all.
>
> The ten unreferenced originals now live in **`art-src/`**, which is neither built nor deployed.
> `art-src/README.md` maps each source to the derivatives generated from it. Source material
> belongs there; only what a page actually loads belongs in `public/`.

## Blocked on the owner

- [x] ~~Web push~~ — VAPID keypair generated and set 2026-08-06;
      `/api/push/subscribe` reports `enabled: true`. See [[Configuration]]
- [ ] **Test the bubble on a real phone**, ideally over Pokémon GO. See [[Android App]]
- [ ] **Rotate the Discord client secret** — it passed through a chat transcript during setup

## Discord server admin — landed, work it through with Nick

Justin has server admin as of 2026-08-13. What blocked this list is gone; what remains is
that **the server is live**, with real members in it, so the order below matters more than
the speed. Nothing a member can see happens until the repoint step.

- [x] ~~**`DISCORD_WEBHOOK_URL`**~~ — **set.** `wrangler secret list` shows it on the Worker
      (checked 2026-09-05; names only, no value was read). What the repo cannot see, and so is
      still open, is the two sub-items below.
      How it was meant to go: Server Settings → Integrations → Webhooks. Point it at a
      **private channel first**, test there, then edit the webhook's channel to the public
      one: the URL is `.../webhooks/{id}/{token}` and neither part is channel-derived, so
      repointing does not change it and the secret is set exactly once.
      `npx wrangler secret put DISCORD_WEBHOOK_URL` and paste at the prompt — the
      piped-literal form puts a bearer credential into shell history.
      Only `discord.com` / `discordapp.com` hosts are accepted — see [[Notifications]].
      This is the last piece of notifications; push itself is already live
      - [ ] **Repoint it to the public channel** once tested, and **close every test flare
        before repointing.** A webhook edits its own messages through the channel it currently
        points at, so afterwards the old message ids are unreachable and the strike-through
        fails silently
      - [ ] Set the webhook's **avatar** while there. `postFlareToDiscord` sends a `username` but
        no `avatar_url`, so Discord falls back to the webhook's own — a grey blob by default
      - Verify without firing anything: `GET /api/admin/config-check` now reports
        `webhook.accepted`, which is `webhookUrl()`'s own verdict rather than mere presence.
        A present-but-rejected value is indistinguishable from an absent one at runtime
- [ ] **`DISCORD_ROLE_ADMIN` / `_AMBASSADOR`** — Server Settings → Roles → right-click →
      Copy ID, with Developer Mode on. They go in `wrangler.jsonc` under `vars`, not the
      dashboard, for the reason in [[Configuration]]. Until they are set nobody is promoted
      automatically and roles stay hand-assigned. Safe to get wrong:
      `DISCORD_BOOTSTRAP_ADMIN_ID` short-circuits `resolveRole` before any role is consulted.
      See [[Auth and Roles]]

> [!danger] Leave `DISCORD_ROLE_MEMBER` unset unless the Discord really gates on a role
> It is the one setting here that can lock the community out. Set, it stops guild membership
> from being enough — only holders of that exact role are `member` and everyone else drops to
> `guest`, and `POST /api/flares` requires `member`. A wrong or over-narrow id means nobody
> can fire a flare, and it presents as a permissions bug rather than a config one.
- [ ] **A second admin.** Right now the site has exactly one, promoted by hand. If Nick is
      going to be an ambassador on the site as well, do it in the same sitting
- [ ] **Tell Nick his GO Fest photo is on the home page**, and ask whether he has a frame
      without the refuse bin in it. It was the landing banner from 2026-08-07; on the redesign
      branch it leads "The community" section under the hero (`7af5ec5`). His photo, his
      byline, and the crop currently loses two members at the right edge — a wider or
      different frame would let everyone back in. See [[Design System]] for why the bin was
      not retouched out. Justin has since said the banner needs no on-image byline
      (2026-09-03); the caption stays

### The Discord *application* is a separate system from the server

Worth separating, because it was assumed the other way round for a while: the Developer Portal
app (client id `1534670096256073778`) and the Discord server are different systems with
different permissions.

> [!important] An OAuth app is not attached to the guild, and does not need to be
> It needs no bot, no install into the server, and no permission from whoever runs it —
> `guilds.members.read` reads membership with the **signed-in user's own** access token.
> App ownership and server ownership are unrelated. So "Nick owns the server" says nothing
> about who owns the app, and if it turns out he does, creating our own costs very little:
> `users.discord_id` is a global Discord id rather than a per-app one, so switching
> applications preserves every user record. With one user in the table, the whole cost is a
> new client id, a new secret, re-registering the redirect URI and one re-consent screen.

- [x] ~~**Confirm the redirect URI is registered**~~ — **it is.** This was listed as
      uncheckable from outside. It is not: `azm.0` completed a full OAuth round trip on
      **2026-08-05T22:21:55Z**, which the callback cannot do unless
      `https://pogotxk.gnomelabz.workers.dev/auth/callback` matched exactly. Sign-in, the
      client secret and the callback are all proven working. A *new* host — the custom
      domain — will still need registering separately
- [ ] **Settle who owns the app**, which takes ten seconds and needs nobody: open
      <https://discord.com/developers/applications> while signed in. Listed → it is yours,
      and only the private channel needs Nick. Not listed → ask for Team membership, or
      create your own per the note above. The app exists and is named **PogoTXK** — that
      much is confirmed from its public record
- [ ] **Rotate the client secret** — it passed through a chat transcript during setup. A
      fresh app makes this automatic; an existing one needs Reset Secret. Have it sent via a
      password manager share, never chat or email, then `npx wrangler secret put
      DISCORD_CLIENT_SECRET` and paste at the prompt — the piped-literal form puts a
      credential in shell history
- [ ] **The app has no icon** (`icon: null`). Every member's first impression of this project
      is a blank square on the Discord consent screen. Upload the Poké Ball logo

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

## The calendar subscribe feature is gone

- [x] ~~Decide: leave the feeds unlisted, add autodiscovery, or delete them~~ — deleted,
      2026-08-15. `/calendar/[feed].ics.ts`, `SubscribeCard.astro` and its CSS are gone.
      `lib/ics.ts`'s serialisation half (`buildIcs`, `icsResponse`, escaping, folding, UTC
      stamps) went with it; the event-model half it also carried — `CalendarEvent`,
      `groupEvents`, the ScrapedDuck adapter — is what `/events` and the home page actually
      render with, so that moved to `lib/events.ts` rather than being deleted.
      `scripts/test-ics.ts` became `scripts/test-events.ts`, trimmed to the model checks.
      Anyone who had subscribed to a feed URL now gets 404s on the next poll instead of
      silent updates — accepted, since nobody was ever told the URLs existed to subscribe
      in the first place

## Lighthouse

**Re-audited 2026-09-05**, mobile and desktop. First against the production build locally
(`npm run preview`), then — after the branch merged to `main` and Workers Builds deployed —
**against production itself, which is the number that counts**:

| Home, warmed | perf | a11y | best practices | SEO | FCP | LCP |
|---|---|---|---|---|---|---|
| **Production, mobile** | **91** | 100 | 100 | 100 | 1.7s | 3.3s |
| **Production, desktop** | **98–100** | 100 | 100 | 100 | 0.5s | 0.8–1.0s |
| Local preview, mobile | 92–93 | 100 | 100 | 100 | 1.4s | 3.1s |
| Local preview, desktop | 98–99 | 100 | 100 | 100 | 0.4s | 0.9s |

Mobile LCP was ~5s in August and is 3.3s now. Accessibility was 97 and is 100.

> [!warning] Only warmed runs mean anything, on either host
> The first run against a cold cache scored **71 mobile with a 7.3s LCP** on the very same
> production deploy that scores 91/3.3s warm — and 73 locally against 92. Discard the first
> run, every time. This is the same trap as the `wrangler dev` note in
> [[Bugs Worth Remembering]], and it bites on production too, not just locally.

`/events`, `/raids`, `/map`, `/blog`, `/live`, `/about` are 100/100/100 on the three
transport-independent categories.

Two findings, both fixed in `65f55cd`:

- [x] ~~**A third-party cookie**, and the only thing between the branch and 100 on Best
      Practices (79 mobile, 78 desktop).~~ The next meetup's cover art pointed straight at
      `cdn.discordapp.com`, which sits behind Cloudflare's bot management and hands every
      visitor a `__cf_bm` cookie — on a page that says there is no tracking on it. It arrived
      with the redesign, when the meetup moved onto board post 1. Event art is proxied now
      through `/img/discord/`, a sibling of the Leek Duck proxy with its own allowlist:
      nothing outside `guild-events/` is fetchable, because
      `cdn.discordapp.com/attachments/` is user-uploaded content. **The page now makes zero
      third-party requests**, verified in the browser
- [x] ~~**The hero wordmark shipped at 850px into a 380px box.**~~ Three widths behind a
      srcset; a 1x screen now takes 41KB instead of 79KB. The meetup cover asked for
      `size=1024` to fill a 309px plate and now has a srcset too

> [!warning] Two things Lighthouse asks for here that are wrong
> `fetchpriority="high"` on the hero and the render-blocking stylesheets. Both are already
> settled in [[Bugs Worth Remembering]] — the first measured *worse* over three production
> runs each way, and the second is an artefact of `wrangler dev` serving HTTP/1.1 without
> Brotli, which the edge does not do. Neither was touched.

`/go` scores SEO 63 and Best Practices 96, and **both are correct behaviour, not defects**:
it carries `noindex` because it is the screen people install to their home screen, and it
asks for location on mount because every action on it is "what is near me" and a prompt
mid-flow is worse. Both are commented at the call site. Do not "fix" either.

What remains is payload, and it is transport-independent — it does not go away at the edge:

- [ ] **~549KB of oversized Leek Duck card art** on the home page: four event images served
      at full size into cards a third the width. Same blocker as the 1.8MB photograph below
      — resizing needs the edge image service, which needs the zone, which means the custom
      domain. The proxy fetches the bytes but a Worker cannot resample them

### From the 2026-08-10 audit, against production

Accessibility 93 → **97** and SEO 92 → **100** are done and live. Best Practices was 100 then
and is 100 again now.

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
- [x] ~~**Mobile LCP is ~5s** against a ~1.5s FCP, and the hero logo is the LCP element at
      102KB.~~ Addressed 2026-09-05 by the srcset above, not by `fetchpriority`. Warmed
      mobile LCP on the production build is now ~3.1s with FCP ~1.4s. The hero is still the
      LCP element, which is correct — it is the first thing in the viewport

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
- [ ] **Community POI problem reports.** `poi_reports` and the moderation queue exist in the
      schema; no UI yet. Report-only by decision (2026-08-15) — a visitor can flag that an
      existing POI moved, closed or has wrong info, never propose a new one. `poi_id` is
      `NOT NULL` and the `'new'` kind is gone; new POIs stay admin-only, added straight in the
      map editor. See [[Data Model]]
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
- [x] ~~**`/go` is sparse for a signed-out visitor**~~ — the empty-board sentence used to read
      "Fire one below…" to everyone, pointing a signed-out visitor at six disabled buttons.
      When the viewer cannot post it is now replaced by three lines describing the app. The
      guest wording was wrong as well as sparse: "ask an ambassador" sent people to ask for
      something nobody has to grant, since `resolveRole` upgrades on guild membership alone

### From the visual pass, 2026-08-07

- [x] ~~Two design skills wired into `.claude/skills/`~~ — Anthropic's `frontend-design`
      (vendored, Apache 2.0) for taste, and `pogotxk-design` for our constraints. See
      [[Design System]]
- [x] ~~The 63 landmark photographs were invisible~~ — they existed only inside a map popup you
      had to tap a pin to open. Now a rail under the hero, each tile deep-linking to
      `/map?poi=<slug>`. *Gone again since `e814e0d` (2026-08-10): the rail and the "Right
      now" card were dropped from the home page, along with the per-request JOIN that fed the
      rail, and the redesign did not bring them back. The map popups are the way to the
      photographs again; the "landmark rail" section in [[Design System]] is history*
- [x] ~~"The community" had no route onward~~ — the only section on the home page without one;
      now links to `/gallery`
- [x] ~~`.section-head` broke a link mid-phrase~~ — at 390px "All 104 on the map" wrapped and
      stranded the arrow on its own line
- [x] ~~No Pokémon artwork anywhere outside the game-data pages~~ — shiny Lucario, Mew and
      Magikarp bleed off a page edge in the hero, "Happening now" and the Campsite explainer,
      via a reusable `.art-band` utility. See [[Design System]]
- [x] ~~Moltres is orphaned on `/about`~~ — moved to `/live`, 2026-08-15. It is a raid boss, so
      the live board is the one page where the art is what the page is about rather than borrowed
      decoration; the old one-bird-per-team framing was gone from `/about` anyway. Anchored to the
      top of the head block, not the bottom the way `/about`'s was — the board's height is a
      WebSocket feed, and bottom-anchoring would make the art jump every time the flare count
      changed. Hidden below 1000px rather than faded: no strip to drop it behind on a page that is
      opaque flare cards edge to edge, the same collision `onnow-band`'s mobile rule already hit
      once (see [[Design System]])
- [ ] **Only the home page and `/live` carry artwork.** `/events` is the remaining candidate with
      room; `/gallery` is gone, merged into `/blog` 2026-08-15
- [x] ~~The palette was inherited navy and cream~~ — repainted red/white/black as a Poké Ball.
      The obvious Pokémon reds all fail AA on white and every red now sits at hue 353–354°;
      see [[Design System]] before touching any of it
- [x] ~~The home page opened on a headline, not on the community~~ — the GO Fest group photo is
      now the banner, art-directed for wide and narrow
- [ ] **Ask Nick for a GO Fest frame without the refuse bin.** The banner crop currently loses
      two members at the right edge because the bin could not be retouched out without inventing
      their legs — [[Design System]] has the full reasoning
- [x] ~~The hero and the section headings are still system-ui at every level~~ — `h1`–`h4` now
      use a display face via `--font-display`, self-hosted, 2026-08-15. Shipped first as
      Fredoka, switched same-day to **Baloo 2** — Fredoka's extra roundness read too close to
      a kids' app. Body text is unchanged system-ui. See [[Attribution Obligations]].
      *Superseded on the redesign branch: headings are Overpass via `--font-sign` and body is
      Atkinson Hyperlegible Next via `--font-read`; `--font-display` survives only as a
      compatibility alias. Licences sit beside the files as before*
- [x] ~~`/map`'s basemap never joined the site's dark theme~~ — *superseded 2026-08-28: the
      basemap is now self-hosted Protomaps, pinned light in both schemes; see [[Basemap]].* At the
      time, CARTO's tile URL switched
      between `voyager` and `dark_all` on `prefers-color-scheme`, live via a `matchMedia`
      listener, not just at load. Bundled in: Leaflet's own zoom control, previously stock
      white/black, now themed off `--bg-panel`/`--text`/`--border` like the attribution
      control already was. 2026-08-15
- [ ] **Per-page OG images.** `Base.astro` sends one `og:image` for the whole site —
      `/og-default.png`, the wordmark on a grey ground at 1200×630 — for every route except
      `/blog/[slug]`, which passes the post's hero. So a link to `/map`, `/events` or `/go`
      pasted into Discord previews as the same generic card rather than the park, the event
      or the meetup. Per-page means each route (or each event and meetup) supplies its own
      image; PRODUCT.md lists it as explicitly undecided

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
