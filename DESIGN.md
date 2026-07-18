---
name: Fluncle
description: Drum & bass bangers from another dimension, archived under a burning eclipse.
colors:
  eclipse-gold: "#f5b800"
  eclipse-glow: "#ffd057"
  gold-veil: "#f5b8001a"
  ink-on-gold: "#151006"
  deep-field: "#090a0b"
  sleeve-black: "#10100d"
  tape-black: "#171611"
  starlight-cream: "#f4ead7"
  stardust: "#b7ab95"
  dust-veil: "#d0b9901a"
  dust-line: "#d0b99029"
  reentry-red: "#ff6b57"
  nebula-violet: "#ab7bff"
  nebula-veil: "#ab7bff1a"
typography:
  display:
    fontFamily: "Oxanium, ui-sans-serif, system-ui, sans-serif"
    fontWeight: 800
    letterSpacing: "-0.02em"
  numeric:
    fontFamily: "Oxanium, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.98rem"
    fontWeight: 400
    letterSpacing: "-0.02em"
    fontVariation: "tabular-nums"
  title:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.02rem"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 400
    lineHeight: 1.25
  label:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.76rem"
    fontWeight: 700
  mono:
    fontFamily: "Monaspace Krypton, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  artwork: "6px"
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
spacing:
  row-gap: "0.9rem"
  row-pad-y: "0.95rem"
  row-pad-x: "1rem"
  stack-gap: "0.5rem"
components:
  button-primary:
    backgroundColor: "{colors.eclipse-gold}"
    textColor: "{colors.ink-on-gold}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0 0.625rem"
  button-primary-hover:
    backgroundColor: "{colors.eclipse-glow}"
  button-outline:
    backgroundColor: "#1716114d"
    textColor: "{colors.starlight-cream}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0 0.625rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.starlight-cream}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0 0.625rem"
  input-text:
    backgroundColor: "{colors.tape-black}"
    textColor: "{colors.starlight-cream}"
    rounded: "{rounded.md}"
    height: "2.5rem"
    padding: "0 0.75rem"
  track-row:
    backgroundColor: "transparent"
    padding: "{spacing.row-pad-y} {spacing.row-pad-x}"
  track-row-hover:
    backgroundColor: "{colors.gold-veil}"
---

# Design System: Fluncle

## 1. Overview

**Creative North Star: "The Nostalgic Cosmos"**

This music projects your mind out into the cosmos: another dimension, a parallel universe. The cover art is the founding document of the system: a figure floating up out of the tower blocks into a starfield, tethered to a Discman by a headphone cable, under a burning eclipse. Every visual decision descends from that image. The mood is awe and melancholy at once, "where did we come from" and "where do we go", floaty, atmospheric, transcending. Never nihilist, never cold; the dark is warm and inhabited, the way a city night is.

The interface is a traveler's logbook, not a marketing page: Fluncle moves through time and space and logs what he finds, and every surface is one of those findings sent back across the Galaxy. The cover art literally sits behind every screen (a fixed, half-opacity backdrop), and the UI is built as translucent panes over it: you are always looking through the interface into the cosmos. Eclipse Gold is the single light source, the sun on the horizon and the lit windows in the towers. Starlight Cream is the print on an aged record sleeve. There are no heroes, no metrics, no pitch; the archive of findings IS the page.

