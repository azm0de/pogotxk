# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pokémon GO players in and around Texarkana, Texas and Arkansas. The primary scene is a phone held in one hand, outdoors, in daylight, often while walking through Spring Lake Park with the game open in the other app. A visit is a glance, not a session: find the next meetup, see what is on right now (a raid, a flare, a Community Day), locate a PokéStop or Gym, or get people to a gym in the next few minutes.

Secondary audiences, confirmed: the Ambassadors and moderators who run the Campsite and keep the map, meetups and news current; new players who found the community through Discord, a Gazette article or a Campfire link and want to know whether it is real and where to turn up; the Android bubble app, which opens `/go` from an overlay while the game is open.

## Product Purpose

PoGo TXK is the community site of the official Texarkana Pokémon GO Community Campsite at Spring Lake Park. It replaced a hand-maintained static site. It exists so that the people who play here can find each other and the park's PokéStops, Gyms and Power Spots without leaving the game for long, and so that the community's meetups, news, photographs and live activity have one durable, public, free home. Success is a player finding out what to do in the park today within seconds, a raid that gathers because someone raised a flare, and a first-timer turning up to a meetup because the site made the community legible.

## Positioning

The only place with a hand-surveyed, photographed map of every PokéStop, Gym and Power Spot in Spring Lake Park, plus a realtime flare board and Discord-native identity, that **never touches the game**. No screen capture, no accessibility scraping, no hooking, no GPS mocking, no Niantic or Campfire API scraping. A competitor could copy the layout; it could not truthfully claim the survey, the Ambassador status, or the no-touch rule.

## Operating Context

- Discord is the identity provider and where the community actually lives. Guild membership is the membership check; roles (member, ambassador, admin) come from Discord roles.
- Meetups are held in Spring Lake Park, Texarkana, on Texarkana local time (CDT/CST). The site is used at the park, at gyms across both Texarkanas, and at home when planning.
- The Android bubble app (sideloaded, not on Play) raises `/go` over the game. The PWA start URL is also `/go`. iOS cannot have a bubble; the PWA is the iOS path.
- Game data (raid bosses, eggs, research, the global event calendar) comes from Leek Duck via ScrapedDuck, cached; it can be stale and the site says how stale.
- Community photographs are published with their credits; several are Texarkana Gazette press photos.
- The site is a single Cloudflare Worker: Astro 7 SSR with React islands, D1, R2, KV and one Durable Object for the live board. Deploys happen on push to `main`.

## Capabilities and Constraints

Confirmed capabilities: the park map with filters, clustering, deep links and community-photo pins; a realtime flare board (raid, gym takedown, meet me here, remote invites, trade, need a hand) with RSVP and expiry; one-handed quick actions at `/go`; meetups and the global game calendar with ICS subscription; raid bosses, eggs and research; community news with RSS; a community photo gallery; Discord sign-in, device-grant sign-in for the app, self-serve account deletion; web push.

Constraints that bind every future design:

- **Never touch the game.** Live gym state, raid timers and player positions are not available and will not be worked around. Any design needing them is unbuildable.
- **No ads, no paywall, no tracking** on pages carrying Leek Duck data; visible credit to both Leek Duck and ScrapedDuck on those pages, outside any empty-state conditional.
- **Press-photo credits render on the image**, never as a caption beneath it.
- **Self-hosted everything**: fonts (woff2 with licence file beside it, no font CDN), map tiles (Protomaps in R2, credited to OpenStreetMap and Protomaps), artwork. Nothing licensed sits in `public/` unless it is meant to be reachable.
- **The official Pokémon GO logo is not used, anywhere.** Map markers are original SVGs, not game art.
- The basemap is always light, in both colour schemes: it is content people match against every other street map.
- Home page section order is set by the owner and changes only in markup, never with CSS `order`.
- Map pins are exempt from the 24px target rule (essential position); everything else is not.

