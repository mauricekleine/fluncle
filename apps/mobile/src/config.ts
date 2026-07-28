// Surface bases. The app is one more SURFACE over the same public API + CDN.
//
// `EXPO_PUBLIC_API_BASE` points the whole app at a different worker — a local one, in
// practice. Its only job is the App Store screenshot rig (docs/mobile-store-screenshots.md):
// shooting the store slots against a synthetic, own-artwork dataset takes an app that reads
// a locally seeded database. Expo's Babel preset INLINES `process.env.EXPO_PUBLIC_*` at
// bundle time, so an unset variable compiles to `undefined` and the `??` hands back the
// production host — a store build is byte-identical to one with no override at all. The
// member expression must stay static for that inlining to happen; never read it dynamically.
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "https://www.fluncle.com";
// Media masters + Cloudflare Media Transformations live on the CDN, addressed by
// Log ID — independent of the API transport (so oRPC doesn't touch this). Deliberately NOT
// overridable: no screenshot surface reads it (the seeded sleeves are served through
// `albumImageUrl`, and mixtape covers come off API_BASE), and the Feed's first-party renders
// are shot against production, where this host is the only one that has them.
export const FOUND_BASE = "https://found.fluncle.com";
