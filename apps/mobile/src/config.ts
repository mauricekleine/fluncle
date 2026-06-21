// Surface bases. The app is one more SURFACE over the same public API + CDN.
export const API_BASE = "https://www.fluncle.com";
// Media masters + Cloudflare Media Transformations live on the CDN, addressed by
// Log ID — independent of the API transport (so oRPC doesn't touch this).
export const FOUND_BASE = "https://found.fluncle.com";
