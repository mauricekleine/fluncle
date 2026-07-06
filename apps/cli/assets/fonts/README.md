# Clip-cut fonts

`Oxanium-SemiBold.ttf` is the Oxanium brand face (DESIGN.md "One Voice") the Fluncle Studio clip cut stamps onto a clip's brand frame — the `fluncle://<logId>` **coordinate** line. ffmpeg's `drawtext` renders through freetype, which reads only `.ttf`/`.otf` — never the app's `.woff2` — so the cut needs a static TTF.

**Provenance.** Instanced at weight 600 (SemiBold) from the upstream Oxanium variable font (`google/fonts` `ofl/oxanium/Oxanium[wght].ttf`), non-variable, name table updated:

```
fonttools varLib.instancer 'Oxanium[wght].ttf' wght=600 -o Oxanium-SemiBold.ttf --update-name-table
```

**License.** SIL Open Font License 1.1 — see `OFL.txt`. Redistribution is permitted; this asset ships with the license alongside it.

**How it's used.** The clip cut's brand frame mirrors the Remotion `TypePlate` and uses **two** font roles (`apps/cli/src/commands/clips.ts`):

- **Coordinate** (`fluncle://<logId>`) → this **Oxanium SemiBold**. `resolveClipFontFile()` defaults to the baked box path `/opt/fonts/Oxanium-SemiBold.ttf` (baked in `docs/agents/hermes/Dockerfile`) when `CLIP_FONT_FILE` is unset.
- **Title** (the mixtape name) → **DejaVu Sans Bold**, a bold-grotesque stand-in for the Remotion `trackLine`'s `ui-sans-serif, system-ui, sans-serif` (not embedded in `packages/video`, so headless Chromium renders it as its generic Linux `sans-serif` = DejaVu). It is an OS package (`fonts-dejavu-core`), not committed here; `resolveClipSansFontFile()` defaults to `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`.

For a local render, point `CLIP_FONT_FILE` (Oxanium) and `CLIP_SANS_FONT_FILE` (a DejaVu Sans Bold copy) at local `.ttf` files.