Terminology: PokéStop, Gym, Power Spot (POI types); Campsite (the Community Campsite programme and the starred meetup spots); flare (a short-lived broadcast on the live board); Ambassador (Niantic's community-lead title, and a site role).

Explicitly undecided: an admin Settings page (social links, hero copy, theme colours); per-page OG images; a Play Store listing for the bubble app.

## Brand Commitments

- Name: **PoGo TXK** (long form: Pokémon GO Texarkana). Voice is plain, warm and specific, written from the player's side of the screen; it names places and times rather than selling.
- **The palette is a Poké Ball**: red top, white bottom, black band. Every red sits at hue 353–354° (green below blue), the ramp is AA-measured and tokenised in `src/styles/global.css`, and `--accent` inverts between themes while `--accent-solid` never does. Chosen by the owner on 2026-08-10 to replace the inherited navy and cream; the blues were not wanted. This is binding on any redesign.
- The existing TXK wordmark (`public/art/logo-txk-classic.webp`, `logo-txk-wide.webp`) remains a brand asset for OG images, app icons and wherever a world wants it, but the header and hero identity **may be re-expressed** from type and the Poké Ball mark (owner, 2026-09-01).
- Baloo 2 is the incumbent display face and is **not pinned**; a replacement must be self-hosted with its licence and hold the same register: rounded warmth without a kids'-app tone, a "serious collector tool" (owner, 2026-09-01; the Fredoka → Baloo 2 change records the register).
- The home hero (wordmark over the Eevee forest video, map beside it) is **not pinned**; the chosen direction's first viewport decides it, and the Niantic key-art heroes on Events, Raids and News are material a direction may use or retire (owner, 2026-09-01).
- The Poké Ball mark (`src/components/PokeBall.astro`) is ours and may be used freely. Social icons are each brand's own app icon, with no chip behind them.
- The site states, in the footer and on `/about`, `/terms` and `/privacy`, that it is unofficial fan work not affiliated with Niantic, Nintendo, Creatures or GAME FREAK.

## Evidence on Hand

- 104 surveyed POIs (66 PokéStops, 16 Gyms, 22 Power Spots, 24 starred Campsite spots) with descriptions, coordinates, and 63 place photographs that owe no credit and may be used decoratively (`kind='photo'`; 55 of 63 are portrait phone shots).
- 9 community photographs of people (`kind='community_photo'`), several Texarkana Gazette press photos with photographer byline, article title, date and link; credit must render on the image.
- The GO Fest 2026 group photograph with two art-directed crops (`public/hero/community-*.webp`) and a named photographer; the refuse bin in it must not be retouched out (it would mean inventing two real people's legs).
- Pokémon official artwork as trimmed WebPs (`public/art/`: Shiny Lucario, Mew, Magikarp, Moltres) on the fan-use position with no per-page credit obligation; Niantic marketing key-art in `public/hero/` (outing, raid-battle, pokestop, the Eevee forest video) on the same position.
- Live data: flares with kind, expiry and RSVPs; meetups; posts; the Leek Duck feeds with freshness.
- Absent, and not to be fabricated: testimonials, member counts beyond what Discord shows, sponsor or partner logos, any claim of Niantic endorsement beyond the Ambassador programme, prices.

## Product Principles

1. **Design for a glance in sunlight.** Large targets, high contrast in both themes, one job per screen, nothing that needs two hands.
2. **The park is the product.** The map, the flares and the meetups are the reason the site exists; artwork and chrome serve them, never the reverse.
3. **Truth over polish.** Show freshness, show who raised a flare, credit every photograph, name the sources; never imply live game state we do not have.
4. **Free and unofficial, and say so.** No ads, no paywall, no logo we do not own; the disclaimer is part of the identity.
5. **Colour is never the only signal.** Every state carries a word or a shape as well as a hue, so the site survives greyscale, colour-blindness and a cracked screen.

## Accessibility & Inclusion

WCAG 2.2 AA is the floor, verified by measuring computed contrast on rendered pages in both colour schemes, not by reading the CSS. Text ≥ 4.5:1 everywhere; standalone links and controls ≥ 24px (in-sentence links exempt; map pins exempt as essential-position targets); every animation has a `prefers-reduced-motion` escape; keyboard focus is always visible; decorative images take `alt=""` and meaningful ones real text; no horizontal scroll at 375px on any route. The audience includes players of all ages and teams; nothing in the interface should require colour vision, fine motor precision, or a second hand.
