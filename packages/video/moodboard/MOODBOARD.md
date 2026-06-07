# Moodboard

Visual references for the Fluncle video direction, annotated so they read as a spec rather than vibes. The caption is the load-bearing part: every image names which texture family it feeds and what specifically to take from it. The video agent reads this folder as canon alongside DESIGN.md; humans drop images in and caption them here.

Format per entry: filename, the texture family it feeds (nebula / analog / dither / paint, or constant if it informs the law rather than a variable), and one or two sentences on what to steal and what to ignore.

## Entries

- `00-founding-image.png` — constant. The cover art, the founding document: grainy pixelated sun (the Eclipse), floating astronaut tethered to a Discman, starfield over concrete tower blocks with lit windows. Future and past in one frame; every video descends from this. Steal: the grain density on the sun, the warmth of the window lights, the scale relationship between the orb and the towers.
- `nebula-planet-grain.png` — nebula. (Drop the file in.) A heavily grained gradient planet limb, orange-to-charcoal, lit rim against deep noise. Steal: the rim-light treatment and the grain that IS the surface, not an overlay; this is what the Eclipse primitive should mature into. Ignore: the serif lockup.
- `analog-heat.png` — analog. (Drop the file in.) VHS-warm diagonal heat gradients, orange/red into bruised blue, soft motion blur with film noise. Steal: the color collision and the sense that the gradient is moving; a full-bleed background plate for high-energy passages.
- `paint-nostalgia.png` — paint. (Drop the file in.) Hyper-saturated nostalgic landscape painting (city-pop adjacent): cobalt sky, impossible pinks and greens. Steal: the saturated-memory mood for the past pole, treated with grain/dither so it sits in the system. Ignore: literal pastoral content unless the track calls for it.
- `dither-flowers.png` — dither. (Drop the file in.) Two-tone green bitmap flowers in mixed halftone/checker/pixel patterns at clashing scales. Steal: the patchwork of dither scales inside one image; this is DitherField's target sophistication. The matrix pole of the brand.

## How to add a reference

Drop the image in this folder (keep files roughly ≤1400px on the long edge; `sips --resampleWidth 1400 <file>` shrinks one), then add an entry above: family, steal, ignore. References without captions get treated as undirected and may be ignored by agents.
