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

/**
 * The CLI credentials for a child that opted in with `adminToken: true` (the run
 * registry's least-privilege env hands out nothing by default). Resolved through
 * the CLI's own loadEnv and returned as a LOCAL map — never by inheriting the
 * daemon's dotenv-polluted process.env. No credentials aboard → an empty map;
 * the child runs tokenless and fails honestly.
 */
export function adminChildEnv(): Record<string, string | undefined> {
  try {
    const { FLUNCLE_API_TOKEN } = loadEnv(["FLUNCLE_API_TOKEN"]);
    const env: Record<string, string | undefined> = { FLUNCLE_API_TOKEN };

    // The base URL + profile ride along so a spawned CLI talks to the same API
    // the daemon does (identifiers, not secrets).
    if (process.env.FLUNCLE_API_BASE_URL !== undefined) {
      env.FLUNCLE_API_BASE_URL = process.env.FLUNCLE_API_BASE_URL;
    }

    if (process.env.FLUNCLE_ENV !== undefined) {
      env.FLUNCLE_ENV = process.env.FLUNCLE_ENV;
    }

    return env;
  } catch {
    return {};
  }
}
