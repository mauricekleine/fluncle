# RFC: Audio embeddings — automatic sonic similarity + clusters (retiring manual vibe-tagging)

**Status:** Final — build-ready. Decisions + spike evidence baked in (2026-07-06).
**For:** a fresh build session.
**Canon/authority:** the enrichment pipeline (`docs/track-lifecycle.md`, the `fluncle-track-enrichment` skill, `docs/agents/hermes-agent.md`), `apps/web/src/db/schema.ts`, the oRPC contract layer, `AGENTS.md`/`DESIGN.md`. Planning, not spec.

## The standard (definition of done)

The whole thing, tested + documented, automated end to end — no manual per-finding step (that's the entire point). The only sanctioned "not now" is genuine phasing: "more like this" ships first (Phase 1) and the browse/game surfaces follow, each complete when it lands. Ties off a long-dangling thread: the vibe-placement model + its downstream auto-notes-v2, both of which this supersedes.

## 0. The decision this replaces (why we're doing it)

Manual vibe-tagging (`vibe_x`/`vibe_y` on `/admin/tag`) was always justified as "manual _now_, a model automates it _later_." A signal test this session killed the "later": on the 45 tagged findings, audio **cannot** learn the placement — the energy axis (Floaty↔Driving) is weakly learnable (R²≈0.35), but the **mood axis (Light↔Dark) isn't** (R²≈0, sign-accuracy at coin-flip), and the two axes are ~a third redundant anyway (`corr(x,y)=+0.37`, PCA 69/31 diagonal). More labels won't fix it (the ceiling is the features, not the count), and the "obvious" adds (key/mode, BPM) have **zero** correlation with the placements. Per Fluncle's automate-or-drop ethos, a manual step whose only justification was a now-impossible automation gets **dropped** — not enshrined as "manual forever."

**What replaces it:** audio **embeddings**. Crucially, _clustering succeeds where regression failed_ — a music embedding can't _place_ a track on the mood axis, but it cleanly _groups_ the sonically-similar. So we get, fully automatically and with **no tagging**: (a) "more like this" similarity, (b) sonic clusters for a browse lens and the game. The four galaxies stay as **brand/narrative fiction** (they don't need per-track placement to exist). Verified: **nothing reads `vibe_x`/`vibe_y` today**, so dropping the tagging breaks nothing.

## 1. The model: MuQ-large (decided, spiked)

