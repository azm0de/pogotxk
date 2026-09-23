---
tags: [runbook, security]
updated: 2026-09-23
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
| `DISCORD_GUILD_ID` | var | `wrangler.jsonc` | Public — membership check is ON; outsiders are guests |
| `DISCORD_BOOTSTRAP_ADMIN_ID` | Secret | `wrangler secret` | Kept out of the public repo — see below |
| `RESEND_API_KEY` | Secret | `wrangler secret` | Admin password reset by email — see [[#Turning on the admin password reset]] |
| `RESEND_FROM` | Secret | `wrangler secret` | A **bare** address on the verified sending domain, `gnomelabz.com`. Inboxes show "PoGo TXK": the name is added in code |

> [!danger] Set the bootstrap admin BEFORE the guild id, never after
> Configuring a guild makes Discord **authoritative** over roles. With no
> `DISCORD_ROLE_*` ids set, every guild member resolves to `member` — and that gets
> written on sign-in, silently demoting a hand-promoted admin and locking everyone out
> of `/admin`. `DISCORD_BOOTSTRAP_ADMIN_ID` short-circuits `resolveRole` to `admin` and was,
> until the password door existed, the only thing preventing it. Verified against
> `resolveRole` before the 2026-08-06 deploy: with it he resolves to `admin` either way;
> without it, `member`. The ordering is still right for a fresh deployment; on this one the
> secret is being retired — see the note below.
>
> It is a Secret rather than a var because the repo is public: it is a personal Discord
> user id, and it marks one account as permanently admin. Secrets survive deploys just
> as reliably.

> [!note] The admin door needs no configuration at all, and that is still the point
> `/admin/login` takes a password stored in D1, so it depends on no variable, no secret and
> no third-party service. The two admin accounts are standalone identities that have no
> Discord account behind them, so nothing in this table grants or withholds their access.
> Make one with `npm run set:password -- --create <name>` and see [[Auth and Roles]].
>
> **The `/admin/reset` recovery path is the exception, and it is opt-in twice over.** It
> needs `RESEND_API_KEY` and `RESEND_FROM` below, and it needs an address on the admin's own
> row. Without all three it is inert. The sign-in door itself is untouched by that — it keeps
> working with no variables set, which is the property it was built for.
>
> That inverts what this note used to say. The password was the recovery path for a
> bootstrap sequence that had gone wrong; it is the ordinary way in now, and
> `DISCORD_BOOTSTRAP_ADMIN_ID` is being retired because a secret that mints an admin is the
> single point of failure the password door was built to remove. Setting the bootstrap
> secret before the guild id is still the right sequence for a *fresh* deployment.
>
> **The path is not part of the configuration and not part of the defence.** It is fixed at
> `/admin/login`, and the repo is public, so it is public knowledge. What has to be strong is
> the password — the PBKDF2 cost sits at the free plan's ceiling of 10,000 rounds, so entropy
> is doing the work. See the warning in [[Auth and Roles#The admin password door]].

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

`DISCORD_GUILD_ID` and `DISCORD_BOOTSTRAP_ADMIN_ID` were listed here as well as above for a
while. They are **set** — see the table above; this list is only what is genuinely missing.

| Name | Type | Enables |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | Secret | Flares into Discord — [[Notifications]] |
| `DISCORD_ROLE_ADMIN` / `_AMBASSADOR` | var | Automatic role mapping |
| `DISCORD_ROLE_MEMBER` | var | A role-gated membership check. **Usually leave unset** — see [[Backlog]] |
| `SITE_URL` | **build** var | Canonical host. Only needed at the domain cutover — see below |

> [!important] `SITE_URL` is a build variable, not a runtime one
> It is read by `astro.config.mjs` at build time, so it belongs in the **Workers Builds**
> environment, not the Worker's own variables. Setting it as a runtime variable does nothing.
>
> It defaults to `https://pogotxk.gnomelabz.workers.dev` — the host that actually serves the
> site. Do not point it at `pokemontxk.com` until that domain resolves to the Worker: it feeds
> canonical URLs and RSS, and aiming it at a 404 is what silently broke every subscribe link
> back when the site still had a subscribable calendar feed. See [[Bugs Worth Remembering]].

Everything above is optional. Unconfigured, the feature degrades quietly rather than erroring.

### Turning on the admin password reset

Done in production — both secrets are set, and resets have been delivered and completed there
(2026-09-23). This is the procedure, kept for a fresh deployment or a rotation. **Both, or
nothing is sent.**

Two values, both **Secrets**, and `RESEND_FROM` is a Secret despite not being confidential —
it appears in the header of every mail it sends. The reason is the warning at the top of this
note: a plain-text var set in the dashboard is deleted by the next deploy, and Workers Builds
deploys on every push. It is either a Secret or a line in `wrangler.jsonc`, and a Secret is
fewer moving parts.

```bash
wrangler secret put RESEND_API_KEY     # https://resend.com > API Keys; sending only
wrangler secret put RESEND_FROM        # a bare address, e.g. noreply@<a gnomelabz domain>
```

> [!warning] `RESEND_FROM` is a bare address — no display name
> `PoGo TXK <noreply@…>` in the secret is **refused**, and a refused From turns the sender off
> entirely, silently, the same as an unset one. That is deliberate: a display name typed into
> configuration is a header-injection shape. Inboxes still show **"PoGo TXK"** as the sender,
> because `fromHeader` in `src/lib/notify/email.ts` wraps the validated address in a constant
> name in code. So the secret holds only the address, and the name is not configurable.

> [!danger] The sending domain must be verified in Resend first, and a failure here is silent
> Resend refuses mail from an unverified domain. The reset endpoint **cannot report that** to
> the person who asked, because it answers identically whether or not the address is
> registered — that is the whole design, and it means a delivery failure looks exactly like
> "no account with that address". Verify the domain in Resend, then set the secret, then test
> with an address you control.

> [!tip] Set the key at wrangler's prompt, never as a piped literal
> `wrangler secret put` reads from stdin when it is given one, which puts the value in shell
> history. The standing rule in this repo is the one the VAPID procedure follows: a value
> that is never displayed cannot be leaked by a screenshot or a pasted transcript.

Then give an admin an address, which is a separate, per-account step:

```bash
npm run set:password -- --create <name> --email you@example.com --remote
```

> [!warning] An address is a second way into that account
> Anyone who can read that mailbox can take the admin account, so the door becomes as strong
> as the weaker of the two. Use a mailbox with its own strong password and two-factor, and
> not one shared with anybody. `--clear-email` puts it back. The full argument is in
> [[Auth and Roles#Password reset by email]].

Only `api.resend.com` is ever contacted, checked in code rather than trusted from
configuration — the request carries the key in an `Authorization` header, so a wrong host
would be a disclosure rather than a failed send.

The mail is **multipart** since 2026-09-23: a plain-text part, always, and a branded HTML part
beside it, at the owner's request. The HTML carries **no remote resource of any kind** — no
image, no web font, no stylesheet — so opening it fetches nothing and reports nothing to
anyone. See [[Auth and Roles#It is off unless configured, and that is the default]].

> [!danger] Resend's open and click tracking must stay **off** for `gnomelabz.com`
> Resend's tracking works on the HTML part, which the reset mail now has.
>
> - **Click tracking** rewrites every link in the HTML to pass through a Resend tracking
>   subdomain first. That includes the reset link, which is a working credential for thirty
>   minutes — so every live reset link would be handed to, and recorded by, a third party's
>   redirect on its way to the admin.
> - **Open tracking** inserts a tracking pixel: a fetch on open that reports when an admin
>   opened a password-reset mail and from which IP — the exact thing the mail is built not to
>   carry.
>
> Both are **per-domain** settings in Resend (Domains → the domain → Configuration → "Enable
> tracking metrics"), both are **off by default**, and neither becomes active until a CNAME for
> a tracking subdomain is verified. Leave them off for the sending domain. If some future
> newsletter wants them, send it from a different domain. Nothing in this repository can see
> the setting — it lives in Resend's dashboard — so this note is the control.

## Diagnosing "I set it but it says not configured"

Two ways, no terminal needed for the first:

1. Visit `/auth/login` — when unconfigured it renders a page naming which specific variable is
   missing, plus the likely causes.
2. `GET /api/admin/config-check` (admin session or `IMPORT_TOKEN`) returns booleans, lengths and
   whitespace/quote warnings — **never values** — and flags near-miss names like
   `DISCORD_CLIENTID`.

> [!tip] For the webhook, ask for `webhook.accepted`, not `webhook.present`
> `webhookUrl()` rejects any host that is not Discord's, and a rejected value behaves
> *identically* to an absent one: `postFlareToDiscord` returns null and logs nothing either
> way. `accepted` reports that verdict, so it is the only way to know flares will land
> without posting a real embed into a real channel to find out.

## Never commit

`.dev.vars` is gitignored. `.dev.vars.example` is the template and holds no real values.
The Discord **client secret** must never appear in `wrangler.jsonc`.

## See also

[[Deploying]] · [[Auth and Roles]] · [[Notifications]] · [[Platform Limits and Traps]]
