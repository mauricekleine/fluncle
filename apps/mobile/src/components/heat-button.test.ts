declare const Bun: { file(path: string | URL): { text(): Promise<string> } };

const source = await Bun.file(new URL("./heat-button.tsx", import.meta.url)).text();

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const pressableTag = (() => {
  const start = source.indexOf("<Pressable");
  assertEqual(start >= 0, true, "component renders a <Pressable>");
  const end = source.indexOf(">", start);
  return source.slice(start, end);
})();

assertEqual(source.includes('accessibilityRole="button"'), true, "role is button");

assertEqual(
  /accessibilityState=\{\{\s*disabled:/.test(source),
  true,
  "accessibilityState carries disabled",
);
assertEqual(/disabled\s*\?\s*styles\.disabled/.test(source), true, "disabled applies a dim style");

assertEqual(/\bstyle\s*=/.test(pressableTag), false, "Pressable has no style prop (the bug)");

assertEqual(source.includes("StyleSheet.create"), true, "styles come from StyleSheet.create");
assertEqual(/<View\b[\s\S]*?styles\.base/.test(source), true, "the inner View owns styles.base");

assertEqual(source.includes("color.tapeBlackFill"), true, "outline uses the tape-black fill");
assertEqual(source.includes('"transparent"'), false, "outline no longer uses transparent");

assertEqual(source.includes("minHeight: 44"), true, "container floors a 44pt touch target");

assertEqual(/icon\s*\?\s*</.test(source), true, "renders the optional icon slot");
