# Offline-first mobile — research notes (updated 2026-07-30)

Non-canonical planning input for the offline-first mobile work (ROADMAP § _Offline-first mobile_). It decides nothing by itself; the operator's rulings below do. Originally agent-researched 2026-07-29 against Expo SDK 56 and the app as shipped at 1.0 approval, then trimmed 2026-07-30 to the live remainder: slices 0 and 1 have shipped, so their specs left with them (the code and its tests are the record now), and what is left here is what slice 2 still needs. Every version number in here was read on the date beside it — **verify versions before building**, since the whole point of this file is that the RN corner of this ecosystem moves under you.

## Ruled

- **2026-07-29 — `expo-sqlite` is the runtime path, and the op-sqlite door is CLOSED** unless the device spike fails.
- **2026-07-29 — slices 0 and 1 ride the 1.1 release.** Both shipped: #998 (offline resilience — online/focus seeding, persisted query cache, paused-mutation replay) and #1000 (the device stores onto SQLite, carrying the old keys across), plus rider #1009 (the `/out/` hop resolver). The pointers are `apps/mobile/src/lib/persist-config.ts` for the persist wiring and `storage-migration.ts` / `saved.ts` / `mix.ts` for the kv-store move; their tests carry the gotchas this file used to list.
- **2026-07-29 — the `syncLibSQL()` device spike runs on the 1.1 dev client, in the TestFlight window.** It is the gate on slice 2, not a parallel track.
- **2026-07-29 — the shared-replica-vs-per-user-DB shape is DEFERRED until the spike reports.** Turso multi-DB cost at 2026 pricing stays unresearched on purpose: the spike may make the question moot.
- **2026-07-30 — if the spike fails, the first fallback to evaluate is `@tursodatabase/sync-react-native`, not op-sqlite.** Verified on npm 2026-07-30: latest `0.7.1`, package modified 2026-07-29 (actively developed), peers `react >=18.0.0` and `react-native >=0.76.0` — both satisfied by the app's `react 19.2.3` / `react-native 0.85.3`. It is still 0.x and the Expo plugin is still a ROADMAP item per Turso's 2026-01-29 announcement, so it slots AHEAD of op-sqlite in the fallback order without displacing the ruled path.

## The runtime path — `expo-sqlite`

`expo-sqlite` (SDK 56, `~56.0.5`) ships libSQL support natively — `useLibSQL` and `syncLibSQL()` are in the SDK-56-versioned docs and the module is in `expo@56.0.17`'s `bundledNativeModules.json` — which is why nothing else was needed for slices 0 and 1 and why slice 2 has a first-party path to try. libSQL itself is feature-frozen in direction but maintained (`tursodatabase/libsql`'s README: new features go to Turso, libSQL is actively maintained), which is the branch you want under a shipping app. Every alternative failed on a hard fact rather than on taste: `@libsql/client` has no `react-native` export condition and its Node build pulls an N-API addon Hermes cannot load, while `@libsql/client/web` is hrana-over-network only (throws `URL_SCHEME_NOT_SUPPORTED` for `file:`), so no local DB and no offline; op-sqlite makes libSQL a BUILD-TIME flag that costs reactive queries, multi-statement strings, update/commit/rollback hooks, extension loading, local disk-encryption and custom tokenizers, with SQLCipher mutually exclusive — a one-way door, now ruled closed; and CR-SQLite (dead upstream), WatermelonDB (New-Arch/SDK-54+ issue open and unanswered), Legend-State (v3 beta 22 months, peers five SDK generations behind), Zero (peers a react the app is not on), Electric (read-path-for-Postgres only), PowerSync (Postgres/Mongo/MySQL sources only) and TanStack DB (RN adapters peer stale majors; `localStorageCollectionOptions` silently degrades to in-memory on RN; no durable offline mutation queue) are all out. Turso's own RN bindings remain undocumented in the `turso-docs` tree and `docs.turso.tech/sdk/react-native` 404s, so never infer an RN capability from a Turso docs page — read the RN binding's README for the version you are pinning.

## Turso sync mechanics (as of mid-2026)

- Conflict posture on `pull()` with unpushed local changes is a **rebase**: local rolls back to the last synced state, remote applies, local replays atomically on top. That is not a per-field merge, so the user-data union-merge law still needs app-level merge logic above it.
- `bootstrapIfEmpty`, partial sync and checkpoints exist in the TS/Go/Python docs; their availability IN THE RN BINDING specifically is UNVERIFIED.

## The spike — `syncLibSQL()` on a real device

The one de-risking gate, and the thing the whole slice-2 architecture leans on: run `syncLibSQL()` against a live Turso database on a physical device, on the 1.1 dev client during the TestFlight window. Nobody has verified it on this stack. What it has to answer: does a replica bootstrap and pull at all under Hermes and the New Architecture; does it survive a cold start and a mid-pull network drop; how large is the on-device file and how long does the first bootstrap take; and does `useLibSQL` work in Expo Go or force a dev client. A failure here does not sink offline-first — it moves the evaluation to `@tursodatabase/sync-react-native` per the 2026-07-30 ruling.

## Slice 2 — the synced replica

`useLibSQL` + `syncLibSQL()` against a **public-catalogue slice only** (server-authoritative), with user data union-merged at app level on top of the rebase posture above. Gates, all three of which must clear before the slice is built: the device spike passes; the RN binding's capabilities are verified for the version being pinned (`bootstrapIfEmpty` / partial sync / checkpoints, read from that binding's README, not from the Turso docs site); and a sizing pass fixes what actually ships to a device — **the MuQ embedding blobs never leave the server**, and the slice has to stay small enough that the first bootstrap is not a cold-open cost.

## Carried-forward UNVERIFIED list

`useLibSQL` in Expo Go (versus requiring a dev client); RN-binding availability of `bootstrapIfEmpty` / partial sync / checkpoints; the size and duration of a device-shippable catalogue slice; the Expo integration story for `@tursodatabase/sync-react-native` (the plugin is roadmap, so a config-plugin-free path is unproven); and the device `syncLibSQL()` spike itself.
