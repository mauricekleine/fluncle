# The Ear — the ranked catalogue

The catalogue is every track the archive knows and Fluncle never certified: a row in `tracks` with **no row in `findings`**. The Ear is what makes that pile useful — `/admin/catalogue`, ranked by one question: _how close does this sit to something he already loves?_

**It is a telescope, not a conveyor belt.** The operator finds ~15 bangers a week, so volume is not his constraint. But that pace is necessarily shallow and recency-biased — he sees whatever the feeds put in front of him, while whole regions of the genre (older releases, small labels, the long tail) never cross his path. The Ear points at the tracks sitting near what he already loves and never reached him. It is a short, high-conviction list he _wants_ to open, and if it ever feels like a backlog to grind, it has failed — the fix then is fewer rows, never more.

Nothing here is a finding, and nothing here can become one by accident: a catalogue row has no Log ID, no note, no video, no galaxy, because those columns live on `findings` and this row has none. The tier has **no public name** — `catalogue` is the internal word (code, docs, `/admin`) and never surfaces in public copy.

## The ranking: max-similarity to ANY finding

A candidate's score is the cosine similarity to its **single nearest finding**. Not to a centroid, and this is the decision the whole feature turns on: the operator's taste is multi-modal — the k=4 galaxy fit found four regions he could name by ear — and the mean of four regions is a place none of his taste actually lives. A liquid roller has to be allowed to win on the liquid findings alone, without being dragged down by the neuro ones.

The proof is executable: `catalogue.integration.test.ts` seeds a corpus of eight findings crowded on one axis and one lonely finding on another, then asserts that a dead ringer for the **lonely** finding outranks a mediocre match for the crowd. Under a centroid ranking that assertion inverts.

**And every row carries its WHY.** The score is the claim; the finding it matched is the evidence. A row reads _"Closest to 012.2.4L · Krakota — See For Miles"_, never a bare `0.91`. An instrument the operator cannot interrogate is one he stops looking through.

## The architecture: precompute, then read

Ranking the catalogue against the findings at request time is a **cross join**: at 10k catalogue rows × 60 findings that is 600,000 cosine operations over 1024-dimension vectors, per page load. It does not get slow — it dies.

So the arithmetic happens **once, ahead of time**, in a periodic sweep, exactly like the cluster engine's nightly assignment tick ([docs/agents/cluster-engine.md](./agents/cluster-engine.md)). The sweep stores each catalogue track's answer on the row; the page then does an ordered walk of an indexed column. **There is no vector math on the request path at all.**

Five columns on `tracks`, written **only** by the sweep and meaningful **only** on a catalogue row (the sweep anti-joins `findings` and never touches one, so a non-null `nearest_finding_score` is itself a catalogue marker):

| column                     | what it holds                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `nearest_finding_score`    | cosine similarity to the nearest finding (`1 − vector_distance_cos`, so higher is nearer). The Ear's sort key.     |
| `nearest_finding_track_id` | **which** finding. The row's WHY.                                                                                  |
| `capture_priority`         | 0–3, the pre-audio ladder. The capture queue's sort key.                                                           |
| `catalogue_rank_corpus`    | the finding-corpus fingerprint the two above were computed against, `"<findings>:<embedded>"`. The staleness test. |
| `catalogue_ranked_at`      | when. Freshness for the operator; never a predicate.                                                               |

Two indexes (`tracks_nearest_finding_score_idx`, `tracks_capture_priority_idx`) serve the two ordered reads. NULLs sort first in an ASC index, so a DESC walk hits the ranked rows first and stops at the page's `LIMIT` — the cost is the page, not the corpus.

### The three database rules, all load-bearing

Per [docs/local-database.md](./local-database.md):

1. **Rank in SQL.** `vector_distance_cos(candidate.vec, finding.vec)` runs in the database and only the winners come back — two scalars per candidate. Pulling vectors into the isolate to rank them is what OOMs the 128 MB Worker.
2. **Both sides of the distance are stored BLOB columns**, never a bound text vector. (The 14× text-probe cliff is about _binding_ a probe; there is no probe here — this is a column-to-column join, which never re-parses anything.)
3. **No ANN index.** `libsql_vector_idx` wedged hosted Turso's write path for 20+ minutes in the spike. The exact scan is the ratified shape, and here it is bounded to `batch × findings` — which is what the batching is for.

