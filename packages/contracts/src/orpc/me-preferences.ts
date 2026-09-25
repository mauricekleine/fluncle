import { oc } from "@orpc/contract";
import * as z from "zod";

export const KeyNotationPreferenceSchema = z.enum(["scales", "camelot"]);

export const UserPreferencesSchema = z
  .object({
    keyNotation: KeyNotationPreferenceSchema.optional(),
  })
  .meta({ id: "UserPreferences" });

export const UserPreferencesInputSchema = z.strictObject({
  keyNotation: KeyNotationPreferenceSchema.optional(),
});

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const getPrivatePreferences = oc
  .route({
    method: "GET",
    operationId: "getPrivatePreferences",
    path: "/me/preferences",
    summary: "Get the signed-in user's preferences",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), preferences: UserPreferencesSchema }));

export const updatePrivatePreferences = oc
  .route({
    method: "PATCH",
    operationId: "updatePrivatePreferences",
    path: "/me/preferences",
    summary: "Update the signed-in user's preferences",
    tags: ["Me"],
  })
  .input(UserPreferencesInputSchema)
  .output(z.object({ ok: z.literal(true), preferences: UserPreferencesSchema }));

export const mePreferencesContract = {
  get_private_preferences: getPrivatePreferences,
  update_private_preferences: updatePrivatePreferences,
};
