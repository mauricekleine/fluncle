# Offline-first mobile — the live remainder (updated 2026-07-31)

Non-canonical planning input for the offline-first mobile work (ROADMAP § _Offline-first mobile_). The build is COMPLETE and this file holds only what is not yet actioned; everything shipped is documented by the code and its tests. The arc, for orientation: slices 0 and 1 (#998, #1000) plus the `/out/` hop resolver (#1009) ride the 1.1 release; the `syncLibSQL()` spike passed both legs 2026-07-30 (harness stays at `apps/mobile/app/dev/sync-spike.tsx`, `__DEV__`-only, with the verified API surface in its header); the sizing pass measured prod scale 2026-07-31 (anchored cut ruled: 20,342 tracks / 23.4 MB / ~3.2 s simulator bootstrap; full 64.6 MB / ~6.8 s; certified 0.7 MB) via the derivation tooling in `apps/web/scripts/derive-device-db.ts` + the whitelist-as-tested-data in `scripts/lib/device-db-schema.ts`; and slice 2 shipped in three parts — the `fluncle-device-mirror` sweep (#1043, repo half), the dark `get_replica_token` op (#1042), and the app-side replica wiring with the archive's offline browse (#1054).

## Ruled, still standing

- **`expo-sqlite` is the runtime path; the op-sqlite door is CLOSED.** Fallback ladder if the stack ever fails in production: `@tursodatabase/sync-react-native` first (0.7.x as of 2026-07-30, actively developed, peers satisfied; Expo plugin still roadmap), op-sqlite last.
- **One shared read-only replica, anchored cut.** User data union-merges at app level; devices never push the catalogue. Sync is manual `pull` in every Turso stack by design (docs.turso.tech/sync/usage.md, 2026-07-30); Turso Sync's own conflict rule is "last push wins", which reinforces app-level user-data merging.
- **`useLibSQL` is a build-time ENGINE SWAP** (the whole app's SQLite rides libSQL when set, kv-store included). It is gated behind `SPIKE_LIBSQL=1` in `app.config.js`; the `development` EAS profile pins it; **production binaries stay on the default engine until the flip is ruled** — that ruling is the one open product decision, below. Build trap: flipping the flag rewrites `Podfile.properties.json` without dirtying the Podfile checksum, so force `pod install` in `ios/` after any flip. libSQL-mode limits: positional binds only, no `enableChangeListener`.

## Open decisions

- **The engine flip (a 1.2-class release decision):** when a production binary ships with `useLibSQL` — the moment the app-side replica code (already shipped, dark, engine-probed) can activate for real users. Wants its own regression pass, since slice 1's kv-store stores change engine with it.

## Activation — DONE 2026-07-31

The whole chain is live and was verified end to end the same day: the derived DB serves the anchored cut, the hourly `fluncle-device-mirror` timer runs on the box (first tick reconciled the morning's churn with zero errors and reported to the run ledger), `get_replica_token` mints real 24-hour credentials, and a dev-client build on current `main` bootstrapped its replica unassisted — pulling rows the sweep had mirrored after the seed snapshot, which proves the prod → sweep → replica → token → device loop, not just its parts. Store users feel none of it until the engine flip below.

## Carried-forward UNVERIFIED list

A mid-pull network drop's failure mode (never exercised); the incremental pull size after real catalogue churn (measurable once the mirror runs); RN-binding availability of `bootstrapIfEmpty` / partial sync / checkpoints and the `@tursodatabase/sync-react-native` Expo story (both relevant only on the fallback ladder).
