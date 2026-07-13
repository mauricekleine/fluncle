# Cluster Engine (the sonic galaxies — browse-by-feel)

The **cluster engine** keeps Fluncle's **sonic galaxies** current: it groups the archive into a stable, operator-named map of k-means regions over the MuQ audio-embedding space, so a finding lands in a galaxy by how it _sounds_. The galaxies stopped being the four fictional vibe quadrants and became the real, sound-derived map (the [browse-by-feel RFC](../rfcs/browse-by-feel.md); canon in [track-lifecycle.md](../track-lifecycle.md)). This is a deterministic on-box sweep, not a new runtime and not an agent — zero LLM tokens, pure math. The Worker owns the map store + the identity mint; the box holds only its `agent`-scoped `FLUNCLE_API_TOKEN` and drives the map through the `fluncle` CLI.

It is the **grouping** sibling of the [embed cron](./hermes-agent.md): where `fluncle-embed` computes each finding's 1024-d MuQ vector, `fluncle-cluster` reads the whole embedded corpus back and assigns each finding to its nearest galaxy centroid over that same space (the exact cosine metric `get_similar_findings` ranks with).

## Stability by construction: the nightly run is assignment-only

Each night the tick does ONE bounded step — no clustering fit runs:

1. Load the stored centroids (the map) + the embedded corpus (each finding's vector **and its current `galaxy_id`**).
2. Assign each finding to its nearest stored centroid (cosine). New findings join here; a boundary finding may migrate marginally.
3. Recompute each galaxy's centroid as the L2-normalized **mean** of its members (a MacQueen/Lloyd-style step — over nights it converges toward the local optimum while never jumping).
4. Detect an **emptied** galaxy and **retire** it (row kept, `retired_at` set, id never recycled) — reachable precisely because no library relocation runs.
5. Write back (the write-order contract below).

**IDs are stable by construction: no relabeling step exists, so no label-alignment machinery is needed at all.** On an unchanged corpus the run is a no-op — identical assignments, centroids equal within 1e-6 cosine. The nightly assignment + mean is **pure TypeScript** (`cluster-sweep.ts`, unit-tested), so the common path never even spawns python.

## Why a full fit is an OPERATOR act, never the nightly default

A nightly full re-fit — even warm-started — is the one thing this design forbids. sklearn's Lloyd loop can never emit an empty cluster: `_relocate_empty_clusters` moves an emptied centroid to a high-inertia far point (an arbitrary different sonic region), and with equal k the post-hoc label matching is perfect, so the teleported centroid inherits a prior stable id — exactly the bookmark-breaking reshuffle the feature forbids. So a full `KMeans.fit` runs ONLY inside an operator act:

- **Cold start (`--cold-start`, run 1 — a snap, not a ratchet):** one full fit at **k = 4 (operator-held after the k=9 pilot spread the map thin; `FLUNCLE_CLUSTER_K` overrides per fit)** over the whole corpus. Every cluster gets a server-minted id + handle and enters the naming queue. The map must be empty (else use `--remint`).
- **Split (operator-gated, consumed on the nightly tick):** the operator requests a split in `/admin/galaxies` (`update_galaxy` sets `split_requested_at`; the box's agent token cannot call that OPERATOR-tier op). The next nightly tick **consumes** it (pulled, not pushed): a k=2 fit on that galaxy's members only, the parent keeps its id on the **larger** child, the Worker mints ONE new id + handle for the smaller child, which lands unnamed in the naming queue. The tick clears `split_requested_at` in the same map write so it can never re-fire.
- **Remint (`--remint`, a deliberate full reset):** never on the cron. A fresh full fit at the held k (4; `FLUNCLE_CLUSTER_K` overrides) that retires every old id and re-queues the whole map for naming. Reserved for an embed-model change (a different checkpoint / `EMBEDDING_DIMS` stales every centroid) or a corpus shift too large for splits.

The fits (+ the split's k=2) go through `cluster.py` (scikit-learn, deterministic: fixed `random_state`, `n_init="auto"`, a pinned thread env). The fit only PRODUCES centroids to seed the map; assignment is always nearest-centroid against the STORED map (with ids), so a minted id never has to be reconciled with a fit index.

## The write-order contract (the run's consistency boundary)

1. **Upsert the map FIRST** (`update_galaxy_map`) for any minted / retired / reshaped clusters — the Worker mints ids + handles and returns them, so every id a finding can point at exists BEFORE any assignment lands. The box never mints identity (`galaxy-slug.ts` is a workspace package the standalone baked sweep can't import).
2. **Write the CHANGED assignments** (`update_track --galaxy-id`) — diffed against each finding's current `galaxy_id`, so an unchanged corpus writes nothing and never churns the `/log` edge cache. Assignment is deliberately NOT in `VISIBLE_FIELDS` (no sitemap lastmod bump), while `updateTrack`'s built-in `purgeLogCache` keeps the `/log` galaxy prose fresh.
3. **Refresh centroids + retire empties** in a final map write. `member_count` is DERIVED (`COUNT(*) GROUP BY galaxy_id`), never stored — the denormalization-drift class is deleted outright.

A mid-run crash is resume-safe: re-running converges, and no assignment can ever point at a missing map row.

## The evidence the operator reads (silhouette + size)

The tick computes, for reporting only, each galaxy's **mean cosine silhouette** (coherence) and its member count, and prints them on its JSON summary line. This is the evidence the naming view (Slice 3) shows so the operator can _see_ when a region holds two feels and request a split. Silhouette is O(N²) — trivial at archive scale — and never gates or slows the assignment step.

## The identity vs the name (minted once, named later)

- Each new galaxy is born with a permanent **machine handle** minted server-side inside `update_galaxy_map` (`galaxySlug(id, attempt)`, collision-salted). The handle is the admin/CLI identity — **it never renders publicly**, and the machine never proposes a name.
- The operator names a galaxy in `/admin/galaxies` (`update_galaxy`, OPERATOR tier — an agent token 403s), which mints its public URL. Naming is an editorial act after listening; a re-run may move findings but **never renames a galaxy** (the minted-once law).
- An unnamed or retired galaxy is invisible on every public surface and queued in admin.

## The commands (what the sweep drives; all admin-tier)

```
fluncle admin galaxies map                              # read the full map (centroids, split flags, retired)
fluncle admin galaxies embeddings [--cursor c]          # the embedded corpus (trackId, embedding, current galaxyId), paged
fluncle admin galaxies set-map --file clusters.json     # the transactional map write (mint / retire / upsert)
fluncle admin tracks update <id> --galaxy-id <galaxyId> # one finding's assignment (the changed handful)
```

The OPERATOR-tier `update_galaxy` (naming / rename / request-split) is NOT one the box calls — the agent token 403s there by design.

## The box cron

`fluncle-cluster` is the on-box `--no-agent` deterministic sweep — a rave-02 HOST systemd timer (nightly, 02:20 Amsterdam), the same host-timer shape as `fluncle-embed` (a stateful batch job must not ride the shared 5-minute gateway runner). Source: [`hermes/scripts/cluster-sweep.{sh,ts}`](./hermes/scripts/) + [`cluster.py`](./hermes/scripts/cluster.py). The full box wire-up (units, install, the pre-smoke, the operator acts) is [`hermes/cluster-timer/README.md`](./hermes/cluster-timer/README.md).

### Operator runbook — the cold-start pilot (de-risks the most)

Before the timer is armed and before any naming, the operator runs the fit by hand (held k = 4) and eyeballs the split with the operator's ear (the RFC's one highest-value de-risking step):

```bash
# On rave-02, against the live map (or a dev DB for a dry pilot):
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/cluster-sweep.sh --cold-start
# Read the summary: 4 galaxies minted (the held k), every finding assigned, the per-galaxy silhouette + size.
# Then the naming sitting (Slice 3): open /admin/galaxies, audition each galaxy's member previews,
# name them all. The public lens (Slice 4) ships only once the initial map is fully named.
```

### Box activation

Unlike a pure-script cron, `fluncle-cluster` needs the **image rebaked before activation**: the MuQ venv gains sklearn + scipy (the third pinned pip step) and the sweep trio must be baked in. The verbs shipped in the Slice 1 CLI release; Slice 2's additive request/response fields pass through the thin CLI at runtime, so no NEW CLI verb is required — only the rebake (the standard pin-watch rebuild, or an attended `--force` rebuild) + `install-host-timers.sh` to lay down the timer. The operator drives the box side. pin-watch's pre-smoke imports `torch, muq, sklearn, scipy`, so a broken stack rolls back.

## Safety rails (inline so they survive even if a doc is missed)

- The **nightly tick never fits** — assignment-only, so ids are stable and a bookmarked galaxy can never teleport. A full fit is an explicit operator act (`--cold-start` / `--remint`) or an operator-requested split consumed on the tick.
- The **box never mints identity** — ids + handles are minted server-side inside `update_galaxy_map`.
- **Naming is operator-only** — the box's agent token 403s the OPERATOR-tier `update_galaxy`; a machine handle never renders publicly.
- **A re-run never renames a galaxy** — the name is decoupled from the drifting math (minted-once-and-stored).
- The map write is **one transaction** (`db.batch`) and the run is **resume-safe** — no assignment ever points at a missing map row; member counts are derived, never drift.
