#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const templatePath = join(webRoot, ".dev.vars.tpl");
const outputPath = join(webRoot, ".dev.vars");
const account = process.env.FLUNCLE_1PASSWORD_ACCOUNT?.trim();
const item = process.env.FLUNCLE_1PASSWORD_ENV_ITEM?.trim();

if (!account) {
  console.error(
    "Missing FLUNCLE_1PASSWORD_ACCOUNT. Add it to your shell startup file, then retry.",
  );
  process.exit(1);
}

if (!item) {
  console.error(
    "Missing FLUNCLE_1PASSWORD_ENV_ITEM. Add the Fluncle local-dev 1Password item path to your shell startup file, then retry.",
  );
  process.exit(1);
}

if (!existsSync(templatePath)) {
  console.error(`Missing ${templatePath}.`);
  process.exit(1);
}

const template = readFileSync(templatePath, "utf8");
const missingReferenceVariables = new Set<string>();
const expandReference = (reference: string): string =>
  reference.replace(/\$([A-Z0-9_]+)/g, (match, name: string) => {
    const value = process.env[name]?.trim();

    if (!value) {
      missingReferenceVariables.add(name);

      return match;
    }

    return value;
  });
const references = [
  ...new Set(
    template
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const equals = line.indexOf("=");

        if (equals === -1) {
          return "";
        }

        return line.slice(equals + 1).trim();
      })
      .filter((value) => value.startsWith("op://")),
  ),
];
const expandedReferences = references.map(expandReference);
const missingReferences: string[] = [];
let authError: string | undefined;

if (missingReferenceVariables.size > 0) {
  console.error(
    `Missing environment variable(s) used in ${relative(process.cwd(), templatePath)}:`,
  );

  for (const name of [...missingReferenceVariables].sort()) {
    console.error(`- ${name}`);
  }

  process.exit(1);
}

for (const reference of expandedReferences) {
  const check = spawnSync("op", ["--account", account, "read", reference], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });

  if (check.status !== 0) {
    const stderr = check.stderr.toString().trim();

    if (stderr.includes("error initializing client")) {
      authError = stderr;
      break;
    }

    missingReferences.push(reference);
  }
}

if (authError) {
  console.error(authError);
  process.exit(1);
}

if (missingReferences.length > 0) {
  console.error(
    `Missing 1Password field reference(s) from ${relative(process.cwd(), templatePath)}:`,
  );

  for (const reference of missingReferences) {
    console.error(`- ${reference}`);
  }

  process.exit(1);
}

const result = spawnSync(
  "op",
  ["--account", account, "inject", "--force", "--in-file", templatePath, "--out-file", outputPath],
  {
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`Failed to run op: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
