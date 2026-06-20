#!/usr/bin/env bun

// Build the publishable npm package `fluncle` from the one CLI source.
//
// The npm artifact is a single, self-contained node-targeted JS bundle (KB-scale,
// not the ~60MB Bun --compile binary) so `npm i -g fluncle`, `npx fluncle <cmd>`,
// and `bunx fluncle <cmd>` all run instantly. commander + dotenv are inlined; the
// bundle imports only node builtins, so the published package declares no runtime
// dependencies.
//
// Bun keeps the source's `#!/usr/bin/env bun` shebang at byte 0; we rewrite it to
// `node` (its --banner flag cannot guarantee position 0, which breaks ESM parsing).

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

  const built = await result.outputs[0]!.text();
  // Force a node shebang at byte 0 so the bin is directly executable under node.
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

  const pkg = require(join(cliRoot, "package.json")) as { version?: string };

  return pkg.version ?? "0.1.0";
}

function buildPackageJson(): Record<string, unknown> {
  return {
    bin: { fluncle: "./bin/fluncle.mjs" },
    bugs: { url: "https://github.com/mauricekleine/fluncle/issues" },
    description: "drum & bass bangers from another dimension — the Fluncle CLI",
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

drum & bass bangers from another dimension — the Fluncle CLI.

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
