import { buildEntityBioPrompt, fetchEntityFacts, gateOrAcceptBio } from "../bio";
import { purgeEntityCache } from "../edge-cache";
import {
  LabelMintIdentityConflictError,
  LabelTakeOverNotEmptyError,
  LabelTakeOverSlugMismatchError,
  mintLabelFromMusicbrainz,
  MusicbrainzLabelNotFoundError,
  MusicbrainzThrottledError,
} from "../label-mint";
import {
  LabelScopedUnlistedRuleError,
  listLabelArtistRules,
  replaceLabelArtistRules,
} from "../artist-rules";
import {
  confirmLabelAlias,
  fillEmptyLabelBio,
  getLabelBySlug,
  LabelMergeConflictError,
  LabelMergeSameRowError,
  LabelNotFoundError,
  listLabelAliasCandidates,
  listLabels,
  listLabelsMissingBio,
  mergeLabel,
  rejectLabelAlias,
  updateLabelSeedState,
} from "../labels";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { getFindingsByLabel } from "../tracks";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer, parseLimit, toFault } from "./_shared";

export function adminLabelsHandlers(os: Implementer) {
  const listLabelsAdminHandler = os.list_labels_admin.use(adminAuth).handler(async ({ input }) => {
    try {
      const labels = (await listLabels(input.seedState)).map((label) => ({
        ...label,
        findingCount: 0,
      }));

      return { labels, ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const updateLabelHandler = os.update_label
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const label = await updateLabelSeedState(input.id, input.seedState, input.rewalk);

        return { label, ok: true } as const;
      } catch (error) {
        if (error instanceof LabelNotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: error.message });
        }

        throw apiFault(error);
      }
    });

  const listLabelArtistRulesHandler = os.list_label_artist_rules
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const rules = await listLabelArtistRules(input.id);

        return { ok: true as const, rules };
      } catch (error) {
        if (error instanceof LabelNotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: error.message });
        }

        throw apiFault(error);
      }
    });

  const replaceLabelArtistRulesHandler = os.replace_label_artist_rules
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const rules = await replaceLabelArtistRules(input.id, input.rules, input.source);

        return { ok: true as const, rules };
      } catch (error) {
        if (error instanceof LabelNotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: error.message });
        }

        if (error instanceof LabelScopedUnlistedRuleError) {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "artist_rule_unlisted_is_global", apiMessage: error.message },
            message: error.message,
            status: 400,
          });
        }

        throw apiFault(error);
      }
    });

  const mergeLabelHandler = os.merge_label
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const result = await mergeLabel(input.slug, input.canonicalSlug);

        purgeEntityCache("label", result.losingSlug);
        purgeEntityCache("label", result.canonicalSlug);

        return { ok: true as const, result };
      } catch (error) {
        if (error instanceof LabelNotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: error.message });
        }

        if (error instanceof LabelMergeSameRowError) {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "merge_same_row", apiMessage: error.message },
            message: error.message,
            status: 400,
          });
        }

        if (error instanceof LabelMergeConflictError) {
          throw new ORPCError("CONFLICT", {
            data: { apiCode: "merge_seed_conflict", apiMessage: error.message },
            message: error.message,
            status: 409,
          });
        }

        throw apiFault(error);
      }
    });

  const mintLabelHandler = os.mint_label
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { label, outcome, takenOver } = await mintLabelFromMusicbrainz(
          input.mbLabelId,
          input.seedState,
          input.takeOverSlug,
        );

        purgeEntityCache("label", label.slug);

        return { label, ok: true as const, outcome, ...(takenOver ? { takenOver } : {}) };
      } catch (error) {
        if (error instanceof MusicbrainzLabelNotFoundError) {
          throw new ORPCError("NOT_FOUND", {
            data: { apiCode: "musicbrainz_label_not_found", apiMessage: error.message },
            message: error.message,
            status: 404,
          });
        }

        if (error instanceof MusicbrainzThrottledError) {
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            data: { apiCode: "musicbrainz_rate_limited", apiMessage: error.message },
            message: error.message,
            status: 503,
          });
        }

        if (error instanceof LabelMintIdentityConflictError) {
          throw new ORPCError("CONFLICT", {
            data: { apiCode: "label_identity_conflict", apiMessage: error.message },
            message: error.message,
            status: 409,
          });
        }

        if (error instanceof LabelTakeOverSlugMismatchError) {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "take_over_slug_mismatch", apiMessage: error.message },
            message: error.message,
            status: 400,
          });
        }

        if (error instanceof LabelTakeOverNotEmptyError) {
          throw new ORPCError("CONFLICT", {
            data: { apiCode: "take_over_not_empty", apiMessage: error.message },
            message: error.message,
            status: 409,
          });
        }

        throw apiFault(error);
      }
    });

  const listLabelAliasesHandler = os.list_label_aliases.use(adminAuth).handler(async () => {
    try {
      return { aliases: await listLabelAliasCandidates(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const confirmLabelAliasHandler = os.confirm_label_alias
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await confirmLabelAlias(input.id);

        return { ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const rejectLabelAliasHandler = os.reject_label_alias
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await rejectLabelAlias(input.id);

        return { ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const describeLabelHandler = os.describe_label.use(adminAuth).handler(async ({ input }) => {
    try {
      const dryRun = input.dryRun === true;
      const label = await getLabelBySlug(input.slug);

      if (!label) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No label with slug ${input.slug}` },
          message: `No label with slug ${input.slug}`,
          status: 404,
        });
      }

      if (!dryRun && label.bio?.trim()) {
        return { bio: label.bio, ok: true as const, skipped: true as const, slug: label.slug };
      }

      const gated = gateOrAcceptBio({
        bio: input.bio,
        finalAttempt: input.finalAttempt === true,
        kind: "label",
        name: label.name,
        slug: label.slug,
      });

      const { bio } = gated;

      if (dryRun) {
        return { ...gated, dryRun: true as const, ok: true as const, slug: label.slug };
      }

      const filled = await fillEmptyLabelBio(
        label.slug,
        bio,
        input.promptVersion,
        gated.voiceViolations ?? null,
      );

      if (!filled) {
        const current = await getLabelBySlug(input.slug);

        return {
          bio: current?.bio ?? bio,
          ok: true as const,
          skipped: true as const,
          slug: label.slug,
        };
      }

      purgeEntityCache("label", label.slug);

      return { ...gated, ok: true as const, slug: label.slug };
    } catch (error) {
      throw toFault(error);
    }
  });

  const draftLabelBioHandler = os.draft_label_bio.use(adminAuth).handler(async ({ input }) => {
    try {
      const label = await getLabelBySlug(input.slug);

      if (!label) {
        return {
          findingCount: 0,
          found: false as const,
          hasFacts: false,
          name: "",
          prompt: "",
          promptVersion: 0,
        };
      }

      const facts = await fetchEntityFacts({ kind: "label", name: label.name });
      const findings = await getFindingsByLabel(label.id);
      const findingTitles = findings.map((finding) => finding.title);

      const { body, version } = await buildEntityBioPrompt({
        facts: facts?.facts ?? null,
        findingTitles,
        kind: "label",
        name: label.name,
      });

      return {
        findingCount: findingTitles.length,
        found: true as const,
        hasFacts: facts != null,
        name: label.name,
        prompt: body,
        promptVersion: version,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const listLabelsMissingBioHandler = os.list_labels_missing_bio
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const labels = await listLabelsMissingBio(parseLimit(input.limit, 50, 200));

        return { labels, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    confirm_label_alias: confirmLabelAliasHandler,
    describe_label: describeLabelHandler,
    draft_label_bio: draftLabelBioHandler,
    list_label_aliases: listLabelAliasesHandler,
    list_label_artist_rules: listLabelArtistRulesHandler,
    list_labels_admin: listLabelsAdminHandler,
    list_labels_missing_bio: listLabelsMissingBioHandler,
    merge_label: mergeLabelHandler,
    mint_label: mintLabelHandler,
    reject_label_alias: rejectLabelAliasHandler,
    replace_label_artist_rules: replaceLabelArtistRulesHandler,
    update_label: updateLabelHandler,
  };
}
