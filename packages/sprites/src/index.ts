// @fluncle/sprites — the canonical home for Fluncle's pixel sprites.
//
// The PNG assets live in `assets/<collection>/<id>.png` (this package owns them);
// the generation pipeline (the `fluncle-sprites` skill) writes there, and the web
// app copies them into its `public/` at build so the served paths are unchanged.
// This module is the typed layer over them: the manifest, the surface→sprite
// assignment, the palette, and the per-consumer render helpers (a web URL today,
// a terminal renderer for the CLI next).
//
// One family, one source of truth, many consumers (web, CLI, OG cards, …).

/** The two sprite sets. `surface` icons are drawn from these until the on-spec set lands. */
export type SpriteCollection = "earth" | "galaxy";

/** Every sprite id, by collection (the file at `assets/<collection>/<id>.png`). */
export const SPRITES = {
  earth: [
    "boombox",
    "comms_camcorder",
    "comms_mailbox",
    "comms_pager",
    "comms_polaroids",
    "comms_robot",
    "crt",
    "docs_manual",
    "edge_fusebox",
    "edge_onion",
    "edge_switchboard",
    "edge_terminal",
    "floppy",
    "home_beacon",
    "landing_board",
    "landing_lens",
    "landing_logbook",
    "landing_monolith",
    "landing_nokia",
    "launch_rocket",
    "privacy_lock",
    "radio",
    "rocket_capsule",
    "rocket_riveted",
    "status_panel",
    "stories_reel",
    "turntable",
  ],
  galaxy: ["asteroid", "earth", "roadster", "ship", "ufo"],
} as const satisfies Record<SpriteCollection, readonly string[]>;

/** A sprite reference — a collection + an id within it. */
export type SpriteRef = { collection: SpriteCollection; id: string };

/**
 * The public URL the WEB serves a sprite at. The web build mirrors
 * `packages/sprites/assets/<collection>/` → `apps/web/public/<collection>/`, so a
 * sprite is served at the same stable path it always was (the games' loaders and
 * the `/sprites` page both resolve here, and a dropped-in PNG still hot-swaps).
 */
export function spriteUrl(ref: SpriteRef): string {
  return `/${ref.collection}/${ref.id}.png`;
}

/**
 * The surface → sprite assignment (the `/sprites` registry section). The interim
 * home for the mapping until it becomes a canonical `sprite` field on the
 * `@fluncle/registry` `Surface` type. Keyed by registry surface name. Today these
 * reuse the Earth overworld props; the on-spec render replaces them in place.
 */
export const SPRITE_BY_SURFACE: Record<string, SpriteRef> = {
  "cron.newsletter": { collection: "earth", id: "comms_mailbox" },
  "dns.zone": { collection: "earth", id: "edge_switchboard" },
  "mcp.server": { collection: "earth", id: "edge_terminal" },
  "ssh.rave": { collection: "earth", id: "crt" },
  "subdomain.dig": { collection: "earth", id: "edge_switchboard" },
  "subdomain.galaxy": { collection: "earth", id: "launch_rocket" },
  "subdomain.onion": { collection: "earth", id: "edge_onion" },
  "subdomain.radio": { collection: "earth", id: "radio" },
  "subdomain.status": { collection: "earth", id: "edge_fusebox" },
  "web.about": { collection: "earth", id: "landing_board" },
  "web.docs": { collection: "earth", id: "docs_manual" },
  "web.galaxy": { collection: "earth", id: "launch_rocket" },
  "web.home": { collection: "earth", id: "home_beacon" },
  "web.log": { collection: "earth", id: "landing_logbook" },
  "web.mixtapes": { collection: "earth", id: "turntable" },
  "web.newsletter": { collection: "earth", id: "comms_mailbox" },
  "web.privacy": { collection: "earth", id: "privacy_lock" },
  "web.radio": { collection: "earth", id: "radio" },
  "web.status": { collection: "earth", id: "status_panel" },
  "web.stories": { collection: "earth", id: "stories_reel" },
};

/**
 * The Sprite Palette — the canon ramp every sprite is quantized to (mirrors
 * `DESIGN.md` + the `fluncle-sprites` skill's `references/palette.md`). The
 * dominant body sits on the cream ramp (pops on dark by VALUE), gold + red ride
 * as accents, warm blacks for the outline/shadow.
 */
export const SPRITE_PALETTE = [
  "#fffbf2",
  "#f4ead7",
  "#b7ab95",
  "#6e6657", // cream — the light body
  "#ffd057",
  "#f5b800",
  "#b88a00",
  "#7a5c00", // eclipse gold — accent
  "#ffa18f",
  "#ff6b57",
  "#b23c2e",
  "#7a2418", // re-entry red — accent
  "#46527a",
  "#3a5f5c", // cool counter-accents
  "#171611",
  "#10100d",
  "#090a0b", // warm blacks — outline / shadow
] as const;

/**
 * Render a sprite as terminal half-block (`▀`) art — the CLI / SSH consumer hook.
 *
 * STUB: the contract is fixed so consumers can wire against it, but the
 * implementation lands when the CLI actually renders a sprite (it needs a small
 * PNG decoder + per-row upper/lower half-block + 24-bit ANSI, reading the bytes
 * from `assets/<collection>/<id>.png` via `import.meta.url`). Throws until then.
 */
export function renderToAnsi(_ref: SpriteRef, _opts?: { width?: number }): string {
  throw new Error(
    "@fluncle/sprites: renderToAnsi is not implemented yet — wire it when the CLI consumes sprites.",
  );
}
