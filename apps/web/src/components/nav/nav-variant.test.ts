import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_VARIANT, NAV_VARIANTS, resolveActiveVariant } from "./nav-variant";

// The prod-safety contract of the variation picker: production ALWAYS renders the
// default (A), no matter what a stray localStorage value says, so an operator's dev
// pick can never leak into what ships. The picker component itself is behind
// `import.meta.env.DEV` (verified dead in the prod bundle by the build gate); this
// pins the pure decision the component and the SSR mount both depend on.

describe("resolveActiveVariant (nav picker prod-safety)", () => {
  it("always returns the default in production, ignoring any stored choice", () => {
    for (const stored of ["A", "B", "C", "D", "garbage", null]) {
      expect(resolveActiveVariant({ isDev: false, stored })).toBe(DEFAULT_NAV_VARIANT);
    }
  });

  it("honours a valid stored choice in dev", () => {
    for (const variant of NAV_VARIANTS) {
      expect(resolveActiveVariant({ isDev: true, stored: variant })).toBe(variant);
    }
  });

  it("falls back to the default in dev for a missing or invalid stored value", () => {
    expect(resolveActiveVariant({ isDev: true, stored: null })).toBe(DEFAULT_NAV_VARIANT);
    expect(resolveActiveVariant({ isDev: true, stored: "Z" })).toBe(DEFAULT_NAV_VARIANT);
    expect(resolveActiveVariant({ isDev: true, stored: "" })).toBe(DEFAULT_NAV_VARIANT);
  });

  it("defaults to variant A", () => {
    expect(DEFAULT_NAV_VARIANT).toBe("A");
  });
});

// The picker's prod-deadness rests on Vite constant-folding a LITERAL
// `import.meta.env.DEV` at the call site: rollup can then eliminate the branch AND
// the VariantPicker import. Hiding that check behind a helper (`isPickerEnabled()`)
// silently defeats the folding and ships the picker to production — a real bug this
// build hit once. Pin the idiom in the source so a refactor can't reintroduce it.
describe("nav picker is dead-code-eliminated in prod", () => {
  const chromeSource = readFileSync(
    fileURLToPath(new URL("./public-chrome.tsx", import.meta.url)),
    "utf8",
  );

  it("guards the picker render with a literal import.meta.env.DEV", () => {
    expect(chromeSource).toContain("import.meta.env.DEV ? <VariantPicker");
  });

  it("guards the stored-variant effect with a literal import.meta.env.DEV", () => {
    expect(chromeSource).toContain("if (!import.meta.env.DEV)");
  });

  it("never resolves the DEV flag through a helper call (that would defeat folding)", () => {
    expect(chromeSource).not.toMatch(/isNavPickerEnabled\s*\(/);
  });

  it("keeps the picker's CSS colocated so it dies with the component", () => {
    const picker = readFileSync(
      fileURLToPath(new URL("./variant-picker.tsx", import.meta.url)),
      "utf8",
    );

    expect(picker).toContain(".nav-picker {");
  });
});
