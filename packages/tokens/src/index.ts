// DESIGN.md is canonical. This package mirrors it verbatim.
// Source of truth: DESIGN.md at the repo root (frontmatter + prose).
// If a value here disagrees with DESIGN.md, DESIGN.md wins; fix this file.

/**
 * Night-sky palette lit by one sun: warm blacks, sleeve-paper cream, and a
 * single committed gold. Camel-cased mirrors of DESIGN.md's kebab-cased keys.
 * `ruleDark` is the separator/non-focus border hex used by the SSH app
 * (DESIGN.md prose: Dust Line over Deep Field resolves to #3a342a).
 */
export const colors = {
  deepField: "#090a0b",
  dustLine: "#d0b99029",
  dustVeil: "#d0b9901a",
  eclipseGlow: "#ffd057",
  eclipseGold: "#f5b800",
  goldVeil: "#f5b8001a",
  inkOnGold: "#151006",
  // The live-set colour — the one sanctioned second light, used ONLY for the
  // cross-surface live-on-Twitch callout (DESIGN.md "The Live Exception").
  nebulaVeil: "#ab7bff1a",
  nebulaViolet: "#ab7bff",
  reentryRed: "#ff6b57",
  ruleDark: "#3a342a",
  sleeveBlack: "#10100d",
  stardust: "#b7ab95",
  starlightCream: "#f4ead7",
  tapeBlack: "#171611",
} as const;

export type ColorToken = keyof typeof colors;
export type ColorValue = (typeof colors)[ColorToken];

/**
 * Type roles from DESIGN.md. Oxanium speaks for the brand (display, numeric);
 * Space Grotesk does the reading (title, body, label); mono is the machine.
 */
export const typography = {
  body: {
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif",
    fontSize: "0.9rem",
    fontWeight: 400,
    lineHeight: 1.25,
  },
  display: {
    fontFamily: "Oxanium, ui-sans-serif, system-ui, sans-serif",
    fontWeight: 800,
    letterSpacing: "-0.02em",
  },
  label: {
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif",
    fontSize: "0.76rem",
    fontWeight: 800,
  },
  mono: {
    fontFamily: "Monaspace Krypton, ui-monospace, SF Mono, Menlo, monospace",
    fontSize: "0.82rem",
    fontWeight: 400,
    lineHeight: 1.5,
  },
  numeric: {
    fontFamily: "Oxanium, ui-sans-serif, system-ui, sans-serif",
    fontSize: "0.98rem",
    fontVariation: "tabular-nums",
    fontWeight: 400,
    letterSpacing: "-0.02em",
  },
  title: {
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif",
    fontSize: "1.02rem",
    fontWeight: 800,
    letterSpacing: "-0.01em",
    lineHeight: 1.18,
  },
} as const;

export type TypographyRole = keyof typeof typography;

/**
 * Border radii from DESIGN.md's `rounded` frontmatter. `artwork` is the
 * 6px album-art radius; sm/md/lg ascend the standard scale.
 */
export const radii = {
  artwork: "6px",
  lg: "0.625rem",
  md: "0.5rem",
  sm: "0.375rem",
} as const;

export type RadiusToken = keyof typeof radii;

/**
 * Motion from DESIGN.md prose: state changes are 150ms ease-out; floats
 * (hover lift, caret drift) are 180ms on a gentle ease-out cubic-bezier.
 * Under prefers-reduced-motion the float collapses to the state transition.
 */
export const motion = {
  float: {
    durationMs: 180,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  state: {
    durationMs: 150,
    easing: "ease-out",
  },
} as const;

export type MotionRole = keyof typeof motion;
