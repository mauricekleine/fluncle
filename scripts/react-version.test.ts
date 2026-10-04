import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const lock = readFileSync(join(root, "bun.lock"), "utf8");
const mobileReact = (
  JSON.parse(readFileSync(join(root, "apps/mobile/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies.react;

function hoistedVersion(name: string): string | undefined {
  return new RegExp(`^    "${name}": \\["${name}@([^"]+)"`, "m").exec(lock)?.[1];
}

describe("the hoisted React matches mobile's Expo pin", () => {
  it("pins mobile's react exactly", () => {
    expect(mobileReact).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("resolves the workspace's hoisted react and react-dom to mobile's react, so Metro and the web share one copy", () => {
    expect(hoistedVersion("react")).toBe(mobileReact);
    expect(hoistedVersion("react-dom")).toBe(mobileReact);
  });
});
