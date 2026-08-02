// Global artist-rule handlers. Artist rules govern what future crawls acquire; they do not
// delete, hide, or rewrite anything already stored.

import { ORPCError } from "@orpc/server";
import {
  addArtistRule,
  DuplicateGlobalArtistRuleError,
  listArtistRules,
  MissingArtistRuleNameError,
  removeArtistRule,
} from "../artist-rules";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminArtistRulesHandlers(os: Implementer) {
  // GET /admin/artist-rules — ADMIN tier: a pure read for the board and operator scripts.
  const listArtistRulesHandler = os.list_artist_rules.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, rules: await listArtistRules() };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/artist-rules — OPERATOR tier: add one global allow/block exception.
  const addArtistRuleHandler = os.add_artist_rule
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, rule: await addArtistRule(input) };
      } catch (error) {
        if (error instanceof DuplicateGlobalArtistRuleError) {
          throw new ORPCError("CONFLICT", {
            data: { apiCode: "artist_rule_exists", apiMessage: error.message },
            message: error.message,
            status: 409,
          });
        }

        if (error instanceof MissingArtistRuleNameError) {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "artist_rule_name_required", apiMessage: error.message },
            message: error.message,
            status: 400,
          });
        }

        throw apiFault(error);
      }
    });

  // DELETE /admin/artist-rules/{id} — OPERATOR tier: remove one global exception.
  // The delete is idempotent; an already-absent id still returns success.
  const removeArtistRuleHandler = os.remove_artist_rule
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await removeArtistRule(input.id);

        return { ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    add_artist_rule: addArtistRuleHandler,
    list_artist_rules: listArtistRulesHandler,
    remove_artist_rule: removeArtistRuleHandler,
  };
}
