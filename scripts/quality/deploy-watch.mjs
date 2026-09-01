#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { cloudflareExcludePatterns, triggersWorkerBuild } from "./classifier.mjs";

function normalized(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

const [operation = "print-cloudflare", ...args] = process.argv.slice(2);

try {
  const expected = normalized(cloudflareExcludePatterns());
  if (operation === "print-cloudflare" || operation === "print") {
    process.stdout.write(`${expected.join("\n")}\n`);
  } else if (operation === "verify") {
    const actualPath = args[0];
    if (!actualPath) {
      throw new Error("verify requires a file containing the live exclusions");
    }
    const raw = readFileSync(actualPath, "utf8").trim();
    const parsed = raw.startsWith("[") ? JSON.parse(raw) : raw.split(/\r?\n/);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error("live exclusion input must be a JSON string array or one pattern per line");
    }
    const actual = normalized(parsed);
    const missing = expected.filter((pattern) => !actual.includes(pattern));
    const extra = actual.filter((pattern) => !expected.includes(pattern));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `watch-path drift: missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`,
      );
    }
    process.stdout.write(
      `Cloudflare watch paths match all ${expected.length} canonical exclusions.\n`,
    );
  } else if (operation === "classify") {
    if (args.length === 0) {
      throw new Error("classify requires at least one repository path");
    }
    process.stdout.write(
      `${JSON.stringify({ deploy: args.some(triggersWorkerBuild), paths: args })}\n`,
    );
  } else {
    throw new Error(`Unknown operation: ${operation}`);
  }
} catch (error) {
  process.stderr.write(
    `deploy watch paths: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
