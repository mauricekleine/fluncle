import { oc } from "@orpc/contract";
import * as z from "zod";
import { GalaxyProgressSchema } from "./me-galaxy";
import { UserPreferencesSchema } from "./me-preferences";
import { RecSeedSchema } from "./me-recs";
import { SavedFindingSchema } from "./me-saved";
import { SavedSetSchema } from "./me-sets";
import { PublicUserSchema } from "./_shared";

export const PrivateSubmissionSchema = z
  .object({
    artists: z.array(z.string()),
    createdAt: z.string(),
    id: z.string(),

    logId: z.string().optional(),
    note: z.string().optional(),
    source: z.string(),
    spotifyUrl: z.string(),
    status: z.enum(["logged", "passed_on", "pending_review"]),
    title: z.string(),
  })
  .meta({ id: "PrivateSubmission" });

const ProfileBodySchema = z.looseObject({
  displayUsername: z.unknown().optional(),

  name: z.unknown().optional(),
  username: z.unknown().optional(),
});

export const getCurrentPrivateUser = oc
  .route({
    method: "GET",
    operationId: "getCurrentPrivateUser",
    path: "/me",
    summary: "Get the current public session (user or null)",
    tags: ["Me"],
  })
  .output(
    z.object({
      googleEnabled: z.boolean(),
      ok: z.literal(true),
      user: PublicUserSchema.nullable(),
    }),
  );

export const getPrivateMutationToken = oc
  .route({
    method: "GET",
    operationId: "getPrivateMutationToken",
    path: "/me/csrf",
    summary: "Issue the account mutation (CSRF) token",
    tags: ["Me"],
  })
  .output(z.object({ csrfToken: z.string(), ok: z.literal(true) }));

export const updatePrivateProfile = oc
  .route({
    method: "PATCH",
    operationId: "updatePrivateProfile",
    path: "/me/profile",
    summary: "Update the signed-in user's profile",
    tags: ["Me"],
  })
  .input(ProfileBodySchema)
  .output(z.object({ ok: z.literal(true), user: PublicUserSchema }));

export const deletePrivateAccount = oc
  .route({
    method: "POST",
    operationId: "deletePrivateAccount",
    path: "/me/delete",
    summary: "Delete the signed-in account",
    tags: ["Me"],
  })
  .output(
    z.object({
      ok: z.literal(true),
      summary: z.object({
        credentials: z.string(),
        galaxyProgress: z.string(),

        preferences: z.string().optional(),
        recSeeds: z.string().optional(),
        savedFindings: z.string(),
        savedSets: z.string().optional(),
        sessions: z.string(),
        submissions: z.string(),
        user: z.string(),
        verifications: z.string(),
      }),
    }),
  );

export const exportPrivateAccountData = oc
  .route({
    method: "POST",
    operationId: "exportPrivateAccountData",
    path: "/me/export",
    summary: "Generate the signed-in account's data export",
    tags: ["Me"],
  })
  .output(
    z.object({
      export: z.object({
        account: PublicUserSchema,
        generatedAt: z.string(),
        id: z.string(),
        preferences: UserPreferencesSchema,
        privacyNotes: z.array(z.string()),
        progress: GalaxyProgressSchema,

        recSeeds: z.array(RecSeedSchema).optional(),
        savedFindings: z.array(SavedFindingSchema),
        savedSets: z.array(SavedSetSchema).optional(),
        submissions: z.array(PrivateSubmissionSchema),
      }),
      ok: z.literal(true),
    }),
  );

export const getPrivateAccountExport = oc
  .route({
    method: "GET",
    operationId: "getPrivateAccountExport",
    path: "/me/export/{exportId}",
    summary: "Get a prior data export's status",
    tags: ["Me"],
  })
  .input(z.object({ exportId: z.string() }))
  .output(
    z.object({
      export: z.object({
        completedAt: z.string().optional(),
        expiresAt: z.string(),
        id: z.string(),
        requestedAt: z.string(),
        status: z.string(),
      }),
      ok: z.literal(true),
    }),
  );

export const listPrivateSubmissions = oc
  .route({
    method: "GET",
    operationId: "listPrivateSubmissions",
    path: "/me/submissions",
    summary: "List the signed-in user's submissions",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), submissions: z.array(PrivateSubmissionSchema) }));

export const meContract = {
  delete_private_account: deletePrivateAccount,
  export_private_account_data: exportPrivateAccountData,
  get_current_private_user: getCurrentPrivateUser,
  get_private_account_export: getPrivateAccountExport,
  get_private_mutation_token: getPrivateMutationToken,
  list_private_submissions: listPrivateSubmissions,
  update_private_profile: updatePrivateProfile,
};
