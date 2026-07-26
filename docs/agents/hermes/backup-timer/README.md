# fluncle-backup-timer — the nightly backup sweep on a host timer

The rave-02 host trigger for the `--no-agent` **backup** sweep. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 24h, and the sweep runs **two legs** in one tick:

| Leg                 | What it saves                                                                                    | Where it lands                                          | Retention            |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------- |
| 1 — the database    | the PRODUCTION Turso database, as gzipped SQL + an integrity manifest                            | `db-backups/{daily,monthly}/…` in the private R2 bucket | 30 daily, 12 monthly |
| 2 — the box's state | the load-bearing subset of the agent data dir, tarred and **encrypted** (+ a plaintext manifest) | `box-state/{daily,monthly}/…` in the same bucket        | 14 daily, 6 monthly  |

Zero LLM tokens either way. The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh` entry ([`../scripts/backup-sweep.sh`](../scripts/backup-sweep.sh)) plus the two bun modules it drives ([`../scripts/backup-sweep.ts`](../scripts/backup-sweep.ts) and [`../scripts/box-state-snapshot.ts`](../scripts/box-state-snapshot.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources the shared secrets env file and runs the bun orchestrator.

## Leg 1 — the database dump (LIVE)

Dumps the prod DB over the libSQL HTTP pipeline → gzip → an S3-direct PUT to a PRIVATE R2 bucket (the owned off-site backup) → prune to the retention window. Turso's managed point-in-time restore is the belt; this is the braces. `apps/web/scripts/restore-drill.ts` is its acceptance test, fed by a local dry run:

```bash
bun docs/agents/hermes/scripts/backup-sweep.ts --out <dir>   # dump + gzip + manifest, no R2
```

**The dump STREAMS, and must keep streaming.** Until 2026-07-26 the sweep built the whole dump as one JavaScript string, then `Buffer.from`'d it, then `gzipSync`'d it — three simultaneous full copies of the payload, and a JS string is UTF-16, so the 323 MB dump of 2026-07-23 wanted ≈650 MB for the string alone. The container is capped at 4 GiB with no swap: the sweep was OOM-killed on three consecutive nights (2026-07-24/25/26, `status=137`, `oom-kill:constraint=CONSTRAINT_MEMCG`), the last good backup was 2026-07-23, and nothing about that shape self-heals — it worsens as the archive grows.

Now rows are paged out of libSQL a batch at a time (`FLUNCLE_BACKUP_ROW_BATCH`, default 1,000), rendered straight into a gzip stream, and the gzip lands in a temp FILE that is uploaded by streaming it back off disk (signed with a SHA-256 computed the same way). **Measured: peak RSS is flat at ~130 MB from a 48 MB dump to a 1.9 GB dump** — bounded by the page size, not the database size. The unit tests hold that line; keep the shape (never join the dump, never `Buffer.from` it, never read the artifact back with `readFileSync`).

The dump FORMAT is unchanged and byte-for-byte enforced: `backup-sweep.test.ts` imports the real `buildDumpSql` from `apps/web/src/lib/server/db-dump.ts` and asserts equality with the streamed output, so a drift on either side goes red.

**Leg 1 needs temp disk** for the gzip artifact (`FLUNCLE_BACKUP_TMPDIR`, default the system temp dir) — currently ~90 MB. The `/status` `disk` probe already degrades past ~85% full, which is the early warning.

## Leg 2 — the box-state snapshot (SHIPPED, DORMANT until the operator adds a key)

**The backup that never existed.** Several docs claimed the accumulated agent state — sessions, memories, kanban, cron-output history — "restores from the daily `fluncle-backup` → R2 backup". It did not: leg 1 dumps the production database and never reads the agent data dir. The server has no attached volumes (state sits on the root disk) and no provider-level snapshots, so a disk loss permanently destroyed everything the box had accumulated — including the render conductor's `box-id`, whose loss **orphans a paid provisioned render box** nobody can then find or delete.

**What it takes** (small, unrecoverable, load-bearing):

- the gateway state db (`state.db` + `-wal`/`-shm`) — sessions, memories index, kanban, the Discord channel binding
- `config.yaml` — the gateway's expanded config, the other half of the Discord binding
- `memories/` — the agent's own memory files
- `cron/output/` — the run markers `/status` judges every cron by
- the cron user's `.render-conductor/` (`box-id` + the poison ledger) and `.healthcheck/` (the transition memory, so a restore doesn't re-baseline every service)
- the hand-placed `0600` `*.env` files in the data dir and the cron user's home — discovered rather than named, so a new one is covered the night it appears

**What it deliberately leaves** — this is the difference between a few-MB nightly and a 5 GB one:

- `audit-workspace/` + `sentry-triage-workspace/` — the audit/triage git checkouts, ~5.3 GB of the 5.4 GB total. `git clone` restores them exactly.
- `skills/`, `scripts/` — baked into the image; the repo is canonical.
- `bin/`, `.bun/`, `.ascii/`, the model + package caches — re-downloadable.
- `logs/` — diagnostics, not state.

The exclusion is enforced in code, not just documented: `selectBoxStatePaths` drops any candidate that walks through an excluded segment, and the whole selection is measured against `FLUNCLE_BOXSTATE_MAX_BYTES` (default 64 MiB) **before** `tar` runs — so a fat include list fails loudly instead of re-creating the OOM this change exists to end.

### Encryption is the gate, and there is no plaintext fallback

The archive carries `0600` credential-bearing env files, and the standing rule for the agent home is _an encrypted/snapshot copy only — never a plaintext off-box tarball_. So the artifact is sealed **in-process** with AES-256-GCM (WebCrypto) before it leaves, as `FLNCBOX1 ‖ 12-byte IV ‖ ciphertext‖tag`, with the magic doubling as the AAD.

Why not `age`/`gpg`: neither is in the image, and adding a binary means an image rebake the operator has to sequence — a dependency this leg does not need. Why not R2 server-side encryption: it would leave the plaintext-at-rest boundary with the same provider that holds the bucket, which is the opposite of what an owned off-site backup is for.

**With no key there is no artifact.** `FLUNCLE_BOXSTATE_KEY` unset ⇒ leg 2 reports `{"boxState":{"skipped":true,"reason":"no_encryption_key"}}` and uploads nothing. That is the shipped state today: **leg 2 is dormant until the operator provisions the key** (below). Leg 1 is unaffected either way.

The manifest beside the artifact is deliberately NOT encrypted — it lists relative paths, sizes, the archive's SHA-256 and the cipher size, so the backup can be inventoried and verified without the key. It carries no file contents.

### Operator step — mint the key (one time, required to activate leg 2)

1. Mint a 32-byte key and store it in the automations 1Password vault:

   ```bash
   openssl rand -hex 32
   ```

   **Store it somewhere the box's disk loss cannot take with it.** A key that only exists on the machine the backup protects is not a key.

2. Add it to the box's `op inject` template (materialised to the shared secrets env file by `fluncle-secrets-sync` — see [`../secrets/`](../secrets/)), using a PLACEHOLDER `op://` path:

   ```bash
   # Box-state snapshot (fluncle-backup leg 2). Without this the leg SKIPS — it will
   # never write a plaintext tarball.
   FLUNCLE_BOXSTATE_KEY=op://<vault>/<item>/box_state_key
   ```

