---
tags: [architecture, feature]
updated: 2026-09-08
status: needs-secrets
---

# Notifications

> [!note] Not switched on yet
> The code is deployed and tested, but both channels need secrets that have not been set.
> See [[Configuration]]. Until then flares reach the live board but notify nobody.

Without this, a flare only exists if someone happens to have the page open. This is the other
half.

## Discord webhook

`src/lib/notify/discord.ts`. Flares post as rich embeds into the community server. Realistically
the channel that reaches the most people, since it needs no install.

The message id is stored on the flare so the embed can be struck through when it closes.

> [!warning] The webhook URL is host-checked
> It is configuration, and a wrong or hostile value would quietly forward every flare — trainer
> names and locations included — to somebody else's server. The check rejects:
> - `notdiscord.com` — a suffix match would accept it
> - `https://discord.com@evil.example/` — the userinfo trick, which a naive string match accepts
>
> Covered in `scripts/test-notify.ts`.

`allowed_mentions: { parse: [] }` is set so nothing in a user-supplied note can ever ping
`@everyone`.

## Announcing posts and meetups

`src/lib/notify/announcements.ts`, added 2026-09-08. A post or a meetup carries an **"also
announce to Discord"** toggle in the admin editors; ticking it puts a rich embed in the channel
linking back to the site.

`announceToDiscord` had existed with **no caller** for the whole life of the site, so publishing
a post told nobody. What was missing was never the HTTP request — it was the two pieces of state
that make sending one safe from a read path:

| column | question it answers |
|---|---|
| `announce_requested` | did the author ask for this? Defaults to 0; most posts are not announcements |
| `announced_at` | still owed, or settled? Also the concurrency claim |

> [!important] `announced_at` is written *before* Discord is called
> Same claim-then-send as `discord_closed_at` on flares, for the same reason: this runs off a
> read path, so several requests can be inside it at once. Claiming inside the selecting
> statement means the second caller sees no rows. A retryable failure hands the row back; a
> `gone` (401/403/404) leaves it settled, because no number of retries fixes a deleted webhook.
>
> Claiming first risks a *delayed* announcement. Claiming last risks a *duplicate* one — and a
> duplicate is the one the community sees.

**Scheduled posts ride a read, not a clock.** A post scheduled for Friday at 6 PM becomes public
the moment SQL says so, but Discord has to be told, and this Worker has no cron ([[Why there is
no cron]]). So `sweepAnnouncements` runs from the home page — the hottest page, and the one that
already lists both posts and meetups. Worth being honest about the consequence: the announcement
goes out on the first page load *after* 6 PM, not at 6 PM. It is still sent, and still sent
exactly once. It is not a scheduler.

**A save never waits on Discord.** The send is handed to `waitUntil`, exactly as the flare
fan-out is, so the editor reports the *intent* — `off`, `queued`, or `disabled` — and never
claims a message has landed. `disabled` is the one worth reading: it means no webhook is
configured, nothing will be sent, and the request has been *kept* so it goes out when one is.

**Cancelled meetups are never announced.** The public feed carries a cancelled meetup so
subscribers learn it is off; a fresh embed would advertise an event that is not happening.

> [!danger] Announcing is a one-way door
> An embed cannot be recalled from a channel with real members in it, and unlike a flare no
> `discord_message_id` is stored, so nothing can go back and edit it either. Once `announced_at`
> is set the editors replace the toggle with a statement of when it went. Deleting the post does
> **not** unsend the message — see the `.dev.vars` entry in [[Bugs Worth Remembering]], which
> was written after exactly that happened during local testing.

Builders are pure and asserted in `scripts/test-announce.ts`, including a check that the
"is this post public" predicate still matches the read model's own — a duplication that would
otherwise rot into announcing posts the site would 404.

## Web Push

`src/lib/notify/push.ts`, using `@block65/webcrypto-web-push`. A 🔔 toggle on `/go`.

- Works on Android, and on iOS 16.4+ **once installed to the Home Screen from Safari**
- Permission must be requested from a real tap — iOS silently refuses otherwise, and reports
  nothing
- `VAPID_SUBJECT` must be `mailto:` or `https://`. Apple returns 403 for anything else, and
  only on iOS — so a bad value looks like "push just doesn't work on iPhones"

**Pruning is deliberate:** a subscription is marked dead only on 404/410, which mean it is
permanently gone. A 5xx or timeout is transient and left alone — dropping a subscriber over a
blip means they never hear about a raid again.

**The public key is served from `/api/push/subscribe`**, not baked into the bundle, so neither
half of the keypair has to be committed and rotating them needs no rebuild.

## Turning it on

```bash
npm run gen:vapid
```

Then add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `DISCORD_WEBHOOK_URL` as
**Secrets** — see [[Configuration]] for why type matters.

## See also

[[Flares and Realtime]] · [[Configuration]]
