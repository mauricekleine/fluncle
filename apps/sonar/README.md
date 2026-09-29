# Sonar

Sonar is Fluncle's exact vector sidecar. It keeps the 1024-dimension MuQ track corpus and artist centroids in RAM, then answers cosine searches with one rayon-parallel scan. The Worker owns every surface rule and hydrates returned IDs from Turso.

## What it serves

The `tracks` index contains one row per embedded track. Each row keeps the raw filter facts `{ key, bpm, anchored, certified, has_finding, dismissed, is_duplicate, nearest_finding_score, duration_ms }`. `certified` means a finding with a Log ID exists. `has_finding` means any findings row exists. Those facts stay separate because the recommendations predicate needs the difference.

The `centroids` index contains one vector per artist and no metadata.

Vectors are decoded as exactly 4,096 little-endian bytes, validated, and L2-normalized in the served index. The durable local state keeps the original bytes unchanged. A candidate score is `max(dot(probe, candidate))` across every probe, never an average.

The HTTP search contract, filter null laws, request caps, and fallback behavior remain the contract documented in [vector-serving.md](../../docs/vector-serving.md). Unknown filter fields fail closed. Bad input returns an empty match list. `MAX_TOP_K` is 1,000 and `MAX_PROBES` is 32.

## Local data path

Sonar never runs a full corpus SELECT against hosted Turso.

In `replica` and `shadow` modes Sonar opens an official libSQL embedded replica at `SONAR_REPLICA_PATH` with `Builder::new_remote_replica`. No automatic sync interval is configured. Sonar calls `Database::sync()` explicitly, then source queries run against that local file. In `worker` mode it opens no replica and reads bounded source pages over the authenticated Worker API.

A separate embedded libSQL database at `SONAR_STATE_PATH` owns the consumer checkpoint and exact raw track projection. Source-replica files and consumer-state files must never share a path.

The steady loop has two lanes:

- Every `SONAR_DELTA_SECS`, Sonar reads a bounded, globally ordered artifact batch and consumes `sonar.track@1/1`.
- Every `SONAR_RECONCILE_SECS`, Sonar reconciles tracks and centroids from the selected source, syncing the replica in `replica` and `shadow` modes. This catches metadata mutations and deletions that do not emit an embedding event. A source or reconciliation failure leaves the served generation alone. A Worker listing that crosses the deletion guard starts a fenced, attested full rebuild.

There is no remote full-scan fallback. State corruption, a checkpoint divergence, or a compaction gap starts an exceptional full local rebuild. Corrupt derived state is retained as one bounded `.corrupt` generation and recreated automatically; the served in-memory generation stays untouched until its replacement validates.

## Bootstrap and rebuild

Registration establishes the producer fence. In replica and shadow modes Sonar syncs the local replica through that fence, computes each deterministic `sonar.track` snapshot page from the local keyset projection, and posts only the page checkpoint; the Worker re-reads and attests the same page. In worker mode Sonar downloads each snapshot page with its blobs through `listArtifactSnapshot`, checks the page and running digests, posts the same checkpoint, and retains accepted rows as local scratch state.

Before activation, replica and shadow modes sync once more, record local artifact head `H`, and build the candidate from the replica. Worker mode builds it from attested snapshot rows plus digest and selective item pages under the H0/H1 overlap window below. Sonar commits the complete candidate before activating the producer checkpoint; replay then catches the events after its baseline.

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

`GET /health` remains open. It reports the served track and centroid counts, build commit, checkpoint, local baseline, producer head, delta backlog and age, last successful replica sync, selected source, age of the last reconcile, the last shadow comparison, the last deletion guard trip, raw vector bytes, artifact contract, validation state, and the last rebuild duration. A request carrying the valid existing `x-sonar-secret` additionally receives `consumer_id`, which binds commissioning evidence to the exact artifact consumer without exposing that deployment identity to public probes. Authenticated and anonymous responses both carry `Cache-Control: no-store`, preventing an intermediary from reusing the private body for a public request. Fields have bounded names and values. Structured logs use closed stage and rebuild-cause names plus numeric counters.

`POST /search` still requires `x-sonar-secret`, compared in constant time.

## Configuration

