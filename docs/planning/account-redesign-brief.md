# The account redesign brief — "you're on the manifest"

Status: RATIFIED by the operator (2026-07-16), build in flight. Non-canonical planning per AGENTS.md; canon wins on conflict. Produced by three ideation passes — four persona walks, an IA/frequency architecture, and a visual-system kit — synthesized here into one buildable brief. The build standard is boil-the-ocean: every unit ships whole, with tests and docs, no deferral bucket.

## The diagnosis in one line

The account pages grew by accretion and are ordered by _when features shipped_, not by _what users touch_ — nothing any persona touches daily or weekly leads any view, the identity block repeats on every tab serving one persona once, and the most frequent action in the whole area (replay a saved finding) costs a page-hop.

## The law: frequency drives order, everywhere

One ranking governs the menu order, the default door, and every section order, most-frequent first: Recommendations (once it ships) → Galaxy → Saves → ChatDnB (once it ships) → Preferences → Profile → Sent → Email-verify → CLI → Export/Delete. Visual weight falls down the same ladder.

## The persona evidence (what the walks proved)

- **Nina (rec-engine signup, phone):** the promise that brought her ("it builds you a playlist") has no home anywhere on /account — churn driver #1. Until Recommendations ships, the default door must carry the promise (at minimum: the Friday newsletter offered where she lands).
- **Dev (returning DJ, weekly):** his whole account is Saves, which is neither the default nor playable in place. The single most frequent action in the area (hear a saved tune) requires leaving the page.
- **Kai (daily Galaxy player):** the game hub reads as a bank statement — identity chrome and lifetime totals above the play button.
- **Sam (screen reader):** the page's own heading/landmark tree offers no route between tabs; field hints aren't `aria-describedby`; the signup email input lacks `type="email"`; the repeated identity block is re-announced on every panel.
- **The frequency table's verdict:** everything in Settings is once-or-never for all four personas (correctly last); the identity block serves exactly one persona, one time (the "email stays private" line, first visit) — its durable home is beside the email field.

## The architecture (what lives where)