Four models were spiked on a 54-track clustering test (the whole catalogue's 30 s previews): **general CLAP** (feelable but coarse), **music-CLAP** (`larger_clap_music` — _collapsed_ into one blob, worse), **MERT-95M** (muddier — merges deep-liquid and dancefloor into one cluster), and **MuQ** — which won cleanly, splitting into three feelable families (**deep/musical liquid · emotional/vocal rollers · driving/dancefloor**) with dead-simple mean-pooling and zero tuning. The operator confirmed the split feels natural.

- **Model:** `OpenMuQ/MuQ-large-msd-iter` — the MARBLE SOTA for music representations + mood tagging. Embedding = mean-pool `last_hidden_state` over time → **1024-d**, L2-normalize.
- **Validated on the target box (rave-02, resized to CPX32 / 8 GB):** **2.85 GB peak RAM**, **~16 s/track** on 2 cores (≈8 s on the CPX32's 4), 1024-d out. Comfortable headroom in 8 GB alongside the Hermes agent.

## 2. Architecture

### 2a. The embed step (on the box)

A new `fluncle-embed` Hermes cron on rave-02, mirroring `fluncle-enrich` (which already fetches the preview for BPM/key — reuse that fetch or run adjacent). It decodes the preview (ffmpeg is in the container), runs MuQ, and writes the vector via an **agent-tier** op (the box's token, the `finalize_clip_cut` precedent). Queue-gated + idempotent (`embedding IS NULL`), a small per-tick batch like the other sweeps.

**Deps — the load-bearing lesson from the spike:** MuQ's torch family (**torch + torchaudio + torchvision**) must all be _matched CPU builds_, installed together from the pytorch CPU index **before** `muq`, on **Python 3.11** — it took four attempts ad-hoc. So this MUST be a **pinned Dockerfile layer** built into the Hermes image (never a runtime `pip install`), with the MuQ model **baked into the image** (or a persistent cache) to avoid re-download on every cold start.

### 2b. Storage

An `embedding_json` column on `tracks` (migration via `bun run --cwd apps/web db:generate`) — the 1024 floats as JSON (or a compact `F32_BLOB`). At catalogue size (dozens → low thousands), **brute-force cosine in the Worker is instant**; libSQL's native vector search (`F32_BLOB` + `vector_top_k`) is the escape hatch only if it ever passes ~10 k findings.

### 2c. The similarity op

`get_similar_findings(idOrLogId, limit)` — a public read oRPC op: load the stored vectors, cosine-rank, return the top-N findings (excluding self). Pure, testable, no new infra.

### 2d. The surface (Phase 1 value)

A **"more like this"** row on `/log/<id>` — the N sonically-nearest findings as cover cards; quiet, cover-led, canon (DESIGN.md). Optionally a "play something like this" hook in radio. This ships real value and needs **no clustering at all**.

## 3. Phasing

- **Phase 1 — embed + "more like this."** The embed step + `embedding_json` + `get_similar_findings` + the `/log` row. The whole automatic-similarity win, minimal surface.
- **Phase 2 — browse-by-feel.** Periodic k-means (**k=3** default — the deep/emotional/driving split) → a lens grouping the archive by sonic family (name the clusters once they're stable). Cluster label computed on demand or cached.
- **Phase 3 — the game's solar-systems.** Clusters become star systems in the Galaxy game (the operator's idea) — rides the deferred game-expansion; the embeddings are ready when it is.

## 4. What it retires / unlocks

- **Retires** the manual vibe-tag step (the `/admin/tag` requirement) and the roadmap's _Vibe-placement model_ item (dead — audio can't learn it). Keep the four galaxies as fiction.
- **Unlocks a better auto-notes-v2:** the vibe-neighbour auto-note was gated on the dead vibe model; it can now key off **embedding** neighbours instead ("sits near <sonic neighbours>") — real sonic kinship, automatic. Fold into `fluncle-track-enrichment`.
- **Update the roadmap:** replace the Vibe-placement + auto-notes-vibe-neighbour items with this.

## 5. Ops / gates (operator)

- **rave-02 → CPX32 (8 GB): DONE.**
- **Deploy the MuQ image layer** (the pinned Dockerfile + baked model) via the `fluncle-hermes-operator` flow, then wire the `fluncle-embed` cron + register a `cron.embed` `@fluncle/registry` surface.
- `HF_TOKEN` (in the Fluncle op vault) for the one-time model fetch, or bake the weights into the image.

## 6. Effort

- **S–M:** the `fluncle-embed` step + the pinned Dockerfile layer (the dep-pinning is the fiddly part, now fully understood).
- **S:** the `embedding_json` migration + the store helper.
- **S:** `get_similar_findings` op + oRPC coverage/tests.
- **S–M:** the `/log` "more like this" surface.
- Phase 2/3 later, each small on top of the stored vectors.

## 7. Acceptance criteria

A new finding gets an embedding within a cron tick of enrichment (idempotent, `embedding IS NULL` drained); its `/log` "more like this" returns sonically-plausible neighbours; **zero manual step**. Tests: the cosine-NN math, the embed idempotency, the op auth-tier + coverage. The box runs MuQ within RAM (validated: 2.85 GB / 8 GB). Docs: the `fluncle-track-enrichment` skill + `track-lifecycle.md` gain the embed artifact; the roadmap swaps the vibe-model items for this.

## Appendix — spike evidence (this session, 2026-07-06)

- **Vibe-model signal test (n=45, leave-one-out):** audio can't carry the map — best ~48% galaxy accuracy vs 36% baseline; energy axis R²≈0.35 (weakly learnable), mood axis R²≈0 (coin-flip); axes `corr=+0.37`; key/mode + BPM ~0 correlation.
- **Model comparison (54-track k-means):** MuQ > general-CLAP > MERT-95M > music-CLAP. MuQ k=3 = a clean deep / emotional / driving split; MERT smears deep + dancefloor together; music-CLAP collapses.
- **Box validation (rave-02, CPX32):** MuQ-large = 2.85 GB peak, ~16 s/track (2 cores), 1024-d; deps require the matched CPU torch trio + Python 3.11 (→ pinned Dockerfile, not runtime install).
