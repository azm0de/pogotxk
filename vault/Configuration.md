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

## Not set — features that stay off until they are

| Name | Type | Enables |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | Secret | Flares into Discord — [[Notifications]] |
| `VAPID_PUBLIC_KEY` | Secret | Web push |
| `VAPID_PRIVATE_KEY` | Secret | Web push |
| `VAPID_SUBJECT` | Secret | Web push — must be `mailto:` or `https://` |
| `DISCORD_GUILD_ID` | var | Guild membership check — [[Auth and Roles]] |
| `DISCORD_BOOTSTRAP_ADMIN_ID` | var | First admin without a database edit |
| `DISCORD_ROLE_ADMIN` / `_AMBASSADOR` / `_MEMBER` | var | Automatic role mapping |

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
