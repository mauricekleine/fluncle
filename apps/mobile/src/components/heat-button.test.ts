// Structural checks for HeatButton — no framework, mirroring the repo's RN-free test
// style (src/lib/submit-fault.test.ts). Run via `bun test` (reports "0 pass" — no
// describe/it blocks — but throws and fails the process on any failed assertion) or
// `bun src/components/heat-button.test.ts`.
//
// WHY structural (source-text) rather than a render: this app's tests are deliberately
// React-Native-free because `react-native` cannot be imported under `bun test` (it ships
// Flow types bun won't parse). So we read the component's SOURCE and pin its shape. This
// is exactly the right shape to pin here — the P0 bug was a *structural* one: a Pressable
// style FUNCTION drops its output under NativeWind 4.2.5, so every primary action rendered
// as bare text. The regression pin is: the container styling must live on the inner View,
// never on a Pressable `style` prop.

// Bun's file reader — declared locally so the Expo (no-node, no bun-types) tsconfig still
// typechecks this file under tsgo.
declare const Bun: { file(path: string | URL): { text(): Promise<string> } };

const source = await Bun.file(new URL("./heat-button.tsx", import.meta.url)).text();

// A tiny strict-equality assertion (see submit-fault.test.ts): framework- and
// dependency-free, still throws (and fails the `bun test` process) on a mismatch.
function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// The Pressable's opening tag: from `<Pressable` up to the `>` that closes the tag
// (before the children-as-function `{({ pressed }) => …`). Its attributes never contain
// a `>`, so a non-greedy scan to the first `>` is exact.
const pressableTag = (() => {
  const start = source.indexOf("<Pressable");
  assertEqual(start >= 0, true, "component renders a <Pressable>");
  const end = source.indexOf(">", start);
  return source.slice(start, end);
})();

// 1. accessibilityRole="button" is present (screen readers announce it as a button).
assertEqual(source.includes('accessibilityRole="button"'), true, "role is button");

// 2. The disabled state is wired through to assistive tech (accessibilityState.disabled)
//    and to a real dimming style, so a disabled button both reads and renders as disabled.
assertEqual(
  /accessibilityState=\{\{\s*disabled:/.test(source),
  true,
  "accessibilityState carries disabled",
);
assertEqual(/disabled\s*\?\s*styles\.disabled/.test(source), true, "disabled applies a dim style");

// 3. THE REGRESSION PIN: the Pressable carries NO `style` prop — all visual/layout styling
//    must live on the inner View (a Pressable style function drops under NativeWind 4.2.5).
assertEqual(/\bstyle\s*=/.test(pressableTag), false, "Pressable has no style prop (the bug)");

// 4. …and the container styling lives on a plain inner View backed by StyleSheet.create.
assertEqual(source.includes("StyleSheet.create"), true, "styles come from StyleSheet.create");
assertEqual(/<View\b[\s\S]*?styles\.base/.test(source), true, "the inner View owns styles.base");

// 5. The Outline variant fills with the canon translucent Tape Black (30%) token, not a
//    bare transparent (which failed WCAG 1.4.11's 3:1 component-boundary floor).
assertEqual(source.includes("color.tapeBlackFill"), true, "outline uses the tape-black fill");
assertEqual(source.includes('"transparent"'), false, "outline no longer uses transparent");

// 6. A real 44pt touch target floor.
assertEqual(source.includes("minHeight: 44"), true, "container floors a 44pt touch target");

// 7. The optional leading-icon slot is rendered before the label, icon-library-free.
assertEqual(/icon\s*\?\s*</.test(source), true, "renders the optional icon slot");
