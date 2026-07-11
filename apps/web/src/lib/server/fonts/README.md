# Satori font cuts

The brand's faces, cut for the **Satori** renders — the OG cards (`routes/api/og.$logId.ts`, `routes/api/og.set.ts`) and the mixtape cover (`lib/server/mixtape-cover.ts`), all of which go through workers-og → Satori → resvg inside the Cloudflare Worker.

They exist because a Worker is the hostile case for DESIGN.md's **Canon Travels Rule**: it has no system fonts, no `assets` binding, and cannot fetch its own origin. Three constraints decide the shape of these files:

| Constraint                               | Consequence                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Satori does not read **woff2**           | `public/fonts/*.woff2` — the faces the web app serves — are unusable. These are **TTF**.                                            |
| The Worker has nowhere to fetch **from** | The bytes ship **in the bundle** (Vite `?inline` → base64 data-URI, decoded once per isolate in `lib/server/satori-render.ts`).     |
| Satori has no **`@font-face`**           | The One Box Rule's `ascent-override`/`descent-override` in `styles.css` cannot reach it, so the metrics are **baked into the TTF**. |

Together these replace what used to be a `loadGoogleFont()` call — a render-time fetch to Google on the critical path of every link preview, and a break of the self-hosting rule (DESIGN.md §3: "All three faces are SELF-HOSTED, and that is a rule, not an implementation detail").

## The cuts

| File                    | Role                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `oxanium-400.ttf`       | The brand: coordinates and numerals (the mixtape cover's Log ID).        |
| `oxanium-800.ttf`       | The brand: marks and plate mastheads (the lockup, the gold Log ID).      |
| `space-grotesk-400.ttf` | The body: artist lines, meta lines, reading text.                        |
| `space-grotesk-700.ttf` | The body: titles. 700 is Space Grotesk's ceiling — nothing asks for 800. |

**One buffer per weight, and the markup may only ask for a weight that is here.** Satori synthesizes nothing — no faux-bold, no interpolation. It snaps an unregistered weight to the nearest registered face, silently, so the rendered weight differs from the code with no error. `satori-render.test.ts` reads the real markup and fails the build if a card asks for a face that does not exist.

Each cut carries the **latin + latin-ext** subsets — both, matching the ranges `styles.css` declares. An OG card has no second subset to fall back to and no system font behind it, so a title carrying a `ć` or a `Ģ` would otherwise render as a blank `.notdef` box on the most visible surface Fluncle has.

## Provenance

Cut by [`../../../../scripts/cut-satori-fonts.py`](../../../../scripts/cut-satori-fonts.py) from the upstream **variable** fonts in `google/fonts` (`ofl/oxanium/Oxanium[wght].ttf`, `ofl/spacegrotesk/SpaceGrotesk[wght].ttf`): `varLib.instancer` pins the weight axis, `subset` trims to latin + latin-ext, then the `hhea`/`OS/2` tables are patched to the ratified One Box metrics and `USE_TYPO_METRICS` is set.

```bash
apps/web/scripts/cut-satori-fonts.py            # re-cut
apps/web/scripts/cut-satori-fonts.py --verify   # read the tables back and assert
```

To add a weight or a face: add a row to `CUTS` in the script, re-run it, and register the buffer in `lib/server/satori-render.ts`.

## Licence

Both families are **SIL Open Font License 1.1** — see `OFL-Oxanium.txt` and `OFL-SpaceGrotesk.txt`. Redistribution is permitted; the licence ships with the fonts, which is what the OFL requires. Instancing, subsetting, and re-tabling are all modifications the OFL allows (no Reserved Font Name is asserted by either family).
