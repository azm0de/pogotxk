---
tags: [runbook, security]
updated: 2026-08-05
---

# Configuration

**Where:** Cloudflare dashboard → Workers & Pages → `pogotxk` → Settings → Variables and Secrets.

> [!danger] Text variables are deleted on every deploy
> `wrangler deploy` removes every plain-text var not declared in `wrangler.jsonc` before
> applying the ones that are — and Workers Builds runs a deploy on every push. A var added
> through the dashboard therefore survives only until the next commit.
>
> **Secrets are exempt** and are never deleted.
>
> This is exactly how `DISCORD_CLIENT_ID` silently vanished and broke sign-in while
> `IMPORT_TOKEN` kept working. Non-secret config now lives in `wrangler.jsonc` under `vars`,
> and `keep_vars: true` protects anything else set in the dashboard.

## Currently set

| Name | Type | Where | Notes |
|---|---|---|---|
| `DISCORD_CLIENT_ID` | var | `wrangler.jsonc` | Public — appears in the OAuth URL |
| `DISCORD_CLIENT_SECRET` | Secret | dashboard | |
| `IMPORT_TOKEN` | Secret | dashboard | Only needed before anyone can sign in |
| `VAPID_PUBLIC_KEY` | var | `wrangler.jsonc` | Public — handed to every browser as `applicationServerKey` |
| `VAPID_PRIVATE_KEY` | Secret | `wrangler secret` | Set 2026-08-06 |
| `VAPID_SUBJECT` | Secret | `wrangler secret` | `mailto:jeportillo1@gmail.com` |

Confirm the whole push config in one request — `enabled` is only true when all three
pass, including the subject check:

```bash
curl -s https://pogotxk.gnomelabz.workers.dev/api/push/subscribe
```

> [!tip] Generate straight into wrangler, never onto the screen
> The pair was created so the private key never reached a terminal or shell history:
> a one-shot script wrote it to a file, `wrangler secret put VAPID_PRIVATE_KEY < file`
> consumed it, and the file was overwritten before being deleted. Worth repeating for
> any future secret — a value that is never displayed cannot be leaked by a screenshot
> or a pasted transcript.

> [!warning] Do not rotate the VAPID pair casually
> A browser binds its subscription to the `applicationServerKey` it subscribed with.
> A new pair orphans every existing subscriber — they keep receiving nothing, with no
> error on either side. It was safe to generate on 2026-08-06 only because `push_subs`
> was empty. It is not safe once anyone has subscribed.

## Not set — features that stay off until they are

| Name | Type | Enables |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | Secret | Flares into Discord — [[Notifications]] |
| `DISCORD_GUILD_ID` | var | Guild membership check — [[Auth and Roles]] |
| `DISCORD_BOOTSTRAP_ADMIN_ID` | var | First admin without a database edit |
| `DISCORD_ROLE_ADMIN` / `_AMBASSADOR` / `_MEMBER` | var | Automatic role mapping |
| `SITE_URL` | **build** var | Canonical host. Only needed at the domain cutover — see below |

> [!important] `SITE_URL` is a build variable, not a runtime one
> It is read by `astro.config.mjs` at build time, so it belongs in the **Workers Builds**
> environment, not the Worker's own variables. Setting it as a runtime variable does nothing.
>
> It defaults to `https://pogotxk.gnomelabz.workers.dev` — the host that actually serves the
> site. Do not point it at `pokemontxk.com` until that domain resolves to the Worker: it feeds
> canonical URLs, RSS and the ICS `SOURCE` field, and aiming it at a 404 is what silently broke
> every calendar subscribe link. See [[Bugs Worth Remembering]].

Everything above is optional. Unconfigured, the feature degrades quietly rather than erroring.

## Diagnosing "I set it but it says not configured"

Two ways, no terminal needed for the first:

1. Visit `/auth/login` — when unconfigured it renders a page naming which specific variable is
   missing, plus the likely causes.
2. `GET /api/admin/config-check` (admin session or `IMPORT_TOKEN`) returns booleans, lengths and
   whitespace/quote warnings — **never values** — and flags near-miss names like
   `DISCORD_CLIENTID`.

## Never commit

`.dev.vars` is gitignored. `.dev.vars.example` is the template and holds no real values.
The Discord **client secret** must never appear in `wrangler.jsonc`.

## See also

[[Deploying]] · [[Auth and Roles]] · [[Notifications]] · [[Platform Limits and Traps]]
