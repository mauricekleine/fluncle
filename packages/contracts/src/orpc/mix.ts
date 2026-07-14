// The `mix` domain contract module — the two reads TASTE-SEEDING needs.
//
// `/mix` is a stranger's first contact with Fluncle: a free DnB mixing tool, no account, no
// sign-up. Which leaves it one hard problem the archive cannot solve for them — a person who
// has never been here has no idea which of thousands of tracks to open a set with. Seeding is
// the answer, and it is two questions long: WHICH ARTISTS DO YOU LIKE (`list_mixable_artists`
// offers them), and THEN WHAT DO I START FROM (`list_mix_openers` answers it). From there the
// rail (`list_mixable_tracks`, in ./tracks.ts — a track subresource, correctly homed there)
// takes over, tilted by the same seed.
//
// The seed is a comma-separated list of artist SLUGS, and it lives in the URL. That is the
// whole storage design: no account, no cookie, no consent banner, nothing to migrate when the
// reader opens the link on their phone — and a seeded set is shareable BY CONSTRUCTION,
// because the link IS the state. It is also the surface's only viral mechanic, so it had
// better survive a copy-paste into a group chat.

import { oc } from "@orpc/contract";
import * as z from "zod";
// `.js` extension: the `.` package entry is consumed by NodeNext typecheckers (Raycast),
// which require explicit extensions on relative imports; Bundler resolvers (web, CLI) resolve
// it back to the `.ts` source. Matches the convention in `./_shared`'s own re-exports.
import { MixTrackSchema } from "./_shared.js";

/**
 * An artist you can seed a mix from — the taste picker's row.
 *
 * `trackCount` counts the artist's RANKABLE tracks (a key and a vector), certified or not:
 * it is the honest "how much of this artist can Fluncle actually mix", which is the only
 * thing that decides whether seeding them does anything. It orders the picker, so the names
 * a reader is most likely to recognize — and that the archive can most act on — come first.
 *
 * NO certified/uncertified split here, and no count of findings. An artist is an artist; the
 * Unlit Rule governs TRACK rows, and a picker that sorted Fluncle's darlings above the
 * artists a stranger actually came for would be optimizing for the wrong person.
 */
export const MixArtistSchema = z
  .object({
    imageUrl: z.string().optional(),
    name: z.string(),
    slug: z.string(),
    trackCount: z.number(),
  })
  .meta({ id: "MixArtist" });

/**
 * `list_mixable_artists` → `GET /mix/artists` (operationId `listMixableArtists`).
 *
 * The artists a mix can be seeded from: every artist with at least one RANKABLE track in the
 * archive (a key and a vector — i.e. one the engine can actually place), most-represented
 * first. `q` filters by name for the reader who wants someone the grid did not offer.
 *
 * Deliberately NOT `list_artists` (./artists.ts), which promises "artists with a published
 * finding" and is read by the CLI, the SSH terminal and llms.txt. That list is the artists
 * Fluncle has BEEN to — 67 of them — and seeding against it would fail the first stranger who
 * named a favourite he has not logged yet, which is nearly all of them. This list is the
 * artists Fluncle can MIX, which the catalogue makes a far larger and far more useful set.
 * Same noun, genuinely different question; hence a second op rather than a flag on the first.
 */
export const listMixableArtists = oc
  .route({
    method: "GET",
    operationId: "listMixableArtists",
    path: "/mix/artists",
    summary: "List the artists a mix can be seeded from",
    tags: ["Mix"],
  })
  .input(z.object({ limit: z.string().optional(), q: z.string().optional() }))
  .output(z.object({ artists: z.array(MixArtistSchema), ok: z.literal(true) }));

/**
 * `list_mix_openers` → `GET /mix/openers` (operationId `listMixOpeners`).
 *
 * What to open a set WITH, once the reader has named the artists they like. The tracks BY the
 * seeded artists — certified first (Fluncle has been there, so there is somewhere to send
 * you), then the rest, all in the same unnamed register the rail uses.
 *
 * Deliberately the artists' OWN tracks rather than a taste-ranked sweep of the archive. It is
 * exact instead of inferred, it is instant (a graph read — no vector math on the request
 * path), and it is the one list a stranger can VERIFY at a glance. That verification is the
 * point: recognizing the openers is what earns the trust to follow the rail afterwards, and
 * the rail is where the discovery actually happens. Taste-ranking the whole catalogue for an
 * opener would be a cross join per page load — the shape docs/the-ear.md exists to precompute
 * away, and it does not belong on a request path.
 *
 * `taste` is the same comma-separated artist-slug seed the rail takes. Empty or unresolvable
 * yields `{ ok: true, tracks: [] }`, and the page falls back to search — never a fault.
 */
export const listMixOpeners = oc
  .route({
    method: "GET",
    operationId: "listMixOpeners",
    path: "/mix/openers",
    summary: "List the tracks to open a set with, for a seed of artists you like",
    tags: ["Mix"],
  })
  .input(z.object({ limit: z.string().optional(), taste: z.string() }))
  .output(z.object({ ok: z.literal(true), tracks: z.array(MixTrackSchema) }));

/**
 * `list_set_tracks` → `GET /mix/set-tracks` (operationId `listSetTracks`).
 *
 * Hydrate a whole `?set=` chain in ONE read — the share-link grammar handed back as rows. The
 * `set` input is the same comma-separated token list the URL carries: a finding's Log ID for a
 * certified track, its 22-char Spotify id for one Fluncle never certified (the Decks rail serves
 * both, so a chain holds both). Order is preserved (a set is a sequence), duplicates collapse,
 * and the list is parsed by the same tolerant rules the `/mix` loader uses — capped at 32 tokens,
 * junk dropped without a DB hit.
 *
 * An unknown token is simply OMITTED from the result, never a fault: a set link outlives the
 * archive it was built from, so a vanished (or never-certified-and-since-purged) row should thin
 * the chain, not 500 the read. Public-unauth like its `list_mix_openers` sibling — every field on
 * a {@link MixTrackSchema} row is already public on every track chip (title, artists, cover, key,
 * BPM, and whether it is certified), so a set opener carries nothing an opener or the rail doesn't.
 *
 * This is the public twin of the server-only `getMixTracksByTokens` the web `/mix` loader calls,
 * so a saved set hydrates whole on every surface — the mobile app opens an uncertified token the
 * per-track `get_track` op (certified-findings-only) would silently drop.
 */
export const listSetTracks = oc
  .route({
    method: "GET",
    operationId: "listSetTracks",
    path: "/mix/set-tracks",
    summary: "Hydrate a whole shared set from its comma-separated token list",
    tags: ["Mix"],
  })
  .input(z.object({ set: z.string() }))
  .output(z.object({ ok: z.literal(true), tracks: z.array(MixTrackSchema) }));

/** The `mix` domain's ops, merged into the root contract by `./index.ts`. */
export const mixContract = {
  list_mix_openers: listMixOpeners,
  list_mixable_artists: listMixableArtists,
  list_set_tracks: listSetTracks,
};
