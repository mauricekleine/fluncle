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
# The version MUST be passed (build:npm errors without it) so a manual publish
# can't ship a stale version. Use the latest from
# github.com/mauricekleine/fluncle/releases. (CI passes it automatically.)
FLUNCLE_CLI_VERSION=0.33.0 bun run --cwd apps/cli build:npm

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

### Bumping on each release — automated

The `CLI Release` workflow (`.github/workflows/cli-release.yml`) now does this on
every release: it computes the four binary checksums, fills `version` + the
`sha256` lines from this canonical formula, and pushes `Formula/fluncle.rb` to the
tap repo — at the **same version** as the GitHub Release and the npm publish. No
manual bumping; this formula stays the canonical template (placeholders filled per
release), so edit it here.

## One-time setup to turn on npm + Homebrew

The workflow ships all three channels at the release version, but the npm + tap
steps **skip until their secret exists** (so the existing GitHub Release keeps
working unchanged). To enable them:

- **npm**: add an `NPM_TOKEN` repo secret (an npm automation token; the account
  owns the unclaimed `fluncle` name).
- **Homebrew**: create the empty public `mauricekleine/homebrew-fluncle` repo and
  add a `HOMEBREW_TAP_TOKEN` repo secret (a PAT with contents:write on it). The
  workflow creates `Formula/fluncle.rb` on the first release.

Once both are set, the next CLI release (an `apps/cli/**` change merged to `main`)
publishes `fluncle@<version>` to npm and bumps the tap to match the GitHub Release.
