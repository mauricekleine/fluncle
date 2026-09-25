export const KEY_GROUPS = ["plan", "world", "rails", "perf"] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

export const GROUP_LABEL: Record<KeyGroup, string> = {
  perf: "dsp / perf",
  plan: "the plan",
  rails: "the rails",
  world: "the world",
};

export type Keybinding = {
  readonly id: string;

  readonly keys: readonly string[];

  readonly label: string;

  readonly action: string;

  readonly group: KeyGroup;
};

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
  { action: "reveal — fire the drop flood", group: "world", id: "reveal", keys: ["f"], label: "f" },
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

export type KeybindingId = (typeof KEYBINDINGS)[number]["id"];

export function bindingsByGroup(group: KeyGroup): readonly Keybinding[] {
  return KEYBINDINGS.filter((b) => b.group === group);
}

export function keyToBinding(): Map<string, (typeof KEYBINDINGS)[number]> {
  const m = new Map<string, (typeof KEYBINDINGS)[number]>();
  for (const b of KEYBINDINGS) {
    for (const k of b.keys) {
      m.set(k, b);
    }
  }
  return m;
}

export function legendLine(): string {
  return KEYBINDINGS.map((b) => `${b.label} ${b.action}`).join(" · ");
}
