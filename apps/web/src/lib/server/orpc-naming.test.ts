import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES } from "@fluncle/contracts/orpc";

// Turns the ratified `verb_noun` cross-surface naming convention
// (docs/naming-conventions.md, "Convention B") from a review-only rule into a
// BUILD-FAIL check. The contract registry (`@fluncle/contracts/orpc`) is the
// source of truth for every machine-facing op name (§4), and every key in it is
// the canonical op the rest of the surfaces (CLI/API/MCP/SSH) derive from. So
// asserting the registry keys all obey the convention enforces it everywhere a
// name is derived from.
//
// The sibling coverage tests (orpc-coverage.test.ts / orpc-admin-coverage.test.ts)
// pin the exact SET of ops a route maps to. This test is the complement: it does
// NOT pin the full list (that would duplicate them and rot), it pins the SHAPE +
// the verb each op name must take. An op added in camelCase, as a single word, or
// with an unapproved verb fails the build here, before it can leak a fifth
// spelling of an operation onto a public surface.

// The canonical op-name shape: `verb_noun`, lowercase `snake_case`, at least two
// segments, each segment a run of [a-z0-9] (digits allowed only after the first
// letter of a segment). Catches camelCase (`getTrack`), a bare single word
// (`enrich`), SCREAMING_CASE, and leading/trailing/double underscores.
const VERB_NOUN_SHAPE = /^[a-z]+(?:_[a-z0-9]+)+$/;

// The approved leading verbs. The convention (§3, §6) names a small closed set
// (`list`, `get`, `search`, `submit`, `subscribe`, `create`, `update`, `delete`,
// `publish`) plus a named non-CRUD action set (`enrich`, `observe`, `render`,
// `draft`, `distribute`, `backfill`, `authorize`, `finalize`). The live registry
// also already uses a handful of additional concrete actions the doc's prose set
// doesn't enumerate verbatim (e.g. `add`, `approve`, `mint`). To enforce the
// VERB without pinning the full op list (the coverage tests already pin that),
// this set is the doc's closed set UNIONED with the verbs the registry uses
// today. The point it guards: a NEW op must reuse one of these verbs — an
// off-convention coinage (`fetch_track`, `grab_track`) fails here, forcing it
// back to the registry vocabulary or a deliberate edit of this set with a reason.
const APPROVED_VERBS = new Set<string>([
  // The convention's closed CRUD-ish verb set (docs/naming-conventions.md §3, §6).
  "create",
  "delete",
  "get",
  "list",
  "publish",
  "search",
  "submit",
  "subscribe",
  "update",
  // The convention's named non-CRUD action set (§3, §6).
  "authorize",
  "backfill",
  "distribute",
  "draft",
  "enrich",
  "finalize",
  // `note` (auto-author a finding's editorial note) — the written-note sibling of
  // `observe`/`context`, same verb-as-action shape ("note this finding").
  "note",
  "observe",
  "render",
  // Concrete actions already in the live registry the prose set doesn't spell out
  // verbatim. Adding a genuinely new verb is a deliberate edit here (with a reason),
  // which is exactly the gate this test exists to enforce.
  "add",
  "approve",
  "collect",
  "context",
  "deregister",
  "exchange",
  "export",
  "initiate",
  "merge",
  "mint",
  "presign",
  "register",
  "reject",
  "reset",
  "save",
  "send",
  "set",
  "start",
  "sweep",
  "unsave",
]);

describe("oRPC op-name naming convention (verb_noun, Convention B)", () => {
  const opNames = [...CONTRACT_OPERATION_NAMES] as string[];

  it("has ops to check (registry is not empty)", () => {
    // A guard so a broken import can't make the assertions below pass vacuously.
    expect(opNames.length).toBeGreaterThan(0);
  });

  it("every contract op name is lowercase snake_case `verb_noun`", () => {
    for (const op of opNames) {
      expect(
        VERB_NOUN_SHAPE.test(op),
        `op "${op}" is not a lowercase snake_case verb_noun (e.g. "get_track"); see docs/naming-conventions.md Convention B`,
      ).toBe(true);
    }
  });

  it("every contract op name starts with an approved verb", () => {
    for (const op of opNames) {
      const verb = op.split("_")[0] ?? op;

      expect(
        APPROVED_VERBS.has(verb),
        `op "${op}" leads with the unapproved verb "${verb}" — reuse a verb from the convention's closed set (docs/naming-conventions.md §6) or add it to APPROVED_VERBS deliberately`,
      ).toBe(true);
    }
  });
});
