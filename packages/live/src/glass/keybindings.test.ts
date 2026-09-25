import { describe, expect, test } from "bun:test";

import {
  bindingsByGroup,
  GROUP_LABEL,
  KEY_GROUPS,
  KEYBINDINGS,
  keyToBinding,
  legendLine,
} from "./keybindings.ts";

describe("KEYBINDINGS table integrity", () => {
  test("the table is non-empty", () => {
    expect(KEYBINDINGS.length).toBeGreaterThan(0);
  });

  test("every key is claimed by exactly one binding (no collisions)", () => {
    const owner = new Map<string, string>();
    for (const b of KEYBINDINGS) {
      for (const k of b.keys) {
        expect(owner.has(k)).toBe(false);
        owner.set(k, b.id);
      }
    }
  });

  test("dispatch ids are unique", () => {
    const ids = KEYBINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every binding is fully specified", () => {
    for (const b of KEYBINDINGS) {
      expect(b.id.length).toBeGreaterThan(0);
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.action.length).toBeGreaterThan(0);
      expect(b.keys.length).toBeGreaterThan(0);
      expect(KEY_GROUPS).toContain(b.group);
    }
  });

  test("every group is non-empty and has a heading", () => {
    for (const g of KEY_GROUPS) {
      expect(bindingsByGroup(g).length).toBeGreaterThan(0);
      expect(GROUP_LABEL[g].length).toBeGreaterThan(0);
    }
  });

  test("keyToBinding resolves every declared key to its binding", () => {
    const byKey = keyToBinding();
    for (const b of KEYBINDINGS) {
      for (const k of b.keys) {
        expect(byKey.get(k)).toBe(b);
      }
    }
  });

  test("the overlay toggle (i) and the special-cased Shift+X both live in the table", () => {
    const byKey = keyToBinding();
    expect(byKey.get("i")?.id).toBe("keys");

    expect(byKey.get("X")?.id).toBe("smoke");
  });

  test("the boot legend lists every binding", () => {
    const line = legendLine();
    for (const b of KEYBINDINGS) {
      expect(line).toContain(b.action);
    }
  });
});