- **Identity has exactly one home: Settings → Profile**, as the avatar-led portrait plate. The masthead becomes **per-door wayfinding** ("The Galaxy" / "Saves" / "Settings" + one-line tagline) — with the in-page tab strip gone by ruling, the title must name the room. The crew-slot menu (avatar + name) is the global "who am I"; nothing else repeats it. The crew menu also gains an active-door marker (`aria-current`).
- **Galaxy (default door today):** scoreboard + Fly-the-Galaxy first, collection second — nothing above the fold that isn't game. Until Recommendations ships, a compact newsletter row patches the Nina promise gap.
- **Saves:** saved findings (playable, cover-led) then saved sets. Submissions leave: they're _sent_, not _kept_ — a **"Sent to Fluncle" status ledger** (own heading, badge register, no bookmark affordance) sits last; when Recommendations ships it graduates there as "Your sightings."
- **Settings, ordered by the operator's own precedent** (touched-more sits higher): Preferences (full) → Profile (full, avatar-led) → Email (a one-line row, `you@email · verified`, expanding only when unverified) → Link the CLI (receded disclosure) → Export & deletion (the fence). CLI and danger become structurally un-confusable (see the Fence Ladder).
- **Default-door transition:** Galaxy now; when Recommendations ships it takes bare `/account` and leads the menu; ChatDnB joins after; Settings pinned last; danger is never a door. The crew-slot's `future` flags already model this.
- **Loading architecture:** kill blank→pop. `loaderDeps` on `?tab`, the loader calls two `createServerFn`s (identity + the active door's data only) so first paint is SSR'd real content; react-query hybrid seeded from the loader (focus-refetch ON for Galaxy/Saves/Recs, OFF for Settings); skeletons shaped per-door appear only on client-side door switches; signed-out fetches nothing.

## The visual kit (the Fluncle-native answer to the shadcn exemplar)

**The Fence Ladder — enclosure encodes consequence.** The shadcn card's clarity (one concern, one boundary, its own save) delivered without glass: how many sides a concern prints says how much its boundary matters.

- **Class A · Full section** (frequent — Profile, Preferences): a two-sided crop bracket (rounded top-left L-rule in stardust), stamped header (Phosphor mark + bold sentence-case label), helper line, content, then an action rule with status left / Save right. **Save is outline at rest and ignites to gold only when the section is dirty** — stacked sections can never show two suns.
- **Class B · Compact row** (set-once — Email, Key notation): one divider rule, label left, value/control right; the control is the save.
- **Class C · Receded disclosure** (rare — Link the CLI): zero sides, folds, ghost summary; mono (Monaspace) only inside, quoting the command.
- **Class D · The fence** (danger — Export & deletion): four sides, red-keyed border, always open, destructive button behind a **typed confirmation** dialog. Two hard rules: a destructive act is never behind a disclosure; a disclosure is never boxed.

**The portrait plate.** The avatar is a 64px **square** mounted in the `.cover-frame` recipe (sun-lit edge, eclipse bleed) — your face mounted like a finding's cover, not a SaaS circle. Hover/focus reveals "Change photo"; upload is R2-backed (`avatars/<userId>.<ext>`, ≤512², presigned PUT, served via the `/cdn-cgi/image` ladder with a `?v` bust, optimistic local preview), following the album-artwork master's shape. Home: Settings → Profile (the IA's single-home rule wins over an every-tab band).

**The signature: the crew coordinate.** The account holder gets a mark on the Log ID spine — `<sector at join>·C·<ordinal>` (e.g. `241·C·07`) — the `C` middle slot as the crew tell, sibling to findings (`241·7·3A`) and mixtapes (`241·F·12`). Oxanium tabular, **cream never gold** (a crew member is not certified music), fixed for life. It is also the avatar fallback: no photo → the eclipse gradient with your coordinate stamped across it. Signature, identity, and empty state in one device. **Requires the operator's canon sign-off (it mints a new Log-ID sibling kind).**

**Galaxy as a voyage:** the three metric tiles become one first-person sentence with Oxanium inline numbers ("You've logged 24 stars across 3 galaxies, flown home 5 times, and been towed twice.") + the gold Fly CTA; per-galaxy completion meters (the `progress` primitive) on the collection; a fully-logged galaxy's tick is the gold note and the CTA drops to outline (one sun at a time). Zero-state guard stays.

**Saves as the workbench:** rows adopt the archive's TrackRow ignition grammar — Log ID leads in Oxanium, gold-veil hover wash, play via the `.preview-art` overlay on the cover (the `/api/preview` path; policy-clean), the whole row opens `/log/<id>`, remove/rename recede behind a `⋮` menu. Search + sort appear conditionally at power scale (>~40 findings), per the Quiet Surface Rule.

**Type & motion:** Oxanium only for coordinates and inline numbers; Space Grotesk for everything read; the area's one motion moment is section ignition (dirty→gold Save, gold-veil sweep on success; reduced-motion collapses to the color settle).

## Onboarding fixes (in scope)

Signed-out /account defaults to Create account (shipped); signup email input gains `type="email"`; field hints wired as `aria-describedby`; the claim-username dialog stops nagging (dismissal remembered per account, with the username prompt living durably in Settings→Profile); when Recommendations ships, the signed-out page becomes the seed-picker pitch (anonymous picks + previews; signing in saves — the never-gates law).

## Build units (each ships whole: implementation + tests + docs)

- **U1 · Loading foundation** — per-door SSR loader + `createServerFn`s + seeded react-query hybrid + per-door skeletons + error/retry. (The structural base; lands first.)
- **U2 · The account kit** — Section/CompactRow/Disclosure/Fence components + CSS, per-door masthead, crew-menu active marker.
- **U3 · Settings on the ladder** — reorder + email row collapse + CLI recede + fence + typed delete confirm + export download (shipped) polish.
- **U4 · Identity** — portrait plate, avatar upload end-to-end (R2 presign route, cap/validate, serve ladder, remove-photo), crew coordinate (pending sign-off), crew-slot fallbacks.
- **U5 · Galaxy voyage** — sentence scoreboard, collection meters, One Sun logic, newsletter promise-gap row.
- **U6 · Saves workbench** — ignition rows + inline play + ⋮ actions + conditional search/sort.
- **U7 · Sent ledger** — submissions out of keep-list, status badges, `logId` on approved submissions linking to the finding (DTO addition).
- **U8 · Onboarding & a11y** — the Sam fixes, claim-dialog durability, copy pass, canon-reviewer + a11y audit.

## The operator's rulings (2026-07-16)

1. **Crew number, not a coordinate.** A stamped ordinal (`Crew №007`, enlistment order) — deliberately NOT coordinate-shaped, so "coordinate" stays a location concept. Public profiles later at `/crew/<username>` (the handle is the slug; the number rides the profile). Bonus direction: stamp the crew number on the player's spaceship at game start — multiplayer setup.
2. **Voyage sentence** replaces the metric tiles.
3. **Portrait plate lives in Settings only** (option a).
4. **Inline play on saves via /api/preview** — yes.
5. **The newsletter promise-gap row is SCRATCHED** (the scenario was rejected: nobody recommends an unbuilt feature). Replacement ruling: **signing up auto-subscribes the user to the newsletter**, and Settings shows the subscription status with a re-subscribe option for the unsubscribed.

## Decisions for the operator before build (resolved above)

1. **The crew coordinate** — mint `·C·` as a Log-ID sibling kind? (Canon-level: LORE/DESIGN would record it.)
2. **Voyage sentence vs metric tiles** — the sentence is the recommendation; the tiles are your numbers as you know them.
3. **Portrait plate home** — Settings-only (recommended, per the identity-single-home law) vs an every-tab identity band.
4. **Saved-finding play** — inline preview via `/api/preview` (recommended) vs full `/log` embed.
5. **The newsletter promise-gap row** on the Galaxy door until Recommendations ships — yes/no.