| Variable               | Required       | Default   | Meaning                                                                                                                                                              |
| ---------------------- | -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURSO_DATABASE_URL`   | replica/shadow | none      | Remote source used only by embedded-replica sync.                                                                                                                    |
| `TURSO_AUTH_TOKEN`     | replica/shadow | none      | Read credential used only by embedded-replica sync.                                                                                                                  |
| `SONAR_REPLICA_PATH`   | replica/shadow | none      | Writable local embedded-replica file.                                                                                                                                |
| `SONAR_SOURCE`         | no             | `replica` | `replica`, `worker`, or `shadow`. Worker uses bounded read-only source pages and never opens a replica; shadow serves replica state and compares a Worker candidate. |
| `SONAR_STATE_PATH`     | yes            | none      | Writable local consumer-state database.                                                                                                                              |
| `FLUNCLE_API_BASE_URL` | yes            | none      | Base URL for agent-authenticated artifact operations.                                                                                                                |
| `FLUNCLE_API_TOKEN`    | yes            | none      | Agent token for artifact operations.                                                                                                                                 |
| `SONAR_CONSUMER_ID`    | yes            | none      | Stable artifact consumer identity.                                                                                                                                   |
| `SONAR_SECRET`         | yes            | none      | Shared secret for search requests.                                                                                                                                   |
| `SONAR_DELTA_SECS`     | no             | `30`      | Delay between bounded change reads.                                                                                                                                  |
| `SONAR_RECONCILE_SECS` | no             | `21600`   | Delay between source reconciliations.                                                                                                                                |
| `SONAR_BATCH_LIMIT`    | no             | `100`     | Change batch size, maximum 500.                                                                                                                                      |
| `SONAR_SNAPSHOT_LIMIT` | no             | `200`     | Fenced snapshot attestation page size, maximum 200.                                                                                                                  |
| `SONAR_PORT`           | no             | `8080`    | Listen port.                                                                                                                                                         |
| `SONAR_BIND`           | no             | `0.0.0.0` | Bind address.                                                                                                                                                        |
| `SONAR_TLS_CERT`       | no             | none      | PEM certificate path. Set with the key.                                                                                                                              |
| `SONAR_TLS_KEY`        | no             | none      | PEM key path. Set with the certificate.                                                                                                                              |
| `SONAR_VALIDATE_ONLY`  | no             | `false`   | Pre-smoke mode. Reads and validates existing local state, serves health, and performs no sync or artifact mutation.                                                  |

Worker source paging uses an overlap window. Sonar reads the artifact head H0 before listing and H1 after all track and centroid pages, then commits the candidate with `baseline_seq=H0` and `overlap_through=H1`. It skips replay through H0. In `(H0,H1]`, an event at or below the stored subject revision is covered by the later source row; a higher revision applies. After catch-up passes H1, Sonar rechecks every subject whose overlap event applied against bounded Worker item reads. It removes absent tracks and corrects changed revisions or bytes before publishing the corrected generation. The pending subject set survives a crash. Above H1, strict immutable revision and byte checks apply. The window is durable in the local manifest, including across a crash after candidate commit. A moving head does not make a valid listing fail. The committed systemd unit creates a private writable state directory. Operator configuration points both local paths into it. Concrete credentials and topology stay outside this public repository.

The Worker rebuild retains the blobs from attested `listArtifactSnapshot` pages in local scratch state. Digest listing pages supply their revisions; unchanged snapshot rows are reused, and only rows changed during paging need another item fetch. Worker and replica shadow parity compares the served-content digest of the track and centroid indexes. Equal digests match even if the sampled heads differ. On a digest mismatch, Sonar reads the change feed without acknowledging it and marks the comparison inconclusive only when every differing subject changed between the sampled heads. The revision and tombstone ledger is excluded because the Worker source has no tombstone listing; revisions do not enter search results, while overlap rechecks and strict checks above H1 protect serving state. An empty listing against a non-empty manifest, or a listing that would remove more than `max(100, 2% of current subjects)`, triggers a fenced full rebuild; `/health.last_reconcile_guard` records the time, gross deletion count, and prior manifest digest.

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
- `source.rs` owns source selection, Worker page validation, and bounded source item reads.
- `state.rs` owns durable raw state, pending acknowledgements, validation, and candidate builds.
- `consumer.rs` owns bootstrap, reconciliation, delta application, recovery, and publication ordering.
- `index.rs`, `kernel.rs`, and `search.rs` own the exact scan and filter semantics.
- `server.rs` owns the unified published generation, health, HTTP routing, and search authentication.
- `main.rs` wires configuration, local state, the consumer loop, and the server.
- `deploy/` owns the runtime unit and self-deploy loop.
