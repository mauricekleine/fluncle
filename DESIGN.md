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
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.02rem"
    fontWeight: 800
    lineHeight: 1.18
    letterSpacing: "-0.01em"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 400
    lineHeight: 1.25
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.76rem"
    fontWeight: 800
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
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

**The Light-Years Rule.** Every artifact in this system arrives lossy because of how far it travelled: grain over the sun, compression in the video, glitch and dither, the worn edge of a recovered record. The degradation is narrative, never sloppiness — it is the cost of light-years, the reason a finding from the edge of the map looks the way it does. Grain and lossy texture are therefore load-bearing brand, not decoration; a surface rendered too clean reads as fake. (The video kit in `packages/video` is built entirely on this rule; VOICE.md borrows it for copy.)

**The grain architecture.** Dense grain lives UNDER content, never as a veil over reading text: baked into the cosmos backdrop (overlay-blended into the cover image), as pane-tooth on plate surfaces (a whisper under the content layer), and at full density only where there is no text to protect (the cover-frame mat, the artwork fallback's halftone, scanlined empty/loading states). One shared inline-SVG noise tile (`--grain-tile`) feeds every layer — zero network requests. AA (4.5:1) is verified against what is actually behind the text, texture included (The Legible Sky Rule).

**Recurring motifs.** The system returns to a small set of forms — its visual DNA, drawn from the cover art and from the operator's own collages that predate Fluncle by years (collected in the video moodboard, `packages/video/moodboard/MOODBOARD.md`). They map straight onto the narrative: the **centered orb** (the burning eclipse, the sun the traveler moves toward); the **lone figure against vastness** (the traveler himself, the floating astronaut — alone out there, never lonely, because the crew travels with him); **portal / threshold framing** (the crossing between dimensions); **vertical mirror-fold symmetry**; the **tower skyline** as an optional earthbound pole (the home you floated up from, used only when a piece wants the pull of the ground); and **heavy grain over warm near-black** everywhere. That this imagery was already the operator's instinct years before the project is why the brand reads as inevitable, not styled.

**Key Characteristics:**

- Dark-only; the cover-art starfield shows through every surface
- One light source: Eclipse Gold for the primary action, focus, and identity
- Glass as doctrine, not decoration; depth from translucency, never shadows
- Oxanium speaks for the brand (numerals, marks); the system sans does the reading
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

### Named Rules

**The One Sun Rule.** Eclipse Gold is the single light source. It appears as the primary action, the focus ring, and identity moments, and on no more than roughly 10% of any screen. Two gold elements competing in one view means one of them is wrong.

**The Warm Dark Rule.** Every black and every neutral leans warm (toward the cream/dust hue). Cool grays and blue-tinted darks are prohibited; the night sky of this cosmos is warm and inhabited.

**The Ignition Rule.** Gold is placed like light, never applied like paint — and interaction HEATS it. One directional Eclipse-Gold bloom anchors where the cover's sun sits (under every pane, breathing imperceptibly over ~48s, reduced-motion-gated); frame edges are lit from the sun side; hovers ignite toward Eclipse Glow (the primary button brightens, quiet controls catch the Gold Veil and their text glows). A control that DIMS on hover is wrong: the sun does not dim when you reach for it. The One Sun budget (~10% of any screen) still governs the total.

**The Retint Rule.** Fluncle absorbs outside visual influence by stealing the technique and recoloring it to canon. Any reference — a halftone, a scanline, a liquid gradient, a gel split, a mirror tiling — is fair game for its craft, but it arrives in off-canon hues (broadcast blue, phosphor green, candy pink) and leaves in ours: warm dark ground, Eclipse Gold as the one light, Re-entry Red as the heat accent, Starlight Cream as the ink. Cool hues survive only as minor counter-accents, never a field. The technique is the reference; the palette is always ours. (This is the operating rule of the video moodboard, `packages/video/moodboard/MOODBOARD.md`, and the visual sibling of "briefs are subordinate to canon" — take the idea, translate it into Fluncle's terms.)

## 3. Typography

**Display Font:** Oxanium (with ui-sans-serif, system-ui fallback), weights 400–800
**Body Font:** System sans stack (Tailwind default ui-sans-serif)

**Character:** Oxanium is the voice of the artifact: a squared, techy face that reads like the printing on a Discman, used for the wordmark, track numerals, and brand moments. The body runs on the quiet system sans so the music metadata reads instantly. The pairing is "machine label + plain reading", not a typographic performance.

### Hierarchy

- **Display** (800, ad hoc sizes, -0.02em): Oxanium, reserved for brand marks and the plate mastheads. The one sanctioned large on-page heading is a masthead nameplate (a brand-mark plate: the stamped FLUNCLE'S FINDINGS lockup on the home plate, the coordinate on a log plate); body headings stay quiet, and the cover art remains the hero image.
- **Numeric** (400, 0.98rem, -0.02em, tabular-nums): Oxanium track indices (#01, #02). Always tabular.
- **Title** (800, 1.02rem, 1.18, -0.01em): Track titles. Extrabold cream against the dark; the loudest text on the page.
- **Body** (400, 0.9rem, 1.25): Artist lines, descriptions, form text in Stardust or Starlight Cream.
- **Label** (800, 0.76rem): Column headers and form labels. Bold and small, never uppercase-tracked.
- **Mono** (400, 0.82rem, 1.5): System mono stack, reserved for literal terminal content: the CLI install command and command examples. The machine's own voice, quoted verbatim.

### Named Rules

**The One Voice Rule.** Oxanium speaks only for the brand and the numbers, and mono speaks only for the machine (literal commands and code). If body copy or a paragraph is set in either, it's a mistake.

**The Tabular Rule.** Every number that sits in a column (indices, dates) is tabular-nums. Numbers that jitter on update break the instrument-panel calm.

## 4. Elevation

Depth in this system comes from translucency, not shadows: every raised surface is a pane of glass over the cosmos. The playlist shell and cover frame use `backdrop-filter: blur() saturate(125%)` over the fixed cover-art backdrop, so what shows through the surface IS the elevation cue. Edges are defined by 1px Dust Line borders. Box-shadows are effectively banned (the sole exception is the hairline `shadow-xs` baked into the outline button); focus is a ring, hover is a veil, depth is the sky behind the glass.

### Named Rules

**The Through-the-Glass Rule.** Surfaces are windows onto the cosmos. A surface that fully occludes the backdrop (opaque, blurless) must justify itself; a surface with a drop shadow is prohibited outright.

**The One Pane Rule.** Glass does not stack on glass. Every pane sits directly on the cosmos, never on another pane (PRODUCT.md bans "glassy card stacks" by name); content inside a pane sits flat on it. On the web the pane is **the plate** (below): one document per page, with the cover frame, the list, and the nerd card mounted flat on it as printed fields — none of them carries its own glass.

**The Legible Sky Rule.** Text never sits on the raw backdrop. Every text surface is a pane that dims what it covers enough to hold WCAG AA (4.5:1 for body text), even where the burning sun sits behind the glass. If a bright backdrop region breaks contrast, the pane gets more opaque, not the text dimmer.

## 5. Components

Floaty and tactile: controls lift gently on hover (artwork scales to 1.06, carets drift 2px), and land on press (buttons translate down 1px). Motion is 150–180ms, eased out. The ambient budget is exactly two movements, both imperceptible and both gated to `prefers-reduced-motion: no-preference`: the 72s cosmos drift and the ~48s sun-bloom breath (The Ignition Rule) — "quiet" is not a frozen JPEG, and nothing else moves uninvited. Under `prefers-reduced-motion: reduce`, the floats are grounded and the ambient pair stops: no scale, no drift, no press-down, no breath; every state change collapses to a color-only transition. The Gold Veil wash and index heat carry the feedback on their own.

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

The core unit of the product — a **finding**, not just a row. A CSS grid (an Oxanium tabular **Log ID** column, 3.25rem album artwork, `1fr` title block, caret; gaining a date column at 640px+): the Log ID (the finding's coordinate in the Galaxy, e.g. `241.7.3A`) stands where a plain row index used to, then 3.25rem album artwork (6px radius, 1px border), an extrabold title over a Stardust artist line, the **Found** date, and a caret. The music still leads the eye; the Log ID and the Found date frame it as an entry in Fluncle's logbook. The whole row is one link to Spotify. Hover/focus washes the row in Gold Veil, heats the Log ID to Eclipse Glow, scales the artwork to 1.06 behind a gold-tinted border, and drifts the caret 2px right. Rows separate with Dust Line borders at 72%; the last row drops its border. Artwork fallback is a gold-to-red gradient over Dust Veil, echoing the eclipse. (The Log ID column is wider than the old index; size it to the coordinate format, kept tabular so it never jitters.)

Pagination lives inside the list, never below the shell: a quiet load-more row (Stardust bold text, Gold Veil hover) doubles as an intersection sentinel that auto-fetches near the bottom. It disappears when the archive is exhausted; the layout below the pane never shifts.

### CLI Command

Literal terminal content in a quiet box: mono text (0.82rem) on Tape Black with a Dust Line border (0.5rem radius). Long commands scroll horizontally behind a thin Dust Line scrollbar (`scrollbar-width: thin; scrollbar-color` themed), never a native white one. A copy action (outline icon button) sits beside the install command; the check-mark confirmation flashes Eclipse Gold.

### The Plate (signature surface)

The page itself: a recovered logbook plate, one printed document per surface (the home archive, a `/log/<id>` entry, the log index, About). Its grammar: a **masthead** with the stamped nameplate (Oxanium caps, the brand-mark plate) and a quiet tagline; a rotated gold **FOUND stamp** carrying the archive count; **crop-mark corner brackets** and a **register cross** printed just inside the edge (pure background gradients — zero DOM); a **double-rule frame** (border + offset outline, the printed edge); and **pane-tooth grain** on the surface, under the content. Fields on the plate (the list, the nerd box) are flat translucent panels, not nested glass. The dialog (Stories) is the one surface that floats above a plate.

### Cover Frame (signature component)

The identity anchor: the cover art mounted flat on the plate, wrapped in a frame whose edge is LIT from the sun side (top/left border heated toward gold) over a bent warm gradient (a radial falloff from the sun corner, gold into Re-entry Red) with grain blended in. The eclipse colors bleed into the frame; the artwork stays untouched. No glass of its own (One Pane).

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
- **Do** treat each row as a finding: lead with the music, frame it with its Log ID coordinate and Found date (the Track Row above; VOICE.md's Found Rule).
- **Do** keep grain and lossy texture present; it is narrative, not noise (The Light-Years Rule). A surface rendered glassy-clean and pristine reads as fake.

### Don't:

- **Don't** build SaaS dashboards, bright streaming-app clones, or generic landing-page hero sections (PRODUCT.md anti-references, verbatim).
- **Don't** write oversized marketing copy; there is no pitch, the tracklist is the page.
- **Don't** stack glassy cards or add decorative gradients that ignore the cover art; panes sit on the cosmos, never on each other, and every gradient must derive from the eclipse palette (The One Pane Rule).
- **Don't** use box-shadows for depth; depth is what shows through the glass.
- **Don't** set body copy in Oxanium (The One Voice Rule), and don't add uppercase-tracked eyebrow labels; labels are bold and small, not tracked-out.
- **Don't** introduce a light theme, cool grays, or a second accent hue; the system is dark-only with one sun.
