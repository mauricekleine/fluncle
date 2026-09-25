#!/usr/bin/env bun

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(cliRoot, "src/cli.ts");
const outDir = join(cliRoot, "dist-npm");
const binDir = join(outDir, "bin");
const bundlePath = join(binDir, "fluncle.mjs");

const version = readVersion();

async function main(): Promise<void> {
  await rm(outDir, { force: true, recursive: true });
  await mkdir(binDir, { recursive: true });

  const result = await Bun.build({
    define: { FLUNCLE_CLI_VERSION: JSON.stringify(version) },
    entrypoints: [entry],
    format: "esm",
    minify: false,
    target: "node",
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("npm bundle build failed");
  }

  const built = await result.outputs[0].text();

  const withNodeShebang = built.replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n");
  const final = withNodeShebang.startsWith("#!")
    ? withNodeShebang
    : `#!/usr/bin/env node\n${withNodeShebang}`;

  await writeFile(bundlePath, final, { mode: 0o755 });
  await writeFile(join(outDir, "package.json"), `${JSON.stringify(buildPackageJson(), null, 2)}\n`);
  await writeFile(join(outDir, "README.md"), buildReadme());

  console.log(`Built fluncle npm package v${version}`);
  console.log(`  bundle: ${bundlePath}`);
  console.log(`  publish dir: ${outDir}`);
}

function readVersion(): string {
  const fromEnv = process.env.FLUNCLE_CLI_VERSION?.trim();

  if (fromEnv) {
    return fromEnv;
  }

  throw new Error(
    "FLUNCLE_CLI_VERSION is required (e.g. FLUNCLE_CLI_VERSION=0.33.0). The cli-release workflow sets it from the release tag.",
  );
}

function buildPackageJson(): Record<string, unknown> {
  return {
    bin: { fluncle: "./bin/fluncle.mjs" },
    bugs: { url: "https://github.com/mauricekleine/fluncle/issues" },

    description: "Drum & bass bangers from another dimension: the Fluncle CLI",
    engines: { node: ">=18" },
    files: ["bin/fluncle.mjs", "README.md"],
    homepage: "https://www.fluncle.com",
    keywords: ["fluncle", "drum-and-bass", "dnb", "music", "cli"],
    license: "Apache-2.0",
    name: "fluncle",
    publishConfig: { access: "public" },
    repository: { type: "git", url: "git+https://github.com/mauricekleine/fluncle.git" },
    type: "module",
    version,
  };
}

function buildReadme(): string {
  return `# fluncle

Drum & bass bangers from another dimension: the Fluncle CLI.

\`\`\`sh
npx fluncle recent
bunx fluncle recent
npm i -g fluncle && fluncle recent
\`\`\`

A thin HTTP client for the Fluncle archive. See https://www.fluncle.com.

> File-upload and \`open\` subcommands (track/mixtape uploads) rely on the Bun
> runtime. For those, install the standalone binary via
> \`curl -fsSL https://www.fluncle.com/cli/latest.sh | sh\` or Homebrew
> (\`brew install mauricekleine/fluncle/fluncle\`). The thin-client commands
> (\`recent\`, \`random\`, \`search\`, \`add\`, \`about\`, \`version\`) run anywhere.
`;
}

await main();
