#!/usr/bin/env python3
# cluster.py — the k-means FIT helper for the `fluncle-cluster` sweep (host timer).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). Invoked by the bun orchestrator (cluster-sweep.ts)
# ONLY for the OPERATOR-ACT full fits — the cold start (k=9 over the whole corpus), a
# `--remint` (a fresh k=9), and a split (k=2 over one galaxy's members). The NIGHTLY tick is
# assignment-only and pure TS (nearest-centroid + mean), so it never spawns this script: a
# stable map never pays the sklearn import.
#
# WHY A FIT IS AN OPERATOR ACT, NEVER THE NIGHTLY DEFAULT (docs/agents/cluster-engine.md):
# a full `KMeans.fit` can relocate an emptied centroid to a far high-inertia point mid-Lloyd
# (`_relocate_empty_clusters`), i.e. teleport a bookmarked galaxy across the map. So the timer
# never fits; the operator triggers cold-start / remint / (via `split_requested_at`) a split.
#
# Contract (stdin -> stdout, both JSON, nothing else on stdout) — a single fit job:
#   stdin : {"k": <int>, "vectors": [[<float>, ...], ...]}   # vectors are MuQ 1024-d rows
#   stdout: {"centroids": [[<float>, ...], ...]}             # k L2-normalized centroids
# The output is JUST the centroids (L2-normalized so they are valid cosine anchors): the
# orchestrator SEEDS the map with them, then always assigns findings by nearest STORED
# centroid — so the fit never has to hand back labels tied to an index the box would then
# have to reconcile with server-minted ids. Diagnostics -> stderr; a bad job -> a JSON
# `{"error": ...}` + a nonzero exit (the tick leaves the map untouched).
#
# MuQ vectors are L2-normalized at embed time, so Euclidean k-means on them IS spherical /
# cosine k-means (the exact metric get_similar_findings ranks with). `n_init="auto"` +
# `random_state=0` + a pinned thread env (OMP_NUM_THREADS=1, set by cluster-sweep.sh) make
# the fit deterministic across rebuilds. sklearn + scipy are the pinned third pip step in
# the MuQ venv (the Dockerfile MuQ layer); numpy is the already-baked version.

import json
import os
import sys


def log(message: str) -> None:
    print(f"[cluster] {message}", file=sys.stderr, flush=True)


def fit(k: int, vectors) -> list:
    """k-means over `vectors`, returning k L2-normalized centroids (a cosine anchor per
    cluster). Deterministic: fixed random_state + n_init='auto' + the pinned thread env."""
    import numpy as np
    from sklearn.cluster import KMeans

    matrix = np.asarray(vectors, dtype=np.float64)

    if matrix.ndim != 2 or matrix.shape[0] == 0:
        raise ValueError("vectors must be a non-empty 2-D array")

    # Never ask for more clusters than distinct points — KMeans errors when k > n_samples.
    k = max(1, min(int(k), matrix.shape[0]))

    model = KMeans(n_clusters=k, n_init="auto", random_state=0)
    model.fit(matrix)

    centroids = np.asarray(model.cluster_centers_, dtype=np.float64)

    # L2-normalize each centroid so downstream cosine assignment (max dot product) is exact;
    # a degenerate all-zero centroid (an empty fit cluster) falls back to a zero vector,
    # which the orchestrator's nearest-centroid never selects over a real one.
    norms = np.linalg.norm(centroids, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normalized = centroids / norms

    return normalized.tolist()


def main() -> int:
    try:
        job = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        print(json.dumps({"error": f"bad job: {error}"}))
        return 1

    if not isinstance(job, dict):
        print(json.dumps({"error": "job must be an object"}))
        return 1

    vectors = job.get("vectors")
    k = job.get("k")

    if not isinstance(vectors, list) or not vectors:
        print(json.dumps({"error": "job.vectors must be a non-empty array"}))
        return 1

    if not isinstance(k, int) or k < 1:
        print(json.dumps({"error": "job.k must be a positive integer"}))
        return 1

    try:
        log(f"fitting k={k} over {len(vectors)} vectors")
        centroids = fit(k, vectors)
    except Exception as error:  # noqa: BLE001 — surface any fit failure as JSON, never a stack trace on stdout
        print(json.dumps({"error": str(error)}))
        log(f"fit failed: {error}")
        return 1

    print(json.dumps({"centroids": centroids}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
