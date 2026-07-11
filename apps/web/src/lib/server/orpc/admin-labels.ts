// The `admin-labels` domain router module — the label entity's admin surface and the
// operator's crawl-seed control. Two ops, on the `admin-galaxies` pattern:
//
//   - `list_labels_admin` — `adminAuth` (agent-allowed read): every label with its seed
//     state + finding count. `?seedState=enabled` is the seed-set read the future
//     catalogue crawler will make with its agent token. Nothing consumes it yet.
//   - `update_label` — `adminAuth` + `operatorGuard` (OPERATOR): the ruling. Steering what
//     Fluncle crawls next is an editorial act, so the box's agent token 403s — the
//     `update_galaxy` precedent.
//
// The ruling is CRAWL SCOPE, NEVER STORAGE: it changes the NEXT crawl's seed set and
// touches nothing already stored. Neither handler reads or writes a track, a finding, or
// anything a crawl brought in — and neither ever should. See docs/label-entity.md.

import { LabelNotFoundError, listLabels, updateLabelSeedState } from "../labels";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-labels` domain's handlers. */
export function adminLabelsHandlers(os: Implementer) {
  // GET /admin/labels — `adminAuth` (operator OR agent): every label, optionally scoped
  // to one seed state (the crawler's future `?seedState=enabled` read).
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

  return {
    list_labels_admin: listLabelsAdminHandler,
    update_label: updateLabelHandler,
  };
}
