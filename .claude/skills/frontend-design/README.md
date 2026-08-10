# frontend-design — vendored, unmodified

`SKILL.md` and `LICENSE.txt` in this directory are copied **byte for byte** from Anthropic's
official `frontend-design` plugin. Nothing has been changed.

- **Upstream:** `plugins/frontend-design/skills/frontend-design/` in
  [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
- **Licence:** Apache 2.0 — see `LICENSE.txt`, retained here as the licence requires
- **Vendored:** 2026-08-07

## Why a copy rather than `/plugin install`

Installing it as a user plugin would put it on one machine. Copied into the repo it travels with
a clone and applies to anyone working on the site. Apache 2.0 permits redistribution provided the
licence travels with it and modifications are marked; there are none to mark.

## Updating it

Re-copy from upstream and confirm the copy is clean:

```bash
cmp .claude/skills/frontend-design/SKILL.md "$UPSTREAM/skills/frontend-design/SKILL.md"
```

If a local change ever becomes necessary, Apache 2.0 requires a prominent notice in the modified
file saying so — and this README should stop claiming the copy is unmodified.

## The companion skill

`../pogotxk-design/` holds this project's own constraints — palette, accessibility floor,
licensing rules for imagery. The two are meant to be used together, and where they disagree the
project one wins. See `vault/Design System.md`.
