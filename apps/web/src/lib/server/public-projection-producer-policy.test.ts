import { describe, expect, it } from "vitest";

import { DUE_WORK_PRODUCER_INVENTORY } from "./due-work-producer-inventory";
import {
  PUBLIC_PROJECTION_PRODUCER_POLICIES,
  resolvePublicProjectionProducerTargets,
  type PublicProjectionProducerPolicy,
  validatePublicProjectionProducerPolicies,
} from "./public-projection-producer-policy";

const SINGLE_PRODUCER_INVENTORY = [{ producers: ["known"] }] as const;
const SINGLE_DYNAMIC_INVENTORY = [{ producers: ["track-update"] }] as const;

describe("public projection producer policy", () => {
  it("covers every inventoried producer exactly once", () => {
    const policies = validatePublicProjectionProducerPolicies(
      DUE_WORK_PRODUCER_INVENTORY,
      PUBLIC_PROJECTION_PRODUCER_POLICIES,
    );
    const inventory = DUE_WORK_PRODUCER_INVENTORY.flatMap((entry) => entry.producers);

    expect(policies.size).toBe(inventory.length);
    expect([...policies.keys()].sort()).toEqual([...inventory].sort());
    expect(
      PUBLIC_PROJECTION_PRODUCER_POLICIES.filter((policy) => policy.kind === "dynamic").map(
        (policy) => policy.producerId,
      ),
    ).toEqual(["track-update", "label-seed-state", "hub-entity-relink"]);
  });

  it("locks every dependency-bearing static producer and leaves every other static writer inert", () => {
    const expectedByImpact = {
      artist_qualification: new Set([
        "artist-credit-edges",
        "artist-edge-backfill",
        "artist-edge-link",
        "artist-edge-upsert",
        "artist-remixer-role-stamp",
        "backfill-artist-links",
        "backfill-label-link",
        "backfill-label-seed",
        "backfill-remixer-role",
        "certify-track",
        "label-merge",
      ]),
      both: new Set(["publish-track"]),
      public_aggregates: new Set(["crawl-track-mint", "label-release-track-mint"]),
    };
    const staticPolicies = PUBLIC_PROJECTION_PRODUCER_POLICIES.filter(
      (policy) => policy.kind === "static",
    );

    for (const policy of staticPolicies) {
      const expected = expectedByImpact.public_aggregates.has(policy.producerId)
        ? "public_aggregates"
        : expectedByImpact.artist_qualification.has(policy.producerId)
          ? "artist_qualification"
          : expectedByImpact.both.has(policy.producerId)
            ? "both"
            : "neither";
      expect(policy.impact, policy.producerId).toBe(expected);
    }
    expect(staticPolicies.filter((policy) => policy.impact === "neither")).toHaveLength(83);
  });

  it("rejects missing, duplicate, unknown, and duplicated inventory producers", () => {
    expect(() => validatePublicProjectionProducerPolicies(SINGLE_PRODUCER_INVENTORY, [])).toThrow(
      /missing.*known/,
    );
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_PRODUCER_INVENTORY, [
        { impact: "neither", kind: "static", producerId: "known" },
        { impact: "neither", kind: "static", producerId: "known" },
      ]),
    ).toThrow(/duplicate.*known/);
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_PRODUCER_INVENTORY, [
        { impact: "neither", kind: "static", producerId: "unknown" },
      ]),
    ).toThrow(/unknown.*unknown/);
    expect(() =>
      validatePublicProjectionProducerPolicies(
        [{ producers: ["known", "known"] }],
        [{ impact: "neither", kind: "static", producerId: "known" }],
      ),
    ).toThrow(/inventory contains duplicate/);
  });

  it("rejects unjustified, empty, repeated, and unknown dynamic policies", () => {
    const dynamic = (overrides: Partial<PublicProjectionProducerPolicy>) =>
      ({
        allowedImpacts: ["neither", "public_aggregates"],
        kind: "dynamic",
        producerId: "track-update",
        rationale: "field-sensitive",
        ...overrides,
      }) as PublicProjectionProducerPolicy;

    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_DYNAMIC_INVENTORY, [
        dynamic({ rationale: " " }),
      ]),
    ).toThrow(/needs a rationale/);
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_DYNAMIC_INVENTORY, [
        dynamic({ allowedImpacts: [] }),
      ]),
    ).toThrow(/needs allowed impacts/);
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_DYNAMIC_INVENTORY, [
        dynamic({ allowedImpacts: ["neither", "neither"] }),
      ]),
    ).toThrow(/repeats an impact/);
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_DYNAMIC_INVENTORY, [
        dynamic({ allowedImpacts: ["unknown"] as never }),
      ]),
    ).toThrow(/unknown impact/);
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_DYNAMIC_INVENTORY, [
        dynamic({ allowedImpacts: ["neither", "both"] }),
      ]),
    ).toThrow(/invalid allowed impacts/);
  });

  it("permits dynamic policy only for the exact three field-sensitive producers", () => {
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_PRODUCER_INVENTORY, [
        {
          allowedImpacts: ["neither", "public_aggregates"],
          kind: "dynamic",
          producerId: "known",
          rationale: "invented branch",
        },
      ]),
    ).toThrow(/static.*cannot use dynamic/);
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_DYNAMIC_INVENTORY, [
        { impact: "neither", kind: "static", producerId: "track-update" },
      ]),
    ).toThrow(/dynamic.*requires dynamic policy/);
  });

  it("rejects inherited object keys as impacts", () => {
    expect(() =>
      validatePublicProjectionProducerPolicies(SINGLE_PRODUCER_INVENTORY, [
        {
          impact: "toString" as never,
          kind: "static",
          producerId: "known",
        },
      ]),
    ).toThrow(/unknown public projection impact/);
  });

  it("resolves each static impact and rejects every static override", () => {
    expect(resolvePublicProjectionProducerTargets("catalogue-rank")).toEqual([]);
    expect(resolvePublicProjectionProducerTargets("crawl-track-mint")).toEqual([
      "public_aggregates",
    ]);
    expect(resolvePublicProjectionProducerTargets("certify-track")).toEqual([
      "artist_qualification",
    ]);
    expect(resolvePublicProjectionProducerTargets("publish-track")).toEqual([
      "public_aggregates",
      "artist_qualification",
    ]);
    expect(() =>
      resolvePublicProjectionProducerTargets("catalogue-rank", {
        impact: "neither",
        justification: "attempted override",
      }),
    ).toThrow(/static.*cannot override/);
  });

  it("requires a justified allowed override for every dynamic producer", () => {
    expect(() => resolvePublicProjectionProducerTargets("track-update")).toThrow(
      /requires an impact override/,
    );
    expect(() =>
      resolvePublicProjectionProducerTargets("track-update", {
        impact: "public_aggregates",
        justification: " ",
      }),
    ).toThrow(/needs justification/);
    expect(() =>
      resolvePublicProjectionProducerTargets("track-update", {
        impact: "artist_qualification",
        justification: "impossible branch",
      }),
    ).toThrow(/not allowed/);
    expect(
      resolvePublicProjectionProducerTargets("track-update", {
        impact: "public_aggregates",
        justification: "key is supplied",
      }),
    ).toEqual(["public_aggregates"]);
    expect(
      resolvePublicProjectionProducerTargets("label-seed-state", {
        impact: "neither",
        justification: "rewalk only",
      }),
    ).toEqual([]);
    expect(
      resolvePublicProjectionProducerTargets("hub-entity-relink", {
        impact: "artist_qualification",
        justification: "label relationship",
      }),
    ).toEqual(["artist_qualification"]);
  });

  it("rejects unknown producers before maintenance can be built", () => {
    expect(() => resolvePublicProjectionProducerTargets("test-fake-producer")).toThrow(
      /unknown due-work producer/,
    );
  });
});
