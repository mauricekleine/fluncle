import { describe, expect, it } from "vitest";
import { MAX_SAVED_TRACKS } from "@/lib/saved-tracks";
import { saveAnnouncement } from "./track-menu-items";

describe("saveAnnouncement", () => {
  it("only says a save is on this device when the device kept it", () => {
    expect(saveAnnouncement({ kept: "device", outcome: "saved" })).toBe("Saved on this device.");
    expect(saveAnnouncement({ kept: "page", outcome: "saved" })).not.toContain(
      "Saved on this device",
    );
    expect(saveAnnouncement({ kept: "page", outcome: "saved" })).toContain("won't keep that track");
  });

  it("only says a save was removed for good when the device kept the removal", () => {
    expect(saveAnnouncement({ kept: "device", outcome: "removed" })).toBe("Removed from saves.");
    expect(saveAnnouncement({ kept: "page", outcome: "removed" })).toContain("after a reload");
  });

  it("names the bound when a full device refuses a save", () => {
    expect(saveAnnouncement({ kept: "device", outcome: "full" })).toContain(
      `${MAX_SAVED_TRACKS} saves`,
    );
  });

  it("confirms an account save and a removal", () => {
    expect(saveAnnouncement({ kept: "account", outcome: "saved" })).toBe("Saved to your account.");
    expect(saveAnnouncement({ kept: "account", outcome: "removed" })).toBe("Removed from saves.");
  });
});