### Self-healing, by fingerprint

Staleness is a fingerprint of the finding corpus, `"<findings>:<embedded findings>"`, stored on every ranked row. Both numbers move whenever the answer could change: log a finding and the first moves (a new artist/label affinity, a new candidate to be near); embed one and the second moves. A row whose stored fingerprint differs from the live one is stale and re-ranks on a later tick.

So the sweep **converges on its own after any archive change** and needs no invalidation call from the publish path. It is compared with `<>`, never `<`, so a _deleted_ finding is caught exactly like an added one. On an unchanged archive the tick is a no-op.

### The cost model

|                                   |                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per tick                          | `candidates-with-a-vector × embedded findings` distance computations, all inside the database. At the default batch of 250 and 60 findings: **15,000**.                      |
| A full re-rank of a 10k catalogue | 40 ticks, **600k** computations — done once, off the request path, instead of once per page load.                                                                            |
| Per page load                     | **zero.** An indexed walk of 50 rows, plus one batched hydrate of the matched findings.                                                                                      |
| Wire                              | The sweep's candidate read returns `(track_id, artists_json, label, has_vector)`; the ranking returns `(candidate, finding, distance)`. **No vector ever crosses the wire.** |

## The capture queue — and the chicken-and-egg it exists to solve

A catalogue track has **no vector until its audio has been captured**, and capture is metered (a residential proxy bills per GB) — so we will not capture everything. Which means the Ear's score cannot be what prioritises capture: the tracks that most need capturing are precisely the ones with no score yet.

`capture_priority` is the pre-audio answer — the cheap metadata signals that _can_ be read before a single byte is downloaded, ordered as a small, explainable ladder rather than a model, because the operator has to be able to see why a track is next:

| tier | rung            | the claim                                                                                                                                        |
| ---- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✗    | `skipped-label` | **the veto, checked first.** Its label is one the operator ruled out. Tier **−1**, whatever else is true of the track.                           |
| 3    | `artist`        | an artist on it is **already on a finding**. His ear has said yes to this artist — the strongest signal there is.                                |
| 2    | `label`         | its label already carries a finding. A DnB label is a curator; a label he has found on is a crate he digs in.                                    |
| 1    | `seed-label`    | its label is one he rules the crawler may seed from ([docs/label-entity.md](./label-entity.md)), nothing certified on it yet. In-lane, unproven. |
| 0    | `none`          | nothing ties it to the archive.                                                                                                                  |

**The veto is not decoration, and it was caught on real data.** Every one of the operator's 8 **disabled** labels — Anjunabeats, Armada, Axtone, Positiva … — _carries a finding_: each arrived on a single crossover remix. So without the veto, the `label` rung fires on all of them, and the capture queue spends a metered, per-GB audio budget buying trance and house records he has explicitly said are not his lane.

And it does **not** breach the crawl-scope-never-storage rule. A ruling governs what Fluncle _acquires_ next, and a capture **is** an acquisition — the same class of act as a crawl, just further down the same pipe. Nothing stored moves: the track keeps its row, keeps appearing in the capture lens, and keeps an honest reason line ("not your lane. Ranked last, kept anyway."). It is ordered last, never deleted, hidden, or changed. This is the one sanctioned way `seed_state` reaches the ranking, and it decides an ORDER, never a visibility.

`capturePriorityFor` is **pure**, and it is the ladder's single authority: the sweep calls it to _write_ the tier, and the surface calls it to _explain_ the tier. They cannot drift, because they are the same function. Label matching goes through `labelSlug` — the same fold that makes `Pilot.` and `Pilot` one label everywhere else.

The two lenses are **disjoint by construction**: scoring a track clears its `capture_priority` (it has audio, so capturing it again is the one thing the queue must never ask for), and the capture lens is exactly "catalogue, no score yet".

**The veto has its own tier, and that is what makes it enforceable.** It first shipped sharing `none`'s 0, which left it invisible to SQL — the capture _work queue_ could not tell "capture this last" from "never spend a metered per-GB byte on this", so the veto could only ever be a sort. And a sort is not a veto: the queue drains, and last arrives. At **−1** it is a predicate (`capture_priority >= 0`), and every display property above survives untouched — the row keeps its place in the capture lens, still sorts last, still carries its honest reason line. Ordered last, kept anyway, and never bought.