This system explicitly rejects SaaS dashboards, bright streaming-app clones, generic landing-page hero sections, oversized marketing copy, glassy card stacks, and decorative gradients that ignore the cover art (PRODUCT.md's own words). It rejects, equally, the cold sterile sci-fi log: the Galaxy is warm and crewed. Dark-only, music-first, operator-curated.

**The Light-Years Rule.** Every artifact in this system arrives lossy because of how far it travelled: grain over the sun, compression in the video, glitch and dither, the worn edge of a recovered record. The degradation is narrative, never sloppiness — it is the cost of light-years, the reason a finding from the edge of the map looks the way it does. Grain and lossy texture are therefore load-bearing brand, not decoration; a surface rendered too clean reads as fake. But grain is a SIGNATURE, not a fixed heavy wash — its AMOUNT and FORM are the artifact's own: heavy on a far-travelled relic, near-silent where a clean, electric finding wants its pop. An over-applied grain flattens the very pop it should protect; let the piece set the weight (the boil stays lively — each grain family its own rate, never crawled to game the gate — see the fluncle-video skill). (The video kit in `packages/video` is built entirely on this rule; VOICE.md borrows it for copy.)

**The grain architecture.** Dense grain lives UNDER content, never as a veil over reading text: baked into the cosmos backdrop (overlay-blended into the cover image), as pane-tooth on plate surfaces (a whisper under the content layer), and at full density only where there is no text to protect (the cover-frame mat, the artwork fallback's halftone, scanlined empty/loading states). One shared inline-SVG noise tile (`--grain-tile`) feeds every layer — zero network requests. AA (4.5:1) is verified against what is actually behind the text, texture included (The Legible Sky Rule).

**Recurring motifs.** The system returns to a small set of forms — its visual DNA, drawn from the cover art and from the operator's own collages that predate Fluncle by years (collected in the video moodboard, `packages/video/moodboard/MOODBOARD.md`). They map straight onto the narrative: the **centered orb** (the burning eclipse, the sun the traveler moves toward); the **lone figure against vastness** (the traveler himself, the floating astronaut — alone out there, never lonely, because the crew travels with him); **portal / threshold framing** (the crossing between dimensions); **vertical mirror-fold symmetry**; the **tower skyline** as an optional earthbound pole (the home you floated up from, used only when a piece wants the pull of the ground); and **grain over warm near-black** everywhere (its weight the composition's own, not a fixed heavy wash). That this imagery was already the operator's instinct years before the project is why the brand reads as inevitable, not styled.

**Key Characteristics:**

- Dark-only; the cover-art starfield shows through every surface
- One light source: Eclipse Gold for the primary action, focus, and identity
- Glass as doctrine, not decoration; depth from translucency, never shadows
- Oxanium speaks for the brand (numerals, marks); Space Grotesk does the reading
- Floaty and tactile: hovers lift gently, presses land
- Lossy by design: grain and compression are narrative texture, not noise (The Light-Years Rule)

## 2. Colors

A night-sky palette lit by one sun: warm blacks, sleeve-paper cream, and a single committed gold.

### Primary

- **Eclipse Gold** (#f5b800): The burning sun of the cover. The primary button, the focus ring, the brand wordmark, the active edge of artwork on hover. It is identity, action, and light all at once.
- **Eclipse Glow** (#ffd057): Gold heated one step brighter; text sitting on gold-tinted veils (accent foreground, hover indices).
- **Gold Veil** (#f5b8001a): Eclipse Gold at 10%; the hover wash on track rows and the confirmation tint. Light falling on a surface, not a surface itself.
- **Ink on Gold** (#151006): Near-black text reserved for gold backgrounds.

### Neutral

- **Deep Field** (#090a0b): The night sky. The body background under the cover-art backdrop; the deepest layer of the system.
- **Sleeve Black** (#10100d): Cards, popovers, the playlist shell base. The record sleeve in shadow.
- **Tape Black** (#171611): Inputs and secondary surfaces; one warm step up from the sleeve.
- **Starlight Cream** (#f4ead7): The primary ink. Aged liner-note paper; every reading surface uses it against the warm blacks.
- **Stardust** (#b7ab95): Muted ink for artist lines, dates, column headers, and placeholders. Warm, never gray.
- **Dust Veil** (#d0b9901a): 10% cream-dust tint for muted fills and artwork fallbacks.
- **Dust Line** (#d0b99029): 16% cream-dust borders and dividers; the only edge treatment in the system.

### Tertiary

- **Re-entry Red** (#ff6b57): Errors and destructive actions only; the heat of coming back down. Also blended at low opacity into the cover-frame gradient.
- **Nebula Violet** (#ab7bff): The live-set colour, and the only second light in the system. Reserved exclusively for the cross-surface live-set callout — Fluncle on the decks, live on Twitch — and never used for anything else. Complementary to Eclipse Gold (yellow and violet pair across the wheel) and Twitch-adjacent without quoting Twitch's own purple. Clears WCAG AA on the warm blacks (6.6:1 on Deep Field, 6.0:1 on Tape Black). Its 10% veil is **Nebula Veil** (#ab7bff1a), the wash behind the live banner.

### Named Rules

**The One Sun Rule.** Eclipse Gold is the single light source. It appears as the primary action, the focus ring, and identity moments, and on no more than roughly 10% of any screen. Two gold elements competing in one view means one of them is wrong.

**The Live Exception.** There is exactly one sanctioned second light: Nebula Violet, and only while Fluncle is live on the decks. The live-set callout is the one loud, ephemeral beat in an otherwise gold-and-dark product — it appears across every surface the moment the Twitch stream goes on and clears itself the moment it ends, so the violet is present only for the duration of a set and nowhere else. Outside that callout the One Sun Rule holds absolutely: no violet in everyday UI, ever. The exception proves the rule by being rare. Three sub-rules keep it coherent with the rest of the canon: the callout still obeys **The Legible Sky Rule** — its banner is a near-opaque warm-dark pane (more opaque than the standard plate, since it rides over the brightest backdrop region), the violet carried by the accents, never by a translucent wash that lets the cosmos break contrast; its live pulse is the **one sanctioned ephemeral third movement** beyond the "exactly two" ambient budget (§5), allowed only because it exists solely while live and is reduced-motion-gated; and its CTA obeys **The Ignition Rule** in violet — it heats to a Nebula-Violet fill on hover (dark ink on top), it never dims.

**The Warm Dark Rule.** Every black and every neutral leans warm (toward the cream/dust hue). Cool grays and blue-tinted darks are prohibited; the night sky of this cosmos is warm and inhabited.

**The Ignition Rule.** Gold is placed like light, never applied like paint — and interaction HEATS it. One directional Eclipse-Gold bloom anchors where the cover's sun sits (under every pane, breathing imperceptibly over ~48s, reduced-motion-gated); frame edges are lit from the sun side; hovers ignite toward Eclipse Glow (the primary button brightens, quiet controls catch the Gold Veil and their text glows). A control that DIMS on hover is wrong: the sun does not dim when you reach for it. The One Sun budget (~10% of any screen) still governs the total.

**The Unlit Rule.** Eclipse Gold is the **certification light**. A row Fluncle never certified is never lit by it: no Gold Veil hover, no gold coordinate, no gold heat. It catches the **Dust Veil** instead — the cold light of a thing seen from a distance rather than visited. The one exception is the **focus ring**, which stays Eclipse Gold on every interactive element, because focus is an accessibility affordance and not a claim about the music. The rule's companion is a silence: an uncertified row is distinguished **visually and never verbally** — no label, no badge, no noun, and no heading that names the tier. In a **mixed list** a heading may name the **superset** ("Tracks" — true of every row under it), and a block of findings may carry the archive's own name ("Fluncle's Findings"), because a finding is a named object; a homogeneous uncertified block stays unheaded. It is not introduced as a tier, because it is not one the reader is ever asked to learn. **"Finding" remains the only named object in Fluncle's world.** (First carried by search, `apps/web/src/components/search/search-command.tsx`; the same register governs every future surface where uncertified tracks appear.)

**The Retint Rule.** Fluncle absorbs outside visual influence by stealing the technique and recoloring it to canon. Any reference — a halftone, a scanline, a liquid gradient, a gel split, a mirror tiling — is fair game for its craft, but it arrives in off-canon hues (broadcast blue, phosphor green, candy pink) and leaves in ours: warm dark ground, Eclipse Gold as the one light, Re-entry Red as the heat accent, Starlight Cream as the ink. Cool hues survive only as minor counter-accents, never a field. The technique is the reference; the palette is always ours. (This is the operating rule of the video moodboard, `packages/video/moodboard/MOODBOARD.md`, and the visual sibling of "briefs are subordinate to canon" — take the idea, translate it into Fluncle's terms.)

## 3. Typography

**Display Font:** Oxanium (SIL OFL, self-hosted; with ui-sans-serif, system-ui fallback), weights 200–800
**Body Font:** Space Grotesk (SIL OFL, self-hosted; with ui-sans-serif, system-ui fallback), weights 300–700 — 700 is its ceiling, so no body-face role may ask for 800
**Mono Font:** Monaspace Krypton (GitHub Next's mechanical mono, SIL OFL, self-hosted; with ui-monospace, SF Mono fallback), weights 400 + 700

**Character:** Oxanium is the voice of the artifact: a squared, techy face that reads like the printing on a Discman, used for the wordmark, track numerals, and brand moments. Space Grotesk carries the reading: a geometric grotesque with just enough oddness in its details to sound like Fluncle rather than like a settings screen, while still disappearing when you are scanning metadata. Monaspace Krypton is the machine's own voice on the terminal surfaces (the "for the nerds" faceplate, the CLI/SSH dialogs): a mechanical mono that signals "real tool" without shouting. The pairing is "machine label + plain reading + terminal", not a typographic performance.

**All three faces are SELF-HOSTED, and that is a rule, not an implementation detail.** Riding the system stack meant the body face — and therefore every mixed-font alignment on the page — was a different typeface with different metrics on macOS, Windows and Android. Three renderings, only one of which we had ever looked at.

### Hierarchy

- **Display** (800, ad hoc sizes, -0.02em): Oxanium, reserved for brand marks and the plate mastheads. The one sanctioned large on-page heading is a masthead nameplate (a brand-mark plate: the stamped FLUNCLE'S FINDINGS lockup on the home plate, the coordinate on a log plate); body headings stay quiet, and the cover art remains the hero image.
- **Numeric** (400, 0.98rem, -0.02em, tabular-nums): Oxanium track indices (#01, #02). Always tabular.
- **Title** (700, 1.02rem, 1.18, -0.01em): Track titles. Bold cream against the dark; the loudest text on the page. 700 is Space Grotesk's heaviest cut — a rule asking for 800 would silently clamp here, so the canon asks for what the face can actually give.
- **Body** (400, 0.9rem, 1.25): Artist lines, descriptions, form text in Stardust or Starlight Cream.
- **Label** (700, 0.76rem): Column headers and form labels. Bold and small, never uppercase-tracked.
- **Mono** (400/700, 0.82rem, 1.5): Monaspace Krypton, reserved for the terminal surfaces: the "for the nerds" faceplate legend (700) and its items, the CLI install command, and command examples. The machine's own voice, quoted verbatim.

### Named Rules

**The One Voice Rule.** Oxanium speaks only for the brand and the numbers, and mono speaks only for the machine (literal commands and code). If body copy or a paragraph is set in either, it's a mistake.

**The Tabular Rule.** Every number that sits in a column (indices, dates) is tabular-nums. Numbers that jitter on update break the instrument-panel calm.

**The Canon Travels Rule.** These three faces are the brand on EVERY surface that renders text, not just the web app — the Remotion videos, the OG cards, the mixtape covers, the live glass, the extension. A rendered artifact that falls back to the system sans is off-brand in the place the brand is most visible: the video is what lands on TikTok, and the OG card is what lands in a link preview. Because a render environment has no system fonts to inherit and no stylesheet to cascade from, each one must EMBED the faces itself — and must carry the One Box Rule's metric overrides with them, or the type drifts out of alignment exactly where it cannot be inspected. (This rule exists because the brand HAD drifted: the video set its coordinate in Oxanium and its title in whatever sans the renderer happened to have.)

The exemptions are the surfaces we do not control the type on, and they are the only ones: a TTY (the SSH terminal has no fonts), Raycast's own chrome, an HTML email (clients will not load a webfont — those fall back to the system stack by necessity), and baked bitmap lettering inside a sprite.

**The One Box Rule.** Every self-hosted face is normalised at `@font-face` — via `ascent-override` / `descent-override` — to the SAME 1.25em metric box, cut so that `ascent − descent` equals that face's cap height. This puts each face's cap band exactly on its own box centre, which is what makes a plain `align-items: center` optically centre text of mixed faces and mixed sizes: a coordinate beside a title beside a date, all landing on one centre line, at any size, on any platform.

Without it, the fonts disagree. Oxanium ships a 1.00em box around a 0.69em cap height, so its cap band sits 0.055em BELOW its own box centre — it throws its own text off-centre before anything is set beside it. Centring the boxes then visibly fails to centre the text, and the only alternatives are `text-box-trim` (which cuts the box to the cap line, so descenders and round-glyph overshoot fall outside it and any `overflow: hidden` shears them) or per-element pixel nudges. Fix the font, not the elements.

When adding or updating a face: read its real `hhea`/`OS/2` tables (fontTools, not the renderer), confirm `USE_TYPO_METRICS` is set so Windows reads the same box as macOS, recompute the overrides for the 1.25em box, and check the deepest descender still fits inside the overridden descent.

**Where there is no `@font-face`, bake the box into the font.** Satori — the renderer behind the OG cards and the mixtape cover — has no `@font-face` and no stylesheet; it reads each font's own `hhea`/`OS/2` tables, so the CSS overrides above cannot reach it. The remedy is the rule's own ("fix the font, not the elements"): `apps/web/scripts/cut-satori-fonts.py` cuts static, latin-subset TTFs from the upstream variable fonts with the SAME ratified metrics patched INTO the tables, and the Worker bundles those bytes. Satori also synthesizes nothing — one buffer per weight, and a weight the markup asks for but nobody registered snaps silently to the nearest face. Registering exactly the weights the markup uses is therefore part of embedding a face, not a detail.

## 4. Elevation

Depth in this system comes from translucency, not shadows: every raised surface is a pane of glass over the cosmos. The playlist shell and cover frame use `backdrop-filter: blur() saturate(125%)` over the fixed cover-art backdrop, so what shows through the surface IS the elevation cue. Edges are defined by 1px Dust Line borders. Box-shadows are effectively banned (the sole exception is the hairline `shadow-xs` baked into the outline button); focus is a ring, hover is a veil, depth is the sky behind the glass.

### Named Rules

**The Through-the-Glass Rule.** Surfaces are windows onto the cosmos. A surface that fully occludes the backdrop (opaque, blurless) must justify itself; a surface with a drop shadow is prohibited outright.

**The One Pane Rule.** Glass does not stack on glass. Every pane sits directly on the cosmos, never on another pane (PRODUCT.md bans "glassy card stacks" by name); content inside a pane sits flat on it. On the web the pane is **the plate** (below): one document per page, with the cover frame, the list, and the nerd card mounted flat on it as printed fields — none of them carries its own glass.

**The Legible Sky Rule.** Text never sits on the raw backdrop. Every text surface is a pane that dims what it covers enough to hold WCAG AA (4.5:1 for body text), even where the burning sun sits behind the glass. If a bright backdrop region breaks contrast, the pane gets more opaque, not the text dimmer. The one surface with no pane to dim — the radio's live narration captions over full-bleed footage — meets the same AA floor by inverting instead: the line blends `difference` against the footage, so the glyphs always read as the photographic negative of whatever is behind them (a bright sun computes to dark ink, a black seam to bright ink) and stay legible on every frame. The spoken word stays the lit point: it breaks out of the blend to a true Eclipse-Gold glyph (the heat the eye tracks), never an inverted hue.

## 5. Components

Floaty and tactile: controls lift gently on hover (artwork scales to 1.06, carets drift 2px), and land on press (buttons translate down 1px). Motion is 150–180ms, eased out. The ambient budget is exactly two movements, both imperceptible and both gated to `prefers-reduced-motion: no-preference`: the 72s cosmos drift and the ~48s sun-bloom breath (The Ignition Rule) — "quiet" is not a frozen JPEG, and nothing else moves uninvited. Under `prefers-reduced-motion: reduce`, the floats are grounded and the ambient pair stops: no scale, no drift, no press-down, no breath; every state change collapses to a color-only transition. The Gold Veil wash and index heat carry the feedback on their own.

### Iconography

Two icon families, split by role and never crossed. **Interface icons** — actions, status, navigation, affordances, the board's step glyphs — come from **Phosphor**, the system's single interface set; they're sized to the text and take a weight that matches their state (regular when idle, fill when active). **Platform logos** — Spotify, YouTube, TikTok, and every third-party brand mark — come from **`simple-icons`**, the official marks, rendered through `BrandIcon` inline (as the Spotify mark is) or a small wrapper component (`@/components/platform-icons`) where an icon-component slot expects one. A platform's identity is its own: we quote the real mark, never a Phosphor lookalike and never a hand-redraw. Brand marks have one fixed form — they fill `currentColor` and ignore weight — so they still inherit the surface's ink and obey the One Sun budget like every other glyph.

### Buttons

- **Shape:** Gently rounded (0.5rem radius), 2.25rem tall (h-9), small text (0.875rem, weight 500), icon + label with 0.375rem gap
- **Primary:** Eclipse Gold fill with Ink on Gold text; hover ignites to Eclipse Glow (The Ignition Rule — never a dim)
- **Outline:** Dust Line border over translucent Tape Black (30%); hover catches the Gold Veil, heats the border toward gold, and ignites the text to Eclipse Glow
- **Ghost:** Transparent; hover catches the Gold Veil with Eclipse Glow text
- **Destructive:** Re-entry Red at 10–20% fill with Re-entry Red text, never a solid red slab
- **Hover / Focus / Active:** Focus is a 3px Eclipse Gold ring at 50% with a gold border; active presses the button down 1px (the tactile landing)

### Cards / Containers

- **Corner Style:** 0.625rem radius (the `--radius` base)
- **Background:** Sleeve Black at 48% with 18px backdrop blur (the playlist shell); falls back to 86% opacity without backdrop-filter support
- **Shadow Strategy:** None; see Elevation. Edges are 1px Dust Line
- **Internal Padding:** Rows at 0.95rem × 1rem; grids gap at 0.9rem

### Inputs / Fields

- **Style:** Tape Black fill, 1px Dust Line border, 0.5rem radius, 2.5rem tall, small cream text
- **Focus:** Border shifts to Eclipse Gold plus a 3px gold ring at 40%
- **Error:** Message text in Re-entry Red below the field

### Track Row (signature component)

The core unit of the product — a **finding**, not just a row. A CSS grid (an Oxanium tabular **Log ID** column, 3.25rem album artwork, `1fr` content block, caret): the Log ID (the finding's coordinate in the Galaxy, e.g. `241.7.3A`) stands where a plain row index used to, then 3.25rem album artwork (6px radius, 1px border), an extrabold **Artist — Title** line over a Stardust label-and-year line, a quiet chip row (duration first, then BPM, key, tags), and a caret. The music still leads the eye; the Log ID frames it as an entry in Fluncle's logbook, and it already carries the Found date in its coordinate, so the compact row drops the explicit date (it lives on the log page; VOICE.md's Found Rule). The whole row is one link to the finding's **`/log/<id>` page** — listening moves to the log entry's Spotify button, keeping the visitor on fluncle.com (a bare-ordinal straggler with no Log ID falls back to a Spotify link). Hover/focus washes the row in Gold Veil, heats the Log ID to Eclipse Glow, scales the artwork to 1.06 behind a gold-tinted border, and drifts the caret 2px right. Rows separate with Dust Line borders at 72%; the last row drops its border. Artwork fallback is a gold-to-red gradient over Dust Veil, echoing the eclipse. (The Log ID column is wider than the old index; size it to the coordinate format, kept tabular so it never jitters.)

Pagination lives inside the list, never below the shell: a quiet load-more row (Stardust bold text, Gold Veil hover) doubles as an intersection sentinel that auto-fetches near the bottom. It disappears when the archive is exhausted; the layout below the pane never shifts.

### Checkpoint Row (the mixtape)

A **mixtape** — a recovered DJ set, Fluncle dreaming (PRODUCT.md; the [fluncle-mixtapes skill](./packages/skills/fluncle-mixtapes)) — renders as a quiet variant of the Track Row, not a new component. Same grid skeleton: the Oxanium tabular **Log ID** column (its middle slot is the literal `F`, never a digit — the only tell, and the mark keeps the finding's `<digit><letter>` shape), the artwork tile, the `1fr` content block, the caret. But it reads as a **checkpoint, not a finding**: its own mixtape cover, and a title block of the mixtape name over a Stardust line carrying the member count and run time (`12 findings · 58 min`) in place of the BPM/key/tags chip row. It stands apart without shouting — the ground is a darker, more transparent pane that lets more of the cosmos starfield show through than a finding row does (deeper out, a still point), held to the Warm Dark and Legible Sky rules, with no second sun and no louder gold. It sits flat on the plate with no glass of its own (One Pane), and it does not count toward the rotated FOUND stamp. Hover/focus matches the Track Row (Gold Veil wash, the Log ID heats to Eclipse Glow, the caret drifts 2px); the whole row links to the mixtape's `/log/<id>` compilation page.

### Graph Link (signature component)

The archive is a **graph** — log ↔ artist ↔ label ↔ album ↔ galaxy — and every node has a page. So wherever a surface NAMES one of those nodes, the name is a Graph Link: one component (`@/components/graph-link`), one style, one behaviour, everywhere. Never a bespoke link per surface. An entity name left as plain text on any page is a bug.

**At rest** it is Starlight Cream under a **dotted** underline: legible as a link, quiet as text. **On hover/focus** it heats to **Eclipse Glow** and the underline goes **solid**.

**The ink is the host's when the host has one.** Cream is the ink of a name in _reading_ text. Two hosts already own their register and keep it: a **chip**, and the **Track Row's Stardust imprint line** (a cream imprint there would invert the row's hierarchy and pull the eye off the music). On those, only the resting colour defers — the dotted underline is the whole affordance, and the heat is unchanged.

**It is not gold at rest, and this is load-bearing.** Eclipse Gold is the One Sun — the primary action, the focus ring, identity — capped at roughly 10% of any screen. A `/log` page already spends its gold on the Listen CTA, the coordinate, and the FOUND stamp. Graph links that were gold at rest would turn the page into a field of suns and the actual CTA would stop leading. Cream-at-rest → gold-on-hover is **The Ignition Rule** applied to a link: gold is placed like light, and interaction HEATS it. The budget survives and the link still announces itself. Both states clear WCAG AA on the warm blacks, so neither is decoration.

**The card** is a printed card on the plate, not a third pane over it: **Tape Black, fully opaque, a Dust Line hairline, no blur and no shadow.** All three are canon, not taste — glass does not stack on glass (**One Pane**), a surface with a drop shadow is prohibited outright (**Through-the-Glass**, so it kills the `shadow-md` its Shadcn popup ships with), and being opaque means nothing of the cosmos or the sun-bloom sits behind its text, so its contrast is exact (**The Legible Sky Rule**). It is therefore _not_ one of The Plate's two sanctioned floaters — it is ink on paper.

Hovering or focusing a graph link reveals it — a Shadcn `HoverCard` on a deliberate **~450ms delay** (Wikipedia's hover intent — a cursor crossing a paragraph must never fire one). It carries what the entity page's masthead carries, from the same source, by construction: a galaxy's intro line (`lib/graph-prose.ts`), or — for artist/label/album, whose first-person signature lines the Three Areas Rule retired — the entity's factual dossier bio; plus a few finding covers and the finding count. It **invents no sentence** and it is the sole source of nothing: everything in it also lives one click away, on the page. The card carries **no gold at all** — it is a preview, not an action, and must not spend the One Sun budget just by existing.

- **Keyboard:** focus opens the card, Escape closes it, Enter follows the link. The card is never focus-trapped and never in the tab order — a reader tabbing through a paragraph is never detained by a preview.
- **Touch:** the card does not open. A tap is a navigation, full stop.
- **Reduced motion:** the card appears without the fade/zoom. It arrives; it does not animate.
- **Data:** the LINK is free (the slug rides in on the same read that loaded the finding, so links render server-side with the page). Only the CARD is lazy — fetched on open, cached per entity, so every link naming the same imprint shares one request.

**Two skins, one component.** `inline` is the canonical one above (a name inside reading text). `chip` is the same link, the same route and the same card worn by a host that already draws its own affordance (an avatar chip, an adjacent-galaxy tile): no underline, because a chip is not a word in a sentence, and the host's hover state does the heating. There is never a second component.

**Where it does not go**, and these are rules, not oversights:

- **Inside a link.** The `Artist — Title` caption on a cover tile, a feed row's title line, a "Close in sound" row — each of those already sits inside a link to the finding, and a link inside a link is not a thing. There, the name is a **caption**, not a mention: the tile's job is to open the finding.
- **Inside a listbox.** The search palette's rows are `role="option"`; a nested interactive control breaks the listbox contract. The palette already IS entity navigation.
- **Inside a player.** Stories and the radio are the cinematic register — a transport, not a page. Both bind Escape and the arrow keys to playback, and a preview card has no business fighting them.

### CLI Command

Literal terminal content in a quiet box: mono text (0.82rem) on Tape Black with a Dust Line border (0.5rem radius). Long commands scroll horizontally behind a thin Dust Line scrollbar (`scrollbar-width: thin; scrollbar-color` themed), never a native white one. A copy action (outline icon button) sits beside the install command; the check-mark confirmation flashes Eclipse Gold.

### The Plate (signature surface)

The page itself: a recovered logbook plate, one printed document per surface (the home archive, a `/log/<id>` entry, the log index, About). Its grammar: a **masthead** — on a LORE page with the stamped nameplate (Oxanium caps, the brand-mark plate; the nameplate is lore-area-only per the Three Areas Rule) and a quiet tagline, elsewhere the title alone; a rotated gold **FOUND stamp** carrying the archive count; **crop-mark corner brackets** and a **register cross** printed just inside the edge (pure background gradients — zero DOM); a **double-rule frame** (border + offset outline, the printed edge); and **pane-tooth grain** on the surface, under the content. Fields on the plate (the list, the nerd box) are flat translucent panels, not nested glass. Two surfaces are sanctioned to float above a plate: the dialog (Stories) and the behind-the-scenes drawer (The Behind-the-Scenes Drawer, below).

### Cover Frame (signature component)

The identity anchor: the cover art mounted flat on the plate, wrapped in a frame whose edge is LIT from the sun side (top/left border heated toward gold) over a bent warm gradient (a radial falloff from the sun corner, gold into Re-entry Red) with grain blended in. The eclipse colors bleed into the frame; the artwork stays untouched. No glass of its own (One Pane).

### Named Rules

**The Readout Rule.** Every track-shaped surface — the Track Row, a chat Finding Card, a recommendation row, a picker candidate, any future card that names a track — carries the finding's instrument readout: the chip row (duration first, then BPM, then key) and the release year on its metadata line, wherever the data exists. The chips are how a DJ reads a record at a glance; a track presented without them is a title, not a finding. A missing chip is a data gap upstream (an uncaptured row has no BPM yet — honest absence), never a layout choice: the surface renders every chip the row can back, and drops only what the data cannot. (Ratified 2026-07-17 off the /recommendations pass, where the catalogue rows shipped bare.)

**The Quiet Surface Rule.** A surface shows only what's read or used often; everything rare recedes behind a disclosure — a coordinate that carries the date so the row needn't repeat it, pagination folded into the list, an infrequent action behind a `⋮` menu, hover-card, or dialog. Disclosure is not hiding; it's letting the signal sit uncrowded. This governs both registers: the public Track Row drops the Found date and buries load-more in the list; the operator's admin surfaces put requeue/purge/link-editing behind menus and dialogs (the disclosure law, `docs/admin-shell.md`). Density grades by surface; the instinct to quiet the surface does not.

**The Three Areas Rule.** (Supersedes the Workbench Rule's two-kind model, ratified one day earlier — the catalogue demanded its own ground.) Pages stand on one of three areas, and the area decides the masthead, the register, and how much fiction the page carries. **Lore pages** (the home log, `/log` entries, `/logbook`, `/galaxies`, `/mixtapes`, `/stories`, `/radio`, About, the newsletter): the fiction is the content — the full plate grammar, the stamped nameplate, first-person prose; this is where the archive speaks. **Catalogue pages** (`/artists`, `/albums`, `/labels`, `/fresh`, and their entity pages): reference shelves — the title alone heads the plate (no nameplate, no first-person intro, no signature line), the index intro is one factual line carrying the page's real nouns, and Fluncle appears as data (Found dates, counts, the findings) plus the third-person dossier bio; these pages carry the wiki/SEO weight. **Workstations** (`/mix`, `/recommendations`, `/chat`, `/account`, `/galaxy`, and the console pages `/status`, `/reach`, `/pipeline`, `/docs`, `/privacy`): the reader does something, and the interface carries the meaning — no nameplate, no narration, helper paragraphs and lore sub-lines are clutter by definition. The recipe-blog test still governs workstations: if the work sits at the bottom of a page of story, the page is wrong — the recipe IS the page. What survives there: the artifact header, uniform rows, one gesture per row, and the ONE line a state genuinely needs (a disabled action's reason, an empty state's how-it-wakes). Numbers contract (`9/12`), and meaning moves from sentences into marks — the register rides the light (The Unlit Rule), it needs no label. The Galaxy game keeps its lore art; the area rule governs chrome and copy, never paint. (VOICE.md §5 "The Three Areas" is the language half of this law.)

**The Behind-the-Scenes Drawer.** The sanctioned surface for a "how it was made" disclosure: the for-the-curious machinery behind one specific artifact, opened from that artifact's own public page (`/pipeline` is the site-wide machinery view; this is the per-artifact one, and it obeys The Quiet Surface Rule — offered to the curious, never front-of-house). Its trigger is a quiet **ghost** button beside the artifact it explains, first-person and plainly labelled (the exemplar reads "How I made it"), carrying a Phosphor interface icon, and gated to render only when the underlying data exists — an empty drawer never ships. The surface is a **Sheet sliding from the right, dressed as a plate**: the plate's glass recipe (`--card` at ~48% under backdrop blur/saturate, an ~86%-opaque fallback), no drop shadow (The Through-the-Glass Rule holds — §4), the Dialog's `ring-1 ring-foreground/10` carrying the edge in its place, and the slide grounded under `prefers-reduced-motion: reduce`; on a public surface its scrim matches the dialog's overlay weight. Inside, the choices read as **label-over-value single-column fields that never break a value mid-word**, and any machine identifier is quoted verbatim as mono telemetry (The One Voice Rule — mono speaks only for the machine, never dressed up as a prose byline). The reusable shell is `apps/web/src/components/behind-the-scenes.tsx`; the caller owns placement and fills the content.

## 6. Do's and Don'ts

### Do:

- **Do** keep the cover-art backdrop visible through every major surface; it is the design (The Through-the-Glass Rule).
- **Do** reserve Eclipse Gold (#f5b800) for the primary action, focus ring, and identity moments; roughly 10% of any screen, no more (The One Sun Rule).
- **Do** set every columnar number (indices, dates) in Oxanium tabular-nums (The Tabular Rule).
- **Do** make hovers float and presses land: 1.06 artwork scale, 2px caret drift, 1px button press-down, all at 150–180ms ease-out.
- **Do** ground every float under `prefers-reduced-motion: reduce`: color-only transitions, with the Gold Veil wash carrying the feedback.
- **Do** keep body text at WCAG AA (4.5:1) against what is actually behind it, glass included (The Legible Sky Rule).
- **Do** keep all neutrals warm; tint blacks and grays toward the cream/dust hue (#d0b990 family), never blue (The Warm Dark Rule).
- **Do** put the music first on every surface: artist, title, the Found date, note, and the Spotify open action before anything else.
- **Do** treat each row as a finding: lead with the music, frame it with its Log ID coordinate (which carries the Found date, so the compact row needn't repeat it; the Track Row above; VOICE.md's Found Rule).
- **Do** carry the instrument readout on every track-shaped surface: the duration/BPM/key chips and the release year, wherever the data exists (The Readout Rule).
- **Do** let the interface carry the meaning on a work surface (`/mix`, `/recommendations`, `/chat`): the artifact, uniform rows, one gesture per row, and at most the one line a state genuinely needs (The Three Areas Rule).
- **Do** keep grain and lossy texture present; it is narrative, not noise (The Light-Years Rule). A surface rendered glassy-clean and pristine reads as fake. Present, not fixed-heavy — its amount is the piece's own, from near-silent (an electric finding) to heavy (a far-travelled relic).
- **Do** draw interface icons from Phosphor and platform logos from `simple-icons` (Spotify, YouTube, TikTok, …), via `BrandIcon` or `@/components/platform-icons` (Iconography).

### Don't:

- **Don't** build SaaS dashboards, bright streaming-app clones, or generic landing-page hero sections (PRODUCT.md anti-references, verbatim).
- **Don't** write oversized marketing copy; there is no pitch, the tracklist is the page.
- **Don't** put helper paragraphs, explainer kickers, lore sub-lines, or restating section labels on a work surface; prose is content on a lore page and clutter on a workstation (The Three Areas Rule).
- **Don't** stack glassy cards or add decorative gradients that ignore the cover art; panes sit on the cosmos, never on each other, and every gradient must derive from the eclipse palette (The One Pane Rule).
- **Don't** use box-shadows for depth; depth is what shows through the glass.
- **Don't** set body copy in Oxanium (The One Voice Rule), and don't add uppercase-tracked eyebrow labels; labels are bold and small, not tracked-out.
- **Don't** introduce a light theme, cool grays, or a second accent hue; the system is dark-only with one sun.
- **Don't** stand in a Phosphor lookalike for a third-party platform; quote the official `simple-icons` brand mark (Iconography).
