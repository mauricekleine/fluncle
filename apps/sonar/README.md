# Sonar

Sonar is Fluncle's exact vector sidecar. It keeps the 1024-dimension MuQ track corpus and artist centroids in RAM, then answers cosine searches with one rayon-parallel scan. The Worker owns every surface rule and hydrates returned IDs from Turso.

## What it serves

The `tracks` index contains one row per embedded track. Each row keeps the raw filter facts `{ key, bpm, anchored, certified, has_finding, dismissed, is_duplicate, nearest_finding_score, duration_ms }`. `certified` means a finding with a Log ID exists. `has_finding` means any findings row exists. Those facts stay separate because the recommendations predicate needs the difference.

The `centroids` index contains one vector per artist and no metadata.

Vectors are decoded as exactly 4,096 little-endian bytes, validated, and L2-normalized in the served index. The durable local state keeps the original bytes unchanged. A candidate score is `max(dot(probe, candidate))` across every probe, never an average.

The HTTP search contract, filter null laws, request caps, and fallback behavior remain the contract documented in [vector-serving.md](../../docs/vector-serving.md). Unknown filter fields fail closed. Bad input returns an empty match list. `MAX_TOP_K` is 1,000 and `MAX_PROBES` is 32.

## Local data path

Sonar never runs a full corpus SELECT against hosted Turso.

It opens an official libSQL embedded replica at `SONAR_REPLICA_PATH` with `Builder::new_remote_replica`. No automatic sync interval is configured. Sonar calls `Database::sync()` explicitly, then every track, revision, and centroid query runs against that local file.

A separate embedded libSQL database at `SONAR_STATE_PATH` owns the consumer checkpoint and exact raw track projection. Source-replica files and consumer-state files must never share a path.

The steady loop has two lanes:

- Every `SONAR_DELTA_SECS`, Sonar reads a bounded, globally ordered artifact batch and consumes `sonar.track@1/1`.
- Every `SONAR_RECONCILE_SECS`, Sonar explicitly syncs the replica and runs a full local reconciliation of tracks and centroids. This catches metadata mutations that do not emit an embedding event. A sync or reconciliation failure leaves the served generation alone.

There is no remote full-scan fallback. State corruption, a checkpoint divergence, or a compaction gap starts an exceptional full local rebuild. Corrupt derived state is retained as one bounded `.corrupt` generation and recreated automatically; the served in-memory generation stays untouched until its replacement validates.

## Bootstrap and rebuild

Registration establishes the producer fence. Sonar explicitly syncs the local replica through that fence, computes each deterministic `sonar.track` snapshot page from the local keyset projection, and posts only the page checkpoint. The Worker re-reads and attests the same page. Snapshot vectors never travel back to Sonar over the admin API.

Before activation, Sonar syncs once more, records local artifact head `H`, durably builds the complete track and centroid candidate from the local replica, and makes that generation visible. Only then does it activate the producer checkpoint. Events through `H` are still validated in global order and acknowledged as baseline-covered. Events above `H` apply normally.

The local snapshot preserves producer revisions, including receipts whose event bodies were compacted. Tombstones retain their subject revision after the row disappears, so delayed delivery cannot resurrect a deleted track.

## Crash ordering

One batch follows this order:

1. Validate sequence boundaries, versions, subject shape, canonical JSON, raw vector bytes, every payload digest, and the ordered batch digest.
2. Apply the batch and write its pending acknowledgement inside one local transaction.
3. Build and validate the complete candidate from that transaction.
4. Commit the raw state, manifest, counts, bytes, deterministic digest, checkpoint, and pending receipt.
5. Publish one `PublishedSnapshot` through a single `ArcSwap`.
6. Acknowledge the exact producer batch.
7. Clear the local pending receipt.

A crash before the local commit causes redelivery. A crash after the commit rebuilds and publishes the committed candidate before acknowledgement. A crash after the remote acknowledgement reconciles through consumer status, because repeating a committed acknowledgement is a regression in the producer protocol.

Tracks, centroids, and checkpoint metadata live in one published generation. A request takes one full `Arc`. Sonar streams local source rows into its durable candidate and refuses to build another generation while a retired generation is still held by an in-flight request. One current generation plus one candidate or retired generation is the bound; freshness waits rather than creating a third corpus.

## Health

`GET /health` remains open. It reports the served track and centroid counts, build commit, checkpoint, local baseline, producer head, delta backlog and age, last successful replica sync, raw vector bytes, artifact contract, validation state, and the last rebuild duration. Fields have bounded names and values. Structured logs use closed stage and rebuild-cause names plus numeric counters.

`POST /search` still requires `x-sonar-secret`, compared in constant time.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `TURSO_DATABASE_URL` | yes | none | Remote source used only by embedded-replica sync. |
| `TURSO_AUTH_TOKEN` | yes | none | Read credential used only by embedded-replica sync. |
| `SONAR_REPLICA_PATH` | yes | none | Writable local embedded-replica file. |
| `SONAR_STATE_PATH` | yes | none | Writable local consumer-state database. |
| `FLUNCLE_API_BASE_URL` | yes | none | Base URL for agent-authenticated artifact operations. |
| `FLUNCLE_API_TOKEN` | yes | none | Agent token for artifact operations. |
| `SONAR_CONSUMER_ID` | yes | none | Stable artifact consumer identity. |
| `SONAR_SECRET` | yes | none | Shared secret for search requests. |
| `SONAR_DELTA_SECS` | no | `30` | Delay between bounded change reads. |
| `SONAR_RECONCILE_SECS` | no | `3600` | Delay between explicit replica sync plus full local reconciliation. |
| `SONAR_BATCH_LIMIT` | no | `100` | Change batch size, maximum 500. |
| `SONAR_SNAPSHOT_LIMIT` | no | `200` | Local snapshot attestation page size, maximum 200. |
| `SONAR_PORT` | no | `8080` | Listen port. |
| `SONAR_BIND` | no | `0.0.0.0` | Bind address. |
| `SONAR_TLS_CERT` | no | none | PEM certificate path. Set with the key. |
| `SONAR_TLS_KEY` | no | none | PEM key path. Set with the certificate. |
| `SONAR_VALIDATE_ONLY` | no | `false` | Pre-smoke mode. Reads and validates existing local state, serves health, and performs no sync or artifact mutation. |

The committed systemd unit creates a private writable state directory. Operator configuration points both local paths into it. Concrete credentials and topology stay outside this public repository.

## Static build

The release remains a static `x86_64-unknown-linux-musl` binary built with `target-cpu=x86-64-v3`. Server TLS, artifact HTTP, and replica sync use rustls with ring. The embedded libSQL core is linked into the artifact; OpenSSL, native-tls, and aws-lc are not required.

## Checks

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The deterministic tests cover the existing API and search behavior, digest fixtures, global ordering, strict tombstones, duplicate and stale revision handling, crash checkpoints, state corruption, candidate rollback, restart recovery, and convergence with a full local rebuild at scaled corpus sizes.

## Layout

- `artifact.rs` owns the exact `sonar.track@1/1` wire types, HTTP calls, and digests.
- `replica.rs` owns explicit sync and local source projections.
- `state.rs` owns durable raw state, pending acknowledgements, validation, and candidate builds.
- `consumer.rs` owns bootstrap, reconciliation, delta application, recovery, and publication ordering.
- `index.rs`, `kernel.rs`, and `search.rs` own the exact scan and filter semantics.
- `server.rs` owns the unified published generation, health, HTTP routing, and search authentication.
- `main.rs` wires configuration, local state, the consumer loop, and the server.
- `deploy/` owns the runtime unit and self-deploy loop.
