# VPS Deployment

The VPS does not need the source checkout. Deploy a standalone Linux binary and a locked-down config file.

## Build

For x64 Linux:

```bash
bun build ./src/cli.ts --compile --target=bun-linux-x64-baseline --outfile ./dist/fluncle
```

For ARM64 Linux:

```bash
bun build ./src/cli.ts --compile --target=bun-linux-arm64 --outfile ./dist/fluncle
```

## Copy

Replace `<host>` with the SSH target:

```bash
scp ./dist/fluncle ./.env.local <host>:/tmp/
```

## Install On Server

```bash
mkdir -p ~/.config/fluncle
install -m 600 /tmp/.env.local ~/.config/fluncle/.env.local
sudo install -m 755 /tmp/fluncle /usr/local/bin/fluncle
rm -f /tmp/fluncle /tmp/.env.local
```

## Verify

```bash
fluncle --help
fluncle recent --limit 1 --json
```

For this project’s known VPS, previous deployments used:

```bash
ssh admin@spinup-devbox-01 'fluncle recent --limit 1 --json'
```

Only use a host-specific SSH command when the user asks for that deployment target.
