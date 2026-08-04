# Clip-cut fonts

`Oxanium-SemiBold.ttf` is the Oxanium brand face (DESIGN.md "One Voice") the Fluncle Studio clip cut stamps onto a clip's brand frame — the `fluncle://<logId>` **coordinate** line. ffmpeg's `drawtext` renders through freetype, which reads only `.ttf`/`.otf` — never the app's `.woff2` — so the cut needs a static TTF.

**Provenance.** Instanced at weight 600 (SemiBold) from the upstream Oxanium variable font (`google/fonts` `ofl/oxanium/Oxanium[wght].ttf`), non-variable, name table updated:

```
fonttools varLib.instancer 'Oxanium[wght].ttf' wght=600 -o Oxanium-SemiBold.ttf --update-name-table
```

**License.** SIL Open Font License 1.1 — see `OFL.txt`. Redistribution is permitted; this asset ships with the license alongside it.

**How it's used — nothing reads it today.** The clip cut once stamped a brand frame (title + coordinate + Track-ID + ink-halo) over the footage. That frame has been removed: the cut now ships CLEAN, a pure crop with no baked text overlay, because recorded set footage reads poorly under a `drawtext` caption and the operator writes the caption at post time instead (`apps/cli/src/commands/clips.ts:11-14`). The removal is pinned by a test — `apps/cli/src/commands/clips.test.ts:61` asserts the filtergraph contains no `fontfile` — so the two font roles this file used to document, along with the `resolveClipFontFile()` / `resolveClipSansFontFile()` resolvers and the `CLIP_FONT_FILE` / `CLIP_SANS_FONT_FILE` overrides, no longer exist in the CLI.

The TTF is still **baked into the Hermes image** — `docs/agents/hermes/Dockerfile:240` copies it to `/opt/fonts/Oxanium-SemiBold.ttf`, and `apps/cli/assets/fonts` is one of the paths in pin-watch's baked-content fingerprint (`docs/agents/hermes/pin-watch/README.md`). Keep the asset and its license together for as long as the image carries it; retiring it is an image-build change, not a docs change.