3. Dry-run it on the box before trusting the nightly (no R2, artifact written locally):

   ```bash
   docker exec -u hermes -e HOME=/opt/data/home hermes \
     bun /opt/hermes-scripts/backup-sweep.ts --box-state-out /tmp/box-state-check
   ```

   Expect `{"ok":true,"dryRun":true,"entryCount":…,"cipherBytes":…}` and a few MB, not a few GB. Delete the local artifact afterwards.

The existing R2 token already covers leg 2 (same bucket, Object Read & Write) — no new bucket, no new credential beyond the key.

### Restoring from leg 2

Decrypt with the key, verify the manifest's `sha256`, then untar into the data root:

```bash
# <key> = the same hex string as FLUNCLE_BOXSTATE_KEY
bun -e '
  const [enc, key, out] = process.argv.slice(1);
  const b = new Uint8Array(await Bun.file(enc).arrayBuffer());
  const magic = new TextEncoder().encode("FLNCBOX1");
  const k = await crypto.subtle.importKey("raw", Buffer.from(key, "hex"), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { additionalData: magic, iv: b.subarray(8, 20), name: "AES-GCM" }, k, b.subarray(20));
  await Bun.write(out, plain);
' box-state.tar.gz.enc <key> box-state.tar.gz

shasum -a 256 box-state.tar.gz          # must equal the manifest's sha256
tar -xzf box-state.tar.gz -C <data-root>
```

`tar` preserves the `0600` modes, which is load-bearing for the restored env files. Restore into a STOPPED container — `state.db` is live SQLite.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-backup`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.backup` row stays honest.

**The prober was NOT honest, and now is.** `cron-output.sh` WRAPS the sweep rather than exec'ing it, so a SIGKILLed run still writes a marker — a 28-byte file whose only line is the header. The prober used to take the last non-empty line, fail to parse it as JSON, and shrug ("freshness governs"), so three nights of total failure read GREEN on `/status`. `judgeCron` now scans a marker for the sweep's contracted JSON summary and treats a marker with **no summary at all** as a run that was killed before it could speak — `down` on first sighting, no one-miss grace (unlike a reported `ok: false`, which is a sweep handling a failure and retrying).

**The run's `ok` covers BOTH legs.** A leg-2 failure reports `ok: false` with `reason: "box_state_failed"` even though the dump landed — a half-backup that reads green is the exact failure mode above. Leg 2 runs only AFTER the dump is durable in R2, so it can never cost the night's dump; the skipped-for-no-key state is `ok: true` (nothing is broken — the key simply isn't provisioned).

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/backup-timer/fluncle-backup.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/backup-timer/fluncle-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-backup.timer

# Verify (a manual tick writes a real backup object — safe + idempotent within the day's slot).
sudo systemctl start fluncle-backup.service            # one tick now
journalctl -u fluncle-backup.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-backup.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-backup`) so it is not double-scheduled — green the timer first, never both live at once.
