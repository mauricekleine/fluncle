// The admin bridge — apps/cli imported IN-PROCESS (HELM-CONTRACT.md "Auth").
// The daemon presents the CLI's stored credentials (~/.config/fluncle/.env.*)
// itself, server-side; the token never travels to the UI. Features reach the
// Fluncle admin API only through this client, from their server.ts.

import {
  adminApiDelete,
  adminApiGet,
  adminApiPatch,
  adminApiPost,
  adminApiPostForm,
  adminApiPut,
} from "@fluncle/cli/src/api";
import { loadEnv } from "@fluncle/cli/src/env";
import { type AdminClient } from "../features/types";

export function createAdminClient(): AdminClient {
  return {
    del: adminApiDelete,
    get: adminApiGet,
    patch: adminApiPatch,
    post: adminApiPost,
    postForm: adminApiPostForm,
    put: adminApiPut,
  };
}

/** Whether the CLI's admin token resolves — reported on /api/health, never sent. */
export function adminTokenAboard(): boolean {
  try {
    loadEnv(["FLUNCLE_API_TOKEN"]);

    return true;
  } catch {
    return false;
  }
}
