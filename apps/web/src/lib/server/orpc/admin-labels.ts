// The `admin-labels` domain router module — the label entity's admin surface and the
// operator's crawl-seed control. Two ops, on the `admin-galaxies` pattern:
//
//   - `list_labels_admin` — `adminAuth` (agent-allowed read): every label with its seed
//     state + finding count. `?seedState=enabled` is the seed-set read the catalogue
//     crawler makes with its agent token.
//   - `update_label` — `adminAuth` + `operatorGuard` (OPERATOR): the ruling. Steering what
//     Fluncle crawls next is an editorial act, so the box's agent token 403s — the
//     `update_galaxy` precedent.
//
// The ruling is CRAWL SCOPE, NEVER STORAGE: it changes the NEXT crawl's seed set and
// touches nothing already stored. Neither handler reads or writes a track, a finding, or
// anything a crawl brought in — and neither ever should. See docs/label-entity.md.

import { buildEntityBioPrompt, fetchEntityFacts, gateBioText } from "../bio";
import { purgeEntityCache } from "../edge-cache";
import {
  confirmLabelAlias,
  fillEmptyLabelBio,
  getLabelBySlug,
  LabelNotFoundError,
  listLabelAliasCandidates,
  listLabels,
  listLabelsMissingBio,
  rejectLabelAlias,
  updateLabelSeedState,
} from "../labels";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { getFindingsByLabel } from "../tracks";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer, parseLimit, toFault } from "./_shared";

/** Build the `admin-labels` domain's handlers. */
export function adminLabelsHandlers(os: Implementer) {
  // GET /admin/labels — `adminAuth` (operator OR agent): every label, optionally scoped
  // to one seed state (the crawler's `?seedState=enabled` read).
  const listLabelsAdminHandler = os.list_labels_admin.use(adminAuth).handler(async ({ input }) => {
    try {
      return { labels: await listLabels(input.seedState), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // PATCH /admin/labels/{id} — OPERATOR tier: rule on a label's crawl-seed state. An
  // agent token 403s at `operatorGuard`.
  const updateLabelHandler = os.update_label
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const label = await updateLabelSeedState(input.id, input.seedState);

        return { label, ok: true } as const;
      } catch (error) {
        if (error instanceof LabelNotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: error.message });
        }

        throw apiFault(error);
      }
    });

  // GET /admin/labels/aliases — `adminAuth`: the open alias candidates the review section reads.
  const listLabelAliasesHandler = os.list_label_aliases.use(adminAuth).handler(async () => {
    try {
      return { aliases: await listLabelAliasCandidates(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/labels/aliases/{id}/confirm — OPERATOR tier: rule two spellings one label.
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

  // DELETE /admin/labels/aliases/{id} — OPERATOR tier: discard a proposed spelling.
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

  // POST /admin/labels/{slug}/bio — agent tier (`adminAuth`), the note_track precedent:
  // the on-box sweep authored the label's bio; this VOICE-GATES it and stores it
  // FILL-EMPTY-ONLY. A bio already on file (operator OR previously auto-authored) is a
  // skipped no-op. Deliberately AGENT tier (unlike the operator-tier `update_label`
  // crawl-seed ruling): authoring a bio is enrichment, not an editorial crawl ruling.
  const describeLabelHandler = os.describe_label.use(adminAuth).handler(async ({ input }) => {
    try {
      // `dryRun` runs the voice gate and stores nothing (the sweep's pre-check).
      const dryRun = input.dryRun === true;
      const label = await getLabelBySlug(input.slug);

      if (!label) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No label with slug ${input.slug}` },
          message: `No label with slug ${input.slug}`,
          status: 404,
        });
      }

      // Fast-path skip; the real guarantee is the DB predicate in `fillEmptyLabelBio`.
      if (!dryRun && label.bio?.trim()) {
        return { bio: label.bio, ok: true as const, skipped: true as const, slug: label.slug };
      }

      // Voice-gate the agent-authored bio (defence in depth, re-scanned server-side).
      const bio = gateBioText(input.bio);

      if (dryRun) {
        return { bio, dryRun: true as const, ok: true as const, slug: label.slug };
      }

      // Fill the empty bio ATOMICALLY — the fill-empty-only predicate lives in the SQL.
      const filled = await fillEmptyLabelBio(label.slug, bio, input.promptVersion);

      if (!filled) {
        const current = await getLabelBySlug(input.slug);

        return {
          bio: current?.bio ?? bio,
          ok: true as const,
          skipped: true as const,
          slug: label.slug,
        };
      }

      // The bio is a primary rendered block on `/label/<slug>`; drop its cached page so the
      // new bio surfaces. Only on an actual write (fill-empty may have no-op'd above).
      purgeEntityCache("label", label.slug);

      return { bio, ok: true as const, slug: label.slug };
    } catch (error) {
      throw toFault(error);
    }
  });

  // GET /admin/labels/{slug}/bio-draft — agent tier (`adminAuth`): the Worker-paced grounding
  // seam (the describe_label sibling). The box cannot gather Firecrawl facts (no key) or
  // enumerate the tracks it has logged on a label (not on the wire), so it triggers this READ:
  // the Worker runs the Firecrawl gather with ITS key + pulls the logged finding titles from
  // ITS DB, assembles the registered bio prompt, and returns the ready-to-author prompt + its
  // provenance version. The box then authors with `claude -p` and writes back via
  // `describe_label`. Publishes nothing. A missing slug returns `found:false` (never throws).
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

      // Gather Worker-side: Firecrawl facts (with the Worker's key) + the logged finding
      // titles (with the Worker's DB) — the two the box cannot reach. Both best-effort.
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

  // GET /admin/labels/bio-queue — agent tier (`adminAuth`), the list_labels_admin
  // precedent: the bio worklist (labels with findings but no bio yet), oldest-first.
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
    list_labels_admin: listLabelsAdminHandler,
    list_labels_missing_bio: listLabelsMissingBioHandler,
    reject_label_alias: rejectLabelAliasHandler,
    update_label: updateLabelHandler,
  };
}
