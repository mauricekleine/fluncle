import { describe, expect, it } from "vitest";
import { followLanding, withoutFollowParams } from "./follow-button";

describe("follow landing", () => {
  it("reads the follow intent and a failed link off the callback URL", () => {
    expect(followLanding("?follow=abc.def")).toEqual({ error: false, intent: "abc.def" });
    expect(followLanding("?error=INVALID_TOKEN")).toEqual({ error: true, intent: undefined });
    expect(followLanding("?page=2")).toEqual({ error: false, intent: undefined });
  });

  it("strips only its own params so the page keeps its state", () => {
    expect(withoutFollowParams("/label/hospital", "?follow=abc.def&sort=recent")).toBe(
      "/label/hospital?sort=recent",
    );
    expect(withoutFollowParams("/artist/netsky", "?error=INVALID_TOKEN")).toBe("/artist/netsky");
  });
});
