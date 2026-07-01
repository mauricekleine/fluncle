# Clip-cut fonts

`Oxanium-SemiBold.ttf` is the brand face (DESIGN.md "One Voice") the Fluncle Studio clip cut stamps onto a clip's brand frame. ffmpeg's `drawtext` renders through freetype, which reads only `.ttf`/`.otf` — never the app's `.woff2` — so the cut needs a static TTF.

**Provenance.** Instanced at weight 600 (SemiBold) from the upstream Oxanium variable font (`google/fonts` `ofl/oxanium/Oxanium[wght].ttf`), non-variable, name table updated:

```
fonttools varLib.instancer 'Oxanium[wght].ttf' wght=600 -o Oxanium-SemiBold.ttf --update-name-table
```

**License.** SIL Open Font License 1.1 — see `OFL.txt`. Redistribution is permitted; this asset ships with the license alongside it.

**How it's used.** `apps/cli/src/commands/clips.ts` (`resolveClipFontFile`) defaults to the baked box path `/opt/fonts/Oxanium-SemiBold.ttf` (baked in `docs/agents/hermes/Dockerfile`) when `CLIP_FONT_FILE` is unset. For a local render, point `CLIP_FONT_FILE` (or the `fontFile` option) at this file.
