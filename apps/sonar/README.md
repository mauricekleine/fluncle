# sonar

Fluncle's vector sidecar: an in-memory, **exact** vector-similarity engine. It
holds the whole MuQ embedding corpus (~600MB, 1024-dim) in RAM and answers
nearest-neighbour queries with a brute-force, rayon-parallel, SIMD-friendly scan
— ~tens of ms single-probe at catalogue scale, with **100% recall**.

It exists because the live discovery surfaces (sonic search, "sounds like these
artists", "more like this", DJ-mix suggestions) are too slow on Turso's SQL
`vector_distance_cos` scan (seconds at scale), and Cloudflare Vectorize was
rejected (~150ms + recall loss from ANN). `sonar` reads the vectors from Turso
into memory and serves the raw fast search over HTTP. The Cloudflare Worker
(`apps/web`) owns all surface-specific logic: it calls `sonar` for the fast
nearest-neighbour lookup, then hydrates the returned ids from Turso.

This is the FIRST Rust app in the monorepo — same "non-TS app under `apps/`"
pattern as `apps/ssh` and `apps/dns` (Go). It is a standalone Cargo crate (its
own `[workspace]`), built/linted/tested in CI alongside the Go apps.

## What it holds

Two in-memory indexes, both refreshed periodically from Turso and hot-swapped
atomically (in-flight queries always see a consistent snapshot):

- **`tracks`** — one entry per embedded track. id = `track_id`, a 1024-dim f32
  vector, plus metadata `{ key, bpm, anchored, certified }`.
  `anchored = spotify_uri IS NOT NULL`; `certified` = the track has a `findings`
  row.
- **`centroids`** — one entry per artist centroid. id = `artist_id`, a 1024-dim
  f32 vector, no metadata.

Every vector is L2-normalized on load, so cosine similarity == a plain dot
product in the scan kernel.

## The scoring fold (important)

A query carries one OR MORE `probes`. A candidate's score is
**`max over probes of dot(probe, vector)`** — its similarity to the NEAREST
probe. This is the max-similarity-to-nearest fold from
[`docs/the-ear.md`](../../docs/the-ear.md). It is **never** a centroid/average of
the probes: a candidate that matches one probe perfectly wins even if it is far
from the others. A single probe is just that one dot.

## HTTP API

### `POST /search` (authenticated)

Requires header `x-sonar-secret: <SONAR_SECRET>` (constant-time compared).
Missing/wrong → `401`.

Request body:

```json
{
  "index": "tracks",
  "probes": [[0.01, -0.02, "... 1024 floats ..."]],
  "filter": {
    "key_in": ["Amin", "Emin"],
    "bpm_min": 168.0,
    "bpm_max": 176.0,
    "anchored": true,
    "certified": true
  },
  "exclude_ids": ["track_abc"],
  "top_k": 20
}
```

- `index` — `"tracks"` or `"centroids"`.
- `probes` — one or more 1024-dim query vectors. Scored by the nearest-probe fold
  above (normalized server-side). A wrong-dimension probe makes the request
  invalid → empty result.
- `filter` — optional. Every field is optional; a set field constrains, and a
  metadata constraint excludes entries that lack that metadata (so any metadata
  filter naturally excludes centroids). `bpm_min`/`bpm_max` are inclusive.
- `exclude_ids` — optional ids to omit from candidates.
- `top_k` — number of results to return.

Response body:

```json
{
  "matches": [
    { "id": "track_xyz", "score": 0.83 },
    { "id": "track_uvw", "score": 0.79 }
  ]
}
```

`score` is cosine similarity (higher == nearer), sorted descending. Invalid or
empty input (bad JSON, empty probes, wrong-dim probe, `top_k: 0`) returns
`{ "matches": [] }` — never a panic.

### `GET /health` (open)

```json
{ "tracks": 148231, "centroids": 5120, "last_refresh_unix": 1753200000, "ok": true }
```

Unauthenticated so Cloudflare health checks can hit it.

### `GET /` (open)

A one-line info string.

## Configuration (env)

| Var                  | Required | Default   | Meaning                                                      |
| -------------------- | -------- | --------- | ------------------------------------------------------------ |
| `TURSO_DATABASE_URL` | yes      | —         | Remote (read-only) Turso URL, e.g. `libsql://<db>.turso.io`. |
| `TURSO_AUTH_TOKEN`   | yes      | —         | Read-only Turso auth token.                                  |
| `SONAR_SECRET`       | yes      | —         | Shared secret for the `x-sonar-secret` header on `/search`.  |
| `SONAR_PORT`         | no       | `8080`    | Listen port.                                                 |
| `SONAR_BIND`         | no       | `0.0.0.0` | Bind address.                                                |
| `SONAR_REFRESH_SECS` | no       | `3600`    | Seconds between background index refreshes.                  |
| `SONAR_TLS_CERT`     | no       | —         | PEM cert path. HTTPS is served only when cert AND key set.   |
| `SONAR_TLS_KEY`      | no       | —         | PEM key path (paired with `SONAR_TLS_CERT`).                 |

Missing a required var (or setting only one of the TLS pair) fails fast with a
clear message. TLS is rustls-based (for the Cloudflare Origin Certificate the
deploy installs); with no TLS pair it serves plain HTTP.

The initial index load must succeed at startup (fail fast — nothing to serve
otherwise). A later refresh that fails logs and **keeps the current snapshot**, so
a transient Turso blip never empties the served index.

## No OpenSSL / no C-crypto (musl-static ready)

The binary is meant to build as a static musl binary for a cheap Linux box, so it
avoids any OpenSSL / native-tls / C-crypto dependency:

- Turso reads use `libsql` with `remote` + `tls` → **rustls backed by `ring`**.
- Server TLS uses `axum-server`'s `tls-rustls-no-provider` + `rustls` with the
  `ring` feature (the process installs `ring` as the default crypto provider at
  startup). This deliberately avoids `aws-lc-rs` (a C dependency).

`cargo tree | grep -i openssl` on macOS returns nothing. On **Linux** targets one
crate matches: `openssl-probe`, pulled transitively by `rustls-native-certs` (via
`hyper-rustls`). It is **pure Rust** — it only reads the filesystem PATHS where a
CA bundle might live; it links no `libssl`/`libcrypto` and pulls no `openssl-sys`.
It does not affect the musl static build. The meaningful checks —
`openssl-sys`, `native-tls`, `aws-lc-rs` — are absent on every target.

## Running locally

```sh
# From the repo root (or use --manifest-path apps/sonar/Cargo.toml from anywhere):
cd apps/sonar

TURSO_DATABASE_URL=libsql://<db>.turso.io \
TURSO_AUTH_TOKEN=<read-only-token> \
SONAR_SECRET=<shared-secret> \
cargo run --release

# health (open)
curl localhost:8080/health

# search (authenticated) — probes elided for brevity
curl -s localhost:8080/search \
  -H "x-sonar-secret: <shared-secret>" \
  -H "content-type: application/json" \
  -d '{"index":"tracks","probes":[[/* 1024 floats */]],"top_k":20}'
```

## Checks

```sh
cargo fmt --check           # formatting
cargo clippy --all-targets -- -D warnings   # lint
cargo build --release       # build
cargo test                  # unit + in-process API tests
```

## Bench

A synthetic scan bench (off the default test run) sanity-checks the latency
ballpark:

```sh
cargo run --release --bin bench
# → bench: n=150000 dim=1024 top_k=20 threads=<N> iters=30 single-probe_p50=…ms 12-probe_p50=…ms
```

Knobs: `SONAR_BENCH_N`, `SONAR_BENCH_ITERS`, `SONAR_BENCH_TOPK`,
`SONAR_BENCH_PROBES`.

## Layout

- `src/lib.rs` — module wiring + re-exports.
- `src/decode.rs` — little-endian f32 blob decode (`DIM=1024`, `BLOB_LEN=4096`).
- `src/index.rs` — the in-memory index: flat normalized vector store + metadata.
- `src/kernel.rs` — the dot kernel, the max-over-probes fold, and the rayon
  parallel single-pass bounded top-K scan.
- `src/search.rs` — the wire types (`SearchRequest`/`Filter`/`Match`/
  `SearchResponse`) + query orchestration (validate/normalize probes, candidate
  predicate, run the scan).
- `src/config.rs` — env config with fail-fast validation.
- `src/turso.rs` — remote read-only Turso load of both indexes.
- `src/server.rs` — the axum router, shared state (`ArcSwap` hot-swap), handlers,
  and the constant-time auth check.
- `src/main.rs` — thin entrypoint: config, initial load, refresh loop, serve.
- `src/bin/bench.rs` — the synthetic bench.
- `tests/api.rs` — in-process API test over the axum router.
