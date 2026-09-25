import { ORPCError } from "@orpc/server";
import {
  addArtistRule,
  ArtistRuleNotFoundError,
  type ArtistRuleVerdict,
  artistSlugsForMbid,
  DuplicateGlobalArtistRuleError,
  listArtistRules,
  MissingArtistRuleNameError,
  removeArtistRule,
  updateArtistRule,
} from "../artist-rules";
import { purgeEntityCaches } from "../edge-cache";
import { logEvent } from "../log";
import { purgeArtistSitemapCachesNow } from "../sitemap-data";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

async function purgeArtistVisibility(verdict: ArtistRuleVerdict, artistMbid: string) {
  if (verdict !== "unlisted") {
    return;
  }

  try {
    const slugs = await artistSlugsForMbid(artistMbid);
    purgeEntityCaches(slugs.map((slug) => ({ kind: "artist" as const, slug })));

    await purgeArtistSitemapCachesNow();
  } catch (error) {
    logEvent("warn", "artist-rule.visibility-purge-failed", {
      artistMbid,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function adminArtistRulesHandlers(os: Implementer) {
  const listArtistRulesHandler = os.list_artist_rules.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, rules: await listArtistRules() };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const addArtistRuleHandler = os.add_artist_rule
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const rule = await addArtistRule(input);
        await purgeArtistVisibility(rule.verdict, rule.artistMbid);

        return { ok: true as const, rule };
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

  const removeArtistRuleHandler = os.remove_artist_rule
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const removed = await removeArtistRule(input.id);

        if (removed) {
          await purgeArtistVisibility(removed.verdict, removed.artistMbid);
        }

        return { ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const updateArtistRuleHandler = os.update_artist_rule
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const rule = await updateArtistRule(input.id, {
          checkedAt: input.checkedAt,
          resolvedMbid: input.resolvedMbid,
          resolvedName: input.resolvedName,
        });

        return { ok: true as const, rule };
      } catch (error) {
        if (error instanceof ArtistRuleNotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: error.message });
        }

        throw apiFault(error);
      }
    });

  return {
    add_artist_rule: addArtistRuleHandler,
    list_artist_rules: listArtistRulesHandler,
    remove_artist_rule: removeArtistRuleHandler,
    update_artist_rule: updateArtistRuleHandler,
  };
}
