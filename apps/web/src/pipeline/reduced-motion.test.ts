import { describe, expect, it } from "vitest";
import { STYLES } from "./create-pipeline";

// `/pipeline` injects its own stylesheet as a template string rather than going through
// the app sheet, so nothing in the build reads it and no browser on the audit box ever
// renders it. That makes its `prefers-reduced-motion: reduce` gates the one kind of rule
// that can be WRITTEN correctly and still do nothing: the gate and the rule it overrides
// tie on specificity, so a gate placed above its target loses on source order, and a gate
// written one class short of its target (`.hb` against `.hb.ok`) loses outright. Both
// failures are silent — the CSS parses, the build passes, the motion keeps playing.
//
// This asserts the gates are LIVE, not that the surface gates enough: for every motion
// property neutralized inside a reduce block, the reduce declaration must actually beat
// every rule outside the block that sets the same property on the same selector. What
// SHOULD be gated is a canon call (DESIGN.md §5); whether a written gate lands is not.

const MOTION_PROPS = ["animation", "transition", "transform"] as const;
type MotionProp = (typeof MOTION_PROPS)[number];

type Rule = {
  decls: Map<MotionProp, string>;
  index: number;
  inReduce: boolean;
  selector: string;
  specificity: [number, number, number];
};

/** (id, class-ish, type) — the sheet uses no ids, but count them so ties stay honest. */
function specificity(selector: string): [number, number, number] {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes =
    selector.match(/(?:\.[\w-]+|:{1,2}[\w-]+(?:\([^)]*\))?|\[[^\]]*\])/g)?.length ?? 0;
  const types = selector.match(/(?:^|[\s>+~])([a-z][\w-]*)/g)?.length ?? 0;
  return [ids, classes, types];
}

function beats(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left > right ? 1 : -1;
    }
  }
  return 0;
}

/** Flatten the sheet to rules in source order, marking which sit under a reduce query. */
function parse(css: string): Rule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const token =
    /@media([^{]*)\{|@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}|([^{}@]+)\{([^{}]*)\}|\}/g;
  let depth = 0;
  let reduceDepth = -1;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(withoutComments)) !== null) {
    const [whole, mediaQuery, selectorList, block] = match;

    if (mediaQuery !== undefined) {
      depth++;
      if (reduceDepth === -1 && /prefers-reduced-motion\s*:\s*reduce/.test(mediaQuery)) {
        reduceDepth = depth;
      }
      continue;
    }
    if (whole === "}") {
      if (reduceDepth === depth) {
        reduceDepth = -1;
      }
      depth--;
      continue;
    }
    if (selectorList === undefined || block === undefined) {
      continue;
    }

    const decls = new Map<MotionProp, string>();
    for (const prop of MOTION_PROPS) {
      const found = block.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
      if (found?.[1] !== undefined) {
        decls.set(prop, found[1].trim());
      }
    }
    if (decls.size === 0) {
      continue;
    }

    for (const selector of selectorList.split(",").map((s) => s.trim())) {
      if (selector.length > 0) {
        rules.push({
          decls,
          inReduce: reduceDepth !== -1,
          index,
          selector,
          specificity: specificity(selector),
        });
        index++;
      }
    }
  }
  return rules;
}

const RULES = parse(STYLES);
const GATES = RULES.filter((rule) => rule.inReduce);
const UNGATED = RULES.filter((rule) => !rule.inReduce);

/** Every (gate, property) pair the reduce blocks declare, as a readable case name. */
const GATE_CASES = GATES.flatMap((gate) => [...gate.decls.keys()].map((prop) => ({ gate, prop })));

describe("/pipeline reduced-motion gates", () => {
  it("declares at least one gate (the parser is pointed at a real sheet)", () => {
    expect(GATE_CASES.length).toBeGreaterThan(0);
  });

  it.each(
    GATE_CASES.map(({ gate, prop }) => [`${gate.selector} { ${prop} }`, gate, prop] as const),
  )("%s wins the cascade over every rule outside the reduce block", (_name, gate, prop) => {
    const targets = UNGATED.filter(
      (rule) => rule.selector === gate.selector && rule.decls.has(prop),
    );

    for (const target of targets) {
      const bySpecificity = beats(gate.specificity, target.specificity);
      const wins = bySpecificity > 0 || (bySpecificity === 0 && gate.index > target.index);
      expect(
        wins,
        `"${gate.selector} { ${prop} }" is overridden by the same selector outside the reduce block — ` +
          `move the gate below it or make it as specific as its target`,
      ).toBe(true);
    }
  });

  // A gate whose selector nothing animates is a typo wearing a rule's clothes — the
  // `.hb` vs `.hb.ok` miss looked exactly like this. `transform` is exempt: a reduce
  // block legitimately zeroes a transform that only ever came from a @keyframes.
  it.each(
    GATE_CASES.filter(({ prop }) => prop !== "transform").map(
      ({ gate, prop }) => [`${gate.selector} { ${prop} }`, gate, prop] as const,
    ),
  )("%s neutralizes a rule that actually exists", (_name, gate, prop) => {
    const targets = UNGATED.filter(
      (rule) => rule.selector === gate.selector && rule.decls.has(prop),
    );
    expect(
      targets.length,
      `nothing outside the reduce block sets "${prop}" on "${gate.selector}" — ` +
        `the gate names a selector the sheet never animates`,
    ).toBeGreaterThan(0);
  });
});
