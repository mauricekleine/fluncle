# Mobile store screenshots — the own-IP capture rig

Apple rejected Fluncle mobile 1.0 under **Guideline 5.2.1** on 2026-07-28: not the app, the **screenshots**. The store slots were shot against the live archive, so they showed real album covers and Spotify artist photography — third-party artwork we hold no rights to, published as marketing material. The app's own posture is fine (see [app-store-review.md](app-store-review.md) for the 5.2.3 argument that already survived a round); the fix is to re-shoot every affected slot against a synthetic dataset whose sleeves and artist marks Fluncle generated and owns outright.

**The rule this rig exists to keep: no third-party artwork may appear in ANY store asset.** Not a cover, not an artist photo, not a logo that is not ours. Treat it exactly like the 5.2.3 muted-video invariant — submission-blocking, not a nice-to-have. A screenshot is published marketing, and the reviewer looks at it before they look at the app.

## The four steps

Run them in order, from the repo root, on the machine that holds the simulator.

**1 — Render the art.** Fourteen sleeves and eight artist marks, generated from code in the Nostalgic Cosmos, deterministic per slug.

```bash
bun run --cwd packages/media render:screenshot-assets
# → packages/media/out/screenshot-assets/{sleeves,avatars}/<slug>.png   (gitignored)
```

**2 — Serve them.** Anything that serves a directory over HTTP will do; the seed defaults to `http://127.0.0.1:8899`.

```bash
python3 -m http.server 8899 --directory packages/media/out/screenshot-assets
```

**3 — Seed the local database.** This writes the synthetic findings, artists, galaxies, and mixtape, with every image URL pointing at step 2. It refuses to run against anything that is not a local database, and it is idempotent — re-running deletes its own `shot-` rows first and touches nothing else.

```bash
bun run --cwd apps/web dev            # the per-worktree libSQL server + the worker on :3000
bun run --cwd apps/web screenshot:seed
```

`SCREENSHOT_ASSET_BASE` overrides the asset host. `SCREENSHOT_RADIO_OBSERVATION_URL` points the Radio slot at a real published observation (Fluncle's own recorded voice) if you want audio actually playing during the shot; left unset, the Radio card renders on its own bounded timer with no sound, which shoots fine.

**4 — Run the app against it.** `EXPO_PUBLIC_API_BASE` is inlined at bundle time, so it has to be set for the bundler process, not the simulator.

```bash
EXPO_PUBLIC_API_BASE=http://127.0.0.1:3000 bun run --cwd apps/mobile ios
```

Then shoot. Nothing in the app changes for a store build: with the variable unset, `API_BASE` compiles to the production host exactly as before.

## The shot list

| Slot                  | Action              | Why                                                                                                      |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| Feed (both slots)     | **keep**            | Shows Fluncle's own Remotion render — already own IP.                                                    |
| App icon              | **keep**            | Generated from `@fluncle/media`.                                                                         |
| Decks — artist picker | **re-shoot**        | Was a grid of Spotify artist photos. Now the generated orbital marks.                                    |
| Decks — the chain     | **re-shoot**        | Cover-led rows; every cover was a real sleeve.                                                           |
| Archive               | **re-shoot**        | Same — 56pt covers down the whole list.                                                                  |
| Radio                 | **re-shoot**        | The hero IS the cover.                                                                                   |
| Finding detail        | **re-shoot**        | Full-width cover.                                                                                        |
| Mixtapes              | optional            | The cover is Fluncle's own on-the-fly render either way; re-shoot only if the tracklist names real acts. |
| Submit                | **re-shoot, EMPTY** | Its results proxy live Spotify search, artwork included. Capture the pre-search state, before a query.   |

The seeded dataset carries **no first-party video renders**, so the Feed reads empty against it. That is deliberate: the Feed shots are the two that keep, and they come from a production build.

## What the seeded dataset covers

One fixture list — `packages/test-support/src/screenshot-fixtures.ts` — feeds both the renderer and the seed, so a rendered file name and a seeded image URL cannot drift. Fourteen findings across eight invented artists, all in one tight neighbourhood of the Camelot wheel and inside the 170–178 tempo band, so the Decks rail returns a full ranked list four deep into a chain instead of the quiet-sector empty state. Every track carries a MuQ-shaped embedding, because two of the three Decks reads gate on one outright. One finding is radio-eligible; one published mixtape carries eight of them as its tracklist.

Every name in that list is invented. Putting a real artist or a real release title back into it re-opens the rejection the rig exists to close — and the fixture notes are rendered into the finding-detail screenshot, so they are public copy in everything but name: give them a [copywriting-fluncle](../packages/skills/copywriting-fluncle) pass before a capture session if you edit them.
