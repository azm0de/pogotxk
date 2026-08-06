---
tags: [architecture, feature]
updated: 2026-08-05
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
