import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES, CONTRACT_OPERATION_ROUTES } from "@fluncle/contracts/orpc";

const VERB_NOUN_SHAPE = /^[a-z]+(?:_[a-z0-9]+)+$/;

const APPROVED_VERBS = new Set<string>([
  "create",
  "delete",
  "get",
  "list",
  "publish",

  "read",
  "search",
  "submit",
  "subscribe",
  "update",

  "advance",

  "acknowledge",

  "activate",

  "anchor",
  "authorize",
  "backfill",
  "checkpoint",

  "compact",

  "coordinate",

  "resolve",

  "capture",

  "commit",
  "distribute",
  "draft",

  "drip",
  "enrich",
  "finalize",

  "migrate",

  "prepare",

  "note",
  "observe",

  "pin",

  "purge",

  "rekey",

  "rank",

  "reconcile",
  "render",

  "requeue",

  "resync",

  "revoke",

  "verify",

  "add",

  "build",

  "announce",
  "approve",

  "certify",
  "collect",

  "confirm",
  "context",

  "describe",

  "crawl",
  "deregister",
  "exchange",
  "export",
  "initiate",
  "inactivate",
  "merge",
  "mint",
  "presign",

  "promote",

  "record",

  "refresh",
  "register",
  "reject",

  "remove",

  "replace",
  "reset",

  "clear",

  "flag",

  "force",

  "review",
  "save",
  "send",
  "set",
  "start",
  "sweep",

  "triage",
  "unsave",

  "upload",
]);

describe("oRPC op-name naming convention (verb_noun, Convention B)", () => {
  const opNames = [...CONTRACT_OPERATION_NAMES] as string[];

  it("has ops to check (registry is not empty)", () => {
    expect(opNames.length).toBeGreaterThan(0);
  });

  it("every contract op name is lowercase snake_case `verb_noun`", () => {
    for (const op of opNames) {
      expect(
        VERB_NOUN_SHAPE.test(op),
        `op "${op}" is not a lowercase snake_case verb_noun (e.g. "get_track")`,
      ).toBe(true);
    }
  });

  it("every contract op name starts with an approved verb", () => {
    for (const op of opNames) {
      const verb = op.split("_")[0] ?? op;

      expect(
        APPROVED_VERBS.has(verb),
        `op "${op}" leads with the unapproved verb "${verb}" — reuse a verb from the convention's closed set or add it to APPROVED_VERBS deliberately`,
      ).toBe(true);
    }
  });

  it("every contract op derives its operationId as the camelCase spelling of its name", () => {
    for (const op of opNames) {
      const route = CONTRACT_OPERATION_ROUTES[op];

      if (!route) {
        expect.fail(`op "${op}" declares no route`);
      }

      const expected = op
        .split("_")
        .map((segment, index) =>
          index === 0 ? segment : `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`,
        )
        .join("");

      expect(
        route.operationId,
        `op "${op}" must declare operationId "${expected}" (Convention B derives it from the op name)`,
      ).toBe(expected);
    }
  });
});
