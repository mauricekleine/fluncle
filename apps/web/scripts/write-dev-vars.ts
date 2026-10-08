import { parse } from "dotenv";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

if (process.platform === "linux") {
  throw new Error("Linux development uses process-only secrets through db:secrets.");
}

const variables = parse(readFileSync(".dev.vars.tpl"));
const lines = Object.keys(variables).map((key) => {
  const value = process.env[key];

  if (value === undefined || value.startsWith("op://")) {
    throw new Error(`Unresolved local-dev variable: ${key}`);
  }

  return `${key}=${JSON.stringify(value)}`;
});

writeFileSync(".dev.vars", `${lines.join("\n")}\n`, { mode: 0o600 });
chmodSync(".dev.vars", 0o600);
console.log("Wrote local-dev variables to .dev.vars.");
