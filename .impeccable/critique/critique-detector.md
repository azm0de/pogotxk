# Critique — Assessment B (deterministic detector evidence)

Run 2026-09-01 on branch `impeccable-redesign` with `node ~/.claude/skills/impeccable/scripts/detect.mjs --json` per group, plus one text-mode run over `src`. Browser visualization skipped: no puppeteer installed; the Browser pane was reserved for Assessment A.

## Counts

| Group | Findings | Confirmed | Deliberate + documented | False positive |
|---|---|---|---|---|
| 1 home + chrome (`index.astro`, `Base.astro`, `PokeBall`, `SocialIcon`) | 0 (+1 advisory) | 0 | 0 | 0 |
| 2 operate islands (map, go, live) | 3 | 1 | 2 | 0 |
| 3 content hubs (events, raids, eggs, research, blog, game) | 2 | 1 | 0 | 1 |
| 4 quiet (about, conduct, privacy, terms, offline, account, auth, `legal.css`) | 4 | 3 | 0 | 1 |
| 5 admin (audit only) | 5 | 4 | 0 | 1 |
| 6 `global.css` | 0 | 0 | 0 | 0 |
| outside groups (`src/lib/markdown.ts`) | 1 | 0 | 0 | 1 |
| **Total** | **16** | **9** | **2** | **4** |

## Every finding

| Rule | File:line | Classification | Rationale |
|---|---|---|---|
| `em-dash-overuse` (advisory) | `src/layouts/Base.astro` | Confirmed, advisory | 24 em-dashes in rendered strings (meta description, alt text, sr-only copy) |
| `border-accent-on-rounded` | `src/components/map/MapView.css:315` | Deliberate + documented | Lines 295–309 explain the popup's top spine ties it to the pin colour; `overflow:hidden` + radius rounds its ends |
| `side-tab` | `src/components/go/QuickActions.css:63` `.go-note` | **Confirmed** | Undocumented callout, no companion non-colour signal |
| `side-tab` | `src/components/live/LiveBoard.css:264` `.flare` | Deliberate + documented | The skill's "colour is never the only signal" case; comment at 261–263; kind is spelled out in the badge. Soften, never remove |
| `side-tab` | `src/pages/events.astro:370` `.events-note` | **Confirmed** | Same callout family |
| `side-tab` | `src/pages/blog/[slug].astro:307` `blockquote` | False positive | Semantic blockquote convention |
| `side-tab` | `src/pages/conduct.astro:104` `blockquote` | False positive | Semantic blockquote |
| `side-tab` | `src/pages/auth/device.astro:280` `.status` | **Confirmed** | Callout family |
| `side-tab` | `src/pages/auth/error.astro:58` `.reason` | **Confirmed** | Callout family |
| `side-tab` | `src/styles/legal.css:33` `.legal-summary` | **Confirmed** | Callout family |
| `side-tab` | `src/components/admin/ImportPanel.css:57` | **Confirmed** (admin) | Callout family |
| `layout-transition` | `src/components/admin/ImportPanel.css:77` | **Confirmed** (admin) | `transition: width` on a progress bar |
| `side-tab` | `src/components/admin/MeetupEditor.css:113` | **Confirmed** (admin) | Callout family |
| `side-tab` | `src/components/admin/PostEditor.css:146` | **Confirmed** (admin) | Callout family |
| `side-tab` | `src/components/admin/PostEditor.css:341` `blockquote` | False positive | Semantic blockquote in markdown preview |
| `broken-image` | `src/lib/markdown.ts:270` | False positive | A regex source string (`LONE_IMAGE_RE`) |

## The callout family

Eight instances (`QuickActions.css:63`, `events.astro:370`, `device.astro:280`, `error.astro:58`, `legal.css:33`, `ImportPanel.css:57`, `MeetupEditor.css:113`, `PostEditor.css:146`) share one convention — `border-left` 3–4px + trailing-side radius + `--bg-sunken` fill — reused for status/callout boxes in four unrelated colours. Consistent with each other, undocumented, and the direction round should decide their replacement once (see `critique-quiet-pages.md` P2).

## Raw output

Saved under the session scratchpad `critique/` directory (`group1_home_chrome.json` … `group6_styles.json`, `advisory_text_src.stderr.txt`). Text-mode output goes to stderr by design.
