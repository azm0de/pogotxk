---
tags: [decision]
updated: 2026-08-05
---

# Why Discord is the identity provider

**Decision:** Discord OAuth is the only sign-in. No passwords, no email, no separate accounts.

## Reasoning

The community already lives on Discord. That makes guild membership a **free, accurate
membership check** — no verification step to build, no roster to keep in sync, and no way to be
"a member of the site" without being a member of the community.

It also means roles live in one place. An ambassador promoted in Discord becomes an ambassador
here on their next sign-in.

## Consequences

- No password reset, no email verification, no account recovery to build or get wrong
- We never see an email address or a password — less to leak
- Discord being down means nobody new can sign in; existing sessions keep working for two weeks
- Anyone without a Discord account cannot participate. Acceptable: this community *is* its
  Discord

## Follow-through

Two mistakes came out of this and are documented in [[Auth and Roles]]: requiring the guild id
blocked the first login entirely, and re-syncing the role on every login silently demoted
hand-promoted admins.

## See also

[[Auth and Roles]] · [[Configuration]]
