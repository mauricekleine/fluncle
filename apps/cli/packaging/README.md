# Fluncle CLI distribution

The one CLI source (`apps/cli/src/cli.ts`) ships three ways:

| Channel                                                 | Artifact                                                | How it's built                                                    |
| ------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| `curl ... \| sh` installer + GitHub Release             | Bun `--compile` binaries (`fluncle-<os>-<arch>`, ~64MB) | `bun run build:release` (CI: `.github/workflows/cli-release.yml`) |
| Homebrew                                                | the same GitHub Release binaries                        | the formula here pulls them                                       |
| npm (`npm i -g fluncle`, `npx fluncle`, `bunx fluncle`) | a self-contained node-targeted JS bundle (~210KB)       | `bun run build:npm` → `apps/cli/dist-npm/`                        |

The Bun binaries and the npm bundle come from the exact same `cli.ts`. The npm
build is `bun build --target=node` (commander + dotenv inlined, only node builtins
imported — zero runtime deps), with the Bun shebang rewritten to `node`.

## npm package `fluncle` (gated: do not publish without Maurice)

The workspace package stays the private `@fluncle/cli`. The public, unscoped
`fluncle` package is emitted to a throwaway `dist-npm/` with its own generated
`package.json` (`name: "fluncle"`, `bin.fluncle`, `publishConfig.access: public`),
so the two never collide and the workspace is untouched.

Build + publish:

```sh
# version comes from FLUNCLE_CLI_VERSION, else apps/cli/package.json version
FLUNCLE_CLI_VERSION=0.2.0 bun run --cwd apps/cli build:npm

# inspect the tarball first (3 files: bin/fluncle.mjs, package.json, README.md)
cd apps/cli/dist-npm && npm pack --dry-run

# publish — Maurice's local `npm login` (npmjs.com) auth is sufficient.
# publishConfig already sets access:public, so no --access flag is needed.
cd apps/cli/dist-npm && npm publish
```

The name `fluncle` is currently unclaimed; the first `npm publish` registers it.

> Caveat — the file-upload subcommands (`track`/`mixtape` uploads, `preview`
> archive) and `open` use Bun-only APIs (`Bun.file`, `Bun.spawn`). They are
> unreachable from the thin-client commands and only error if invoked under
> node; the npm README points heavy users at the Bun binary / Homebrew.

## Homebrew tap `mauricekleine/homebrew-fluncle` (gated: Maurice seeds the repo)

`homebrew/fluncle.rb` here is canonical. It installs the prebuilt release
binaries (no compile), so a tap user runs:

```sh
brew tap mauricekleine/fluncle
brew install fluncle
```

### Seeding the tap repo (one-time)

1. Create an empty public GitHub repo named **`homebrew-fluncle`** under
   `mauricekleine` (the `homebrew-` prefix is what makes `brew tap mauricekleine/fluncle` resolve).
2. Add the formula at `Formula/fluncle.rb`:

   ```sh
   git clone https://github.com/mauricekleine/homebrew-fluncle.git
   mkdir -p homebrew-fluncle/Formula
   cp apps/cli/packaging/homebrew/fluncle.rb homebrew-fluncle/Formula/fluncle.rb
   ```

3. Fill in the four `sha256` placeholders for the current release `vX.Y.Z`:

   ```sh
   for asset in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
     printf '%s ' "$asset"
     curl -fsSL "https://github.com/mauricekleine/fluncle/releases/download/vX.Y.Z/fluncle-$asset" \
       | shasum -a 256 | cut -d' ' -f1
   done
   ```

   Paste each checksum into the matching `sha256` line and set `version "X.Y.Z"`.

4. Commit and push.

### Bumping on each release

Re-run the checksum loop above for the new tag and update `version` + the four
`sha256` lines, or use `brew bump-formula-pr --version=X.Y.Z mauricekleine/fluncle/fluncle`.

> Future automation: the `CLI Release` workflow could append a job that copies
> this formula into the tap repo with checksums filled and pushes it. Left manual
> for now (the tap repo doesn't exist yet, and the push is a gated external effect).
