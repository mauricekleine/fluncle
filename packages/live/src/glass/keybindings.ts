// The glass — the single source of truth for the operator keyboard surface.
// ONE table drives everything: the keydown dispatch in `client/main.ts` (its
// handler map is typed `Record<KeybindingId, …>`, so the compiler forces every
// entry here to be wired), the `i` legend overlay the client renders from these
// rows, and the boot cheat-sheet `serve.ts` prints. The legend can no longer
// drift from the behaviour — add a row here and it lights up in all three places.
// Pure data + helpers: zero DOM, zero Bun deps, so it is importable by the
// browser bundle, the server, and `keybindings.test.ts` alike.

export const KEY_GROUPS = ["plan", "world", "rails", "perf"] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

// The heading each group wears in the overlay (the plan · the world · the rails · dsp/perf).
export const GROUP_LABEL: Record<KeyGroup, string> = {
  perf: "dsp / perf",
  plan: "the plan",
  rails: "the rails",
  world: "the world",
};

export type Keybinding = {
  /** the dispatch id — `main.ts`'s handler map keys off this (compile-time exhaustive) */
  readonly id: string;
  /** every `KeyboardEvent.key` value that triggers this action */
  readonly keys: readonly string[];
  /** the legend label, e.g. "→ / n" or "⇧X" */
  readonly label: string;
  /** the short action description shown beside the label */
  readonly action: string;
  /** which overlay column the row lives in */
  readonly group: KeyGroup;
};

// The order here is the order the boot legend reads and the order rows stack
// within each overlay column. Grouped operator-first: move, then shape the
// world, then the safety rails, then the rig.
export const KEYBINDINGS = [
  {
    action: "advance to the next finding",
    group: "plan",
    id: "advance",
    keys: ["ArrowRight", "n"],
    label: "→ / n",
  },
  {
    action: "rewind to the previous finding",
    group: "plan",
    id: "rewind",
    keys: ["ArrowLeft", "p"],
    label: "← / p",
  },

  {
    action: "select the vehicle",
    group: "world",
    id: "vehicle",
    keys: ["1", "2", "3"],
    label: "1 / 2 / 3",
  },
  { action: "auto-morph (matcher drives)", group: "world", id: "auto", keys: ["m"], label: "m" },
  { action: "replay the arrival scene", group: "world", id: "replay", keys: ["v"], label: "v" },
  { action: "track plate show/hide", group: "plan", id: "plate", keys: ["t"], label: "t" },
  { action: "bloom toggle", group: "world", id: "bloom", keys: ["g"], label: "g" },
  {
    action: "intensity down / up",
    group: "world",
    id: "intensity",
    keys: ["-", "_", "=", "+"],
    label: "- / =",
  },

  { action: "the holding scene", group: "rails", id: "holding", keys: ["0"], label: "0" },
  { action: "blackout — hold to engage", group: "rails", id: "blackout", keys: ["b"], label: "b" },
  { action: "context-loss smoke", group: "rails", id: "smoke", keys: ["X"], label: "⇧X" },

  { action: "low-latency DSP (A/B)", group: "perf", id: "lowLatency", keys: ["l"], label: "l" },
  { action: "render-scale cycle", group: "perf", id: "scale", keys: ["r"], label: "r" },
  { action: "HUD toggle", group: "perf", id: "hud", keys: ["h"], label: "h" },
  { action: "demo beat", group: "perf", id: "demo", keys: ["d"], label: "d" },
  { action: "this keys overlay", group: "perf", id: "keys", keys: ["i"], label: "i" },
] as const satisfies readonly Keybinding[];

// The literal union of every dispatch id — `main.ts` types its handler map with
// this so a table entry without a handler (or vice versa) fails typecheck.
export type KeybindingId = (typeof KEYBINDINGS)[number]["id"];

/** The bindings in a single group, in table order (drives one overlay column). */
export function bindingsByGroup(group: KeyGroup): readonly Keybinding[] {
  return KEYBINDINGS.filter((b) => b.group === group);
}

/** Every declared key → its binding. The keydown dispatcher's lookup. */
export function keyToBinding(): Map<string, (typeof KEYBINDINGS)[number]> {
  const m = new Map<string, (typeof KEYBINDINGS)[number]>();
  for (const b of KEYBINDINGS) {
    for (const k of b.keys) {
      m.set(k, b);
    }
  }
  return m;
}

/** The one-line boot cheat-sheet (`serve.ts`), generated so it can't drift. */
export function legendLine(): string {
  return KEYBINDINGS.map((b) => `${b.label} ${b.action}`).join(" · ");
}
