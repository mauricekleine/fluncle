import { describe, expect, it } from "vitest";
import { buildLabelFacts } from "@/lib/label-facts";

describe("buildLabelFacts", () => {
  it("keeps repeated visible facts under distinct source keys", () => {
    const facts = buildLabelFacts({
      disambiguation: "Brazil",
      foundedLocation: "Brazil",
    });

    expect(facts.map((fact) => fact.kind)).toEqual(["disambiguation", "location"]);
    expect(facts.map((fact) => fact.text)).toEqual(["Brazil", "Brazil"]);
  });
});
