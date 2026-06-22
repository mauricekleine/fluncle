# VPS Deployment

The VPS does not need the source checkout. Deploy a standalone Linux binary and a locked-down config file containing only API settings.

## Build

For x64 Linux:

```bash
bun run --cwd apps/cli build:vps
```

For ARM64 Linux:

```bash
bun build ./apps/cli/src/cli.ts --compile --target=bun-linux-arm64 --outfile ./apps/cli/dist/fluncle
```

## Copy

Replace `<host>` with the SSH target:

```bash
scp ./apps/cli/dist/fluncle ./fluncle.env <host>:/tmp/
```

## Install On Server

```bash
mkdir -p ~/.config/fluncle
install -m 600 /tmp/fluncle.env ~/.config/fluncle/.env.production
sudo install -m 755 /tmp/fluncle /usr/local/bin/fluncle
rm -f /tmp/fluncle /tmp/fluncle.env
```

The config file should contain:

```text
FLUNCLE_API_BASE_URL=https://www.fluncle.com
FLUNCLE_API_TOKEN=<admin token>
```

## Verify

```bash
fluncle --help
fluncle recent --limit 1 --json
```

For this project’s known VPS, previous deployments used:

```bash
ssh admin@<host> 'fluncle recent --limit 1 --json'
```

Only use a host-specific SSH command when the user asks for that deployment target.
