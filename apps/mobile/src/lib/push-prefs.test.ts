import { DEFAULT_PUSH_PREFS, deserialize, mutedCategories, serialize } from "@/lib/push-prefs";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(DEFAULT_PUSH_PREFS.findings, true, "findings default on");
assertEqual(DEFAULT_PUSH_PREFS.mixtapes, true, "mixtapes default on");
assertEqual(mutedCategories(DEFAULT_PUSH_PREFS).length, 0, "both on → nothing muted");

assertEqual(
  mutedCategories({ findings: false, mixtapes: true }).join(","),
  "findings",
  "findings off → findings muted",
);
assertEqual(
  mutedCategories({ findings: true, mixtapes: false }).join(","),
  "mixtapes",
  "mixtapes off → mixtapes muted",
);
assertEqual(
  mutedCategories({ findings: false, mixtapes: false }).join(","),
  "findings,mixtapes",
  "both off → both muted, in stable order",
);

const prefs = { findings: false, mixtapes: true };
const back = deserialize(serialize(prefs));
assertEqual(back.findings, false, "findings survives the round trip");
assertEqual(back.mixtapes, true, "mixtapes survives the round trip");

assertEqual(deserialize(null).findings, true, "null → default on");
assertEqual(deserialize("not json {{{").mixtapes, true, "invalid JSON → default on");
assertEqual(
  deserialize(JSON.stringify({ findings: false })).mixtapes,
  true,
  "missing key → that category defaults on",
);
assertEqual(
  deserialize(JSON.stringify({ findings: false })).findings,
  false,
  "present key is honoured",
);
assertEqual(
  deserialize(JSON.stringify({ findings: "nope" })).findings,
  true,
  "non-boolean key → default on",
);
