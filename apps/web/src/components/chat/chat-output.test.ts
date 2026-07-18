import { describe, expect, it } from "vitest";
import { type FluncleUIMessage } from "@/lib/server/chat";
import { collectChatFindings, planListOutput } from "./chat-output";

// The pure half of ChatDnB's tool-output rendering: the register-split render plan and the
// transcript's finding walk. These pin the two guarantees Unit C rests on — that a two-bucket
// output composes BOTH buckets (never either/or) with the heading gated on findings, and that a
// catalogue row is NEVER swept into the previewable-finding map (the distinct-key guarantee).

describe("planListOutput — the register-split render plan", () => {
  const finding = { artists: ["Nu:Tone"], coordinate: "004.7.2I", title: "Better Places" };
  const catalogue = { artists: ["Ghost"], title: "Out There" };

  it("composes BOTH buckets on a mixed result and heads the catalogue block 'Tracks'", () => {
    const plan = planListOutput({ catalogue: [catalogue], findings: [finding], ok: true });

    expect(plan?.findings).toHaveLength(1);
    expect(plan?.catalogue).toHaveLength(1);
    // A mixed result heads the catalogue block with the true superset — findings render above it.
    expect(plan?.catalogueHeading).toBe("Tracks");
  });

  it("leaves a catalogue-only answer BARE (no heading — a heading would name the tier)", () => {
    // The wire drops the empty findings bucket (dropEmpty), so the key may be absent entirely.
    const plan = planListOutput({ catalogue: [catalogue], ok: true });

    expect(plan?.findings).toHaveLength(0);
    expect(plan?.catalogue).toHaveLength(1);
    expect(plan?.catalogueHeading).toBeUndefined();
  });

  it("carries a findings-only result with no catalogue block", () => {
    const plan = planListOutput({ findings: [finding], ok: true });

    expect(plan?.findings).toHaveLength(1);
    // No catalogue rows ⇒ no catalogue block renders; the heading value is inert (the render gates
    // the whole block on catalogue.length > 0).
    expect(plan?.catalogue).toHaveLength(0);
  });

  it("keeps the sonic anchor but does NOT let it light the heading on its own", () => {
    const anchor = { artists: ["Anchor"], coordinate: "009.1.1A", title: "Anchor Track" };
    const plan = planListOutput({ anchor, catalogue: [catalogue], ok: true });

    expect(plan?.anchor?.coordinate).toBe("009.1.1A");
    // findings is empty, so the block stays bare even though a named anchor renders above it.
    expect(plan?.catalogueHeading).toBeUndefined();
  });

  it("returns undefined for a shape with neither bucket, and for a non-object", () => {
    expect(planListOutput({ ok: true })).toBeUndefined();
    expect(planListOutput({ catalogue: [], findings: [] })).toBeUndefined();
    expect(planListOutput(null)).toBeUndefined();
    expect(planListOutput("nope")).toBeUndefined();
  });
});

describe("collectChatFindings — the transcript's finding walk", () => {
  function toolMessage(output: unknown): FluncleUIMessage {
    return {
      id: "m1",
      parts: [
        {
          input: {},
          output,
          state: "output-available",
          toolCallId: "c1",
          type: "tool-search_archive",
        },
      ],
      role: "assistant",
    } as unknown as FluncleUIMessage;
  }

  it("collects findings by coordinate and NEVER sweeps a catalogue row (the distinct-key guarantee)", () => {
    const map = collectChatFindings([
      toolMessage({
        catalogue: [
          {
            artists: ["Ghost"],
            spotifyUrl: "https://open.spotify.com/track/x",
            title: "Out There One",
          },
        ],
        findings: [{ artists: ["Nu:Tone"], coordinate: "004.7.2I", title: "Better Places" }],
        ok: true,
      }),
    ]);

    // Only the finding's coordinate is a key — the catalogue bucket is never read.
    expect([...map.keys()]).toEqual(["004.7.2I"]);
    expect([...map.values()].some((finding) => finding.title === "Out There One")).toBe(false);
  });

  it("does not sweep a coordinate-less catalogue step out of a mix chain", () => {
    const map = collectChatFindings([
      toolMessage({
        ok: true,
        set: {
          seed: { artists: ["Seed"], coordinate: "004.7.2I", title: "Seed" },
          steps: [
            { artists: ["A"], coordinate: "005.1.3B", reason: "Same key", title: "One" },
            {
              artists: ["Cat"],
              reason: "Close in sound",
              spotifyUrl: "https://open.spotify.com/track/c",
              title: "Catalogue Cut",
            },
          ],
        },
      }),
    ]);

    // The seed + the certified step are keyed; the coordinate-less catalogue step is not.
    expect([...map.keys()].sort()).toEqual(["004.7.2I", "005.1.3B"]);
    expect([...map.values()].some((finding) => finding.title === "Catalogue Cut")).toBe(false);
  });
});
