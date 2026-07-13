// The `me-preferences` domain contract module — a signed-in user's cross-device
// preferences, the FIRST slice of a store that will grow (the roadmap's chained-set
// and Galaxy-star sync land here next). The get is a cookie-session read; the update
// is CSRF-guarded. The `me-saved` / `me-sets` siblings are the precedent this
// follows.
//
// THE ACCOUNT NEVER GATES A FEATURE. Every preference here also has a device-local
// home (today: the `fluncle.admin.key-notation` localStorage toggle a stranger uses
// with no account). Signing in only lets the choice travel ACROSS devices; the
// anonymous, device-local path is untouched.
//
// EXTENSIBLE BY DESIGN. `UserPreferencesSchema` is a CLOSED object — one row per
// user holds this whole shape as JSON. A future preference adds a field here and
// wires its consumers; it needs NO migration (the column is opaque JSON) and the
// PATCH merges partially, so each preference updates independently of the rest.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** The key-notation choice, shared with the client store (`formatKey`). */
export const KeyNotationPreferenceSchema = z.enum(["scales", "camelot"]);

/**
 * The closed set of a user's preferences, as READ and RETURNED — a plain object, so
 * an unknown key (e.g. one a newer deploy wrote mid-rollout) is STRIPPED rather than
 * rejected, keeping a forward-rolled blob readable. Every field is optional: an
 * absent field means "never set, fall back to the device/default". Currently just
 * `keyNotation`; grow it here.
 */
export const UserPreferencesSchema = z
  .object({
    keyNotation: KeyNotationPreferenceSchema.optional(),
  })
  .meta({ id: "UserPreferences" });

/**
 * The WRITE shape — the same closed field set, but `z.strictObject` so an unknown key
 * is a 400 rather than silently dropped. Deliberately its OWN construction (not
 * `UserPreferencesSchema.strict()`) so it carries no shared `.meta` id — the output
 * schema owns the named `UserPreferences` OpenAPI component; this input inlines. The
 * PATCH body is this partial object; the server merges it into the stored blob, so a
 * field the caller omits is preserved.
 */
export const UserPreferencesInputSchema = z.strictObject({
  keyNotation: KeyNotationPreferenceSchema.optional(),
});

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/**
 * `get_my_preferences` → `GET /me/preferences` (operationId `getMyPreferences`).
 *
 * The signed-in user's stored preferences. A missing session is the rails-encoded
 * 401 (`auth_required`); an unreadable stored blob resolves to an empty object
 * rather than an error (the read never throws).
 */
export const getMyPreferences = oc
  .route({
    method: "GET",
    operationId: "getMyPreferences",
    path: "/me/preferences",
    summary: "Get the signed-in user's preferences",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), preferences: UserPreferencesSchema }));

/**
 * `update_my_preferences` → `PATCH /me/preferences`
 * (operationId `updateMyPreferences`).
 *
 * Merge a partial preferences patch into the signed-in user's stored object — a
 * field the body carries is written, a field it omits is preserved, so preferences
 * update independently. CSRF-guarded; an unknown key is `invalid_request`/400 (the
 * closed schema). Echoes the full merged object back.
 */
export const updateMyPreferences = oc
  .route({
    method: "PATCH",
    operationId: "updateMyPreferences",
    path: "/me/preferences",
    summary: "Update the signed-in user's preferences",
    tags: ["Me"],
  })
  .input(UserPreferencesInputSchema)
  .output(z.object({ ok: z.literal(true), preferences: UserPreferencesSchema }));

/** The `me-preferences` domain's ops, merged into the root contract by `./index.ts`. */
export const mePreferencesContract = {
  get_my_preferences: getMyPreferences,
  update_my_preferences: updateMyPreferences,
};