`capture_priority` is what the **work queues** ([docs/gpu-batch-embed.md](./gpu-batch-embed.md)) actually drain on: `list_track_work` serves capture, analysis, and embedding off `tracks`, ordered certified-first and then by this ladder. The veto is scoped to **capture** alone — a ruling governs what Fluncle _acquires_, not what he may _measure_, so a vetoed track whose bytes are already on file is still analysed and embedded (and its vector is how The Ear gets to disagree with the ladder).

This repo does **not** build the capture itself — the acquisition layer lives in the private companion repo (the-archive RFC, D6). The Ear ships the queue and the priority signal; the layer that acts on them reads `capture_priority` and works down.

## The surface

`/admin/catalogue`, one AdminShell station under Findings/Artists/Labels/Galaxies in the sidebar ([docs/admin-shell.md](./admin-shell.md)). Two lenses in the subheader strip, deep-linked through `?lens=` so a pasted URL restores the view:

- **Closest to a finding** (`?lens=ear`, the default) — the telescope. Each row: the cover, the identity, the WHY, the score, and one primary action — **Listen** (Spotify). There is no in-app preview for a catalogue track: the `/ln` relay resolves through `findings`, by design, so the audition is the real one.
- **Next to capture** (`?lens=capture`) — the rows with no audio at all, ranked by the ladder above, each carrying the rung that put it there.

**No count badge on the sidebar entry.** The honest number is "how many are worth your time", and a `COUNT` cannot answer that. A telescope with a backlog badge is a conveyor belt.

**Nothing on the page is lit like a finding**: no coordinate line, no gold story-ring, no note. The rows are the same _shape_ as a finding's row and deliberately not the same _weight_ — he has not been to these ones.

The header carries **Re-rank**, one tick of the sweep by hand. The sweep is a periodic job, but the operator must be able to log a finding, poke it, and watch the ranking move — otherwise the list's freshness is something he has to take on faith.

## The ops

Both `adminAuth` (operator **or** agent), registered in the contract as `admin-catalogue`:

- **`list_catalogue_tracks`** → `GET /admin/catalogue?lens=&limit=` — the ranked read + the summary.
- **`rank_catalogue`** → `POST /admin/catalogue/rank?limit=` — one tick of the sweep. `remaining > 0` means run it again.

`rank_catalogue` is **agent-allowed, not operator-tier** (the `update_galaxy_map` precedent): it writes only _derived_ ranking columns, and only on catalogue rows. It cannot mint a coordinate, write a note, or certify anything — those columns do not exist on the rows it can reach.

The CLI mirrors both, and holds no ranking logic of its own:

```bash
fluncle admin catalogue rank --limit 250 --json   # one tick — the sweep a cron drives
fluncle admin catalogue list --lens ear           # the telescope
fluncle admin catalogue list --lens capture       # what to capture next
```

## Where it stands

**The catalogue is empty today.** The crawler that fills it is a separate unit; until it lands, `/admin/catalogue` renders its truthful empty state and the sweep is a no-op. Everything downstream of a catalogue row — the ranking, the two lenses, the ladder — is built, tested against real vectors on a real libSQL engine, and waiting.

**The periodic cron landed with the crawler**, exactly as this section asked: a timer that ranks an empty table would be a `/status` row that means nothing, and [the crawler](./catalogue-crawler.md) is what creates rows. It is now the on-box **`fluncle-rank`** sweep — every 30m, trailing the crawl's 10m, draining the stale set rather than taking one bite of it ([docs/agents/hermes/rank-timer/](./agents/hermes/rank-timer/README.md); box activation is operator-gated). The **Re-rank** button and the CLI remain the same op, for when the operator wants it now.

## Files

- `apps/web/src/lib/server/catalogue.ts` — the sweep, the ladder, and the two reads.
- `apps/web/src/lib/server/catalogue.integration.test.ts` — **the ranking proof** (real vectors, real SQL, the centroid case).
- `apps/web/src/lib/server/catalogue.test.ts` — the pure ladder + the staleness fingerprint.
- `apps/web/src/routes/admin/catalogue.tsx` — the station.
- `packages/contracts/src/orpc/admin-catalogue.ts` + `apps/web/src/lib/server/orpc/admin-catalogue.ts` — the two ops.
- `apps/cli/src/commands/admin-catalogue.ts` — the thin HTTP client.
