---
name: fluncle-box-restore
description: >-
  Rebuild or restore Fluncle's rave-02 agent box (the Hermes/devbox host running every automation sweep) after it is lost, and prove ahead of time that it could be. USE THIS whenever the box is gone, dead, deleted, wiped, unreachable, or being replaced: "rave-02 is gone", "the box died", "rebuild the box", "restore the agent box", "the devbox is dead", "provision a replacement box", "restore the box-state backup", "the crons all stopped and the box is unreachable", "disaster recovery". USE IT EQUALLY for the preventive "could we actually restore the box if we had to?" / "drill the restore", which its read-only preflight answers in one safe command. It is the ordered runbook — provision → harden → op → bootstrap token → secret templates → host timers → image → restore box state → verify — plus the ordering traps that cost hours. NOT for changing a live box (model, voice, pins, crons): that is fluncle-hermes-operator. NOT generic Hetzner VPS profiles: that is hetzner-devbox, which this skill calls and sequences.
---

# Fluncle box restore — putting rave-02 back

rave-02 is the box every Fluncle automation runs on: the Hermes chat gateway plus ~44 host systemd timers driving the `--no-agent` sweeps. This skill is the one entry point for **resurrecting it**, and for answering the cheaper question — _could we?_ — before you ever need to.

Everything the rebuild needs already exists. The problem this skill solves is that it exists in six places across two repos, and nothing used to route you to them. **Do not reconstruct any of it from source.** Each step below names the asset that does the work; follow the link, run the thing, come back.

**Neighbours, so the right skill wins:** [`fluncle-hermes-operator`](../fluncle-hermes-operator) changes a box that is still alive (model, voice, pins, secrets, crons). [`hetzner-devbox`](../hetzner-devbox) is the generic VPS provisioning kit. This skill is the box being **gone**, and it drives both of those in order.

## Read this first — the two halves

The repo is canonical and the box is a deploy target, so most of rave-02 is **derived**, not accumulated: the sweep code bakes into the image from `main`, the schedule is checked-in systemd units, and the secrets re-inject from 1Password. That is why a rebuild is possible at all.

The other half is **not** in this repo and cannot be: the box facts, the topology, and the two `op://` secret templates that map every environment variable to its vault item. Those live in the private companion repo `fluncle-labs`, at **`docs/rave-02/README.md`** — the required companion read for this whole procedure.

> **Without labs access, stop at step 3 and ask the operator.** You can create and harden a server, but you cannot place the bootstrap token or the secret templates, and a box that boots without them goes green on `/status` while every sweep runs credential-less. Do not guess a vault path, do not reconstruct a template from the sweep sources, and do not copy anything out of labs into this repo — the boundary is deliberate.

## Before the fire: could we restore right now?

Run this on any quiet day. It is **read-only** — LIST, HEAD, one GET of a plaintext manifest, and `op inject` rendered to a discarded stream. It writes nothing, uploads nothing, prunes nothing.

```bash
bun packages/skills/fluncle-box-restore/scripts/preflight.ts
bun packages/skills/fluncle-box-restore/scripts/preflight.ts --json          # machine-readable
bun packages/skills/fluncle-box-restore/scripts/preflight.ts --drill         # + the full restore drill
```

It answers seven questions: are the runbook's assets still in the repo; does the schedule still lay down (including the secrets timer); is the box-state encryption key present and 32 bytes; is there a recent box-state artifact whose manifest parses and whose sealed object matches the recorded size; is there a recent database dump; are both secret templates present holding only `op://` pointers; and does every one of those references still resolve.

**Its `unknown` is not a pass.** A check it cannot run — no bucket credentials, no `op`, no labs checkout — reports "could not verify" and the run exits **2**, distinct from a clean **0** and a failing **1**. Each non-passing check prints what to do about it. Env it reads (never prints): `FLUNCLE_BOXSTATE_KEY`, `R2_ACCOUNT_ID`, `FLUNCLE_BACKUP_R2_ACCESS_KEY_ID`, `FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY`, plus `FLUNCLE_LABS_DIR` or `--labs <dir>` for the companion checkout.

`--drill` runs [`box-state-restore-drill.ts`](../../../docs/agents/hermes/scripts/box-state-restore-drill.ts) for real: fetch, verify against the manifest, decrypt, prove the tamper-detection bites, unpack, confirm the load-bearing set came back. Slower, still read-only, and the only thing that turns a believed backup into a proven one.

## Is the box actually gone?

Do not rebuild a box that is merely unreachable — a re-provision throws away accumulated state a reboot would have kept.

- **Every `/status` cron row stale but the web app fine** → the box, not Fluncle. Likely the whole host.
- **You cannot SSH in and never could since a given date** → suspect Tailscale node-key expiry before suspecting death. There is no public inbound TCP, so an expired key locks you out completely with the box still running perfectly. Re-authenticate the node from the admin console.
- **Provider console says the server is running** → it is a reachability problem. Fix that.
- **The server is gone from the provider, or the disk is lost** → this runbook.

## The rebuild, in order

The order is load-bearing. Each step names the asset that does the work.

**1. Create the server.** [`create-server.sh`](../hetzner-devbox/scripts/create-server.sh), after [`check-prereqs.sh`](../hetzner-devbox/scripts/check-prereqs.sh). Size, image, and firewall name are box facts — read them from the labs doc, do not re-derive them.

**2. Harden the host.** [`bootstrap-hardening.sh`](../hetzner-devbox/scripts/bootstrap-hardening.sh), which streams [`bootstrap-private-vps.sh`](../hetzner-devbox/scripts/bootstrap-private-vps.sh): admin user, sshd off :22, ufw, Docker, Tailscale, **and `op`**. Then [`apply-firewall.sh`](../hetzner-devbox/scripts/apply-firewall.sh) for the provider layer.

**3. Disable Tailscale node-key expiry — before you trust the box.** Then open a **second** terminal and confirm you can still get in, while the first is still connected. See the gotchas.

**4. Install the toolchain, container-only.** [`install-toolchain.sh`](../hetzner-devbox/scripts/install-toolchain.sh) with `TOOLCHAIN_PROFILE=agent-box`. The default `devbox` profile puts a full workstation on a host whose only job is running containers — a materially wider blast radius than the architecture describes.

**5. Place the bootstrap env.** `op inject` cannot fetch its own credential, so this one file is the irreducible manual link. The recipe (reading the token with the operator's own biometric session and piping it over SSH, never typing it) and the file's contents are in the labs doc. **`op` must already be installed** — step 2 does that.

**6. Place both secret templates** from the labs doc into the box's template dir. They are the box's entire secret map: which vault item feeds which variable.

**7. Install the host units.** From a repo checkout on the box: `sudo bash docs/agents/hermes/install-host-timers.sh`. It [derives](../../../docs/agents/hermes/install-host-timers.sh) its own work — every directory holding a unit, every host script an `ExecStart` names — and refuses to install rather than exit 0 having silently skipped something. It orders the secrets sync first and gives it one immediate run. Preview anywhere with `--dry-run`.

**8. Build and run the container.** First build is manual, from the **repo root**, `-f docs/agents/hermes/Dockerfile` — see [`hermes-agent.md` § The image / § Run](../../../docs/agents/hermes-agent.md) for the build and the canonical `docker run` flags; the concrete env-file path is in the labs doc.

**9. Re-run the secrets sync.** Yes, again. See the gotchas — this is the step people skip.

**10. Restore the box state** into the **stopped** container, then start it. Procedure: [`backup-timer/README.md` § Restoring from leg 2](../../../docs/agents/hermes/backup-timer/README.md). Drill it first with `preflight.ts --drill` so you are unpacking something you have already proven opens.

**11. Re-place what no backup covers** (below), then verify (below).

Self-deploy resumes on its own once the box is up: [`pin-watch`](../../../docs/agents/hermes/pin-watch) rebuilds the image from `main` hourly. It **cannot bootstrap** — see the gotchas.

## The gotchas

Each of these has bitten. They are the reason this skill is a runbook and not a list of links.

- **Container before sweep env, then sync again.** The secrets sync writes the sweep env file _into the container's bind mount_, which does not exist until the container has started once. On a fresh box the first sync half-succeeds: the gateway env lands, the sweep env does not, and every sweep runs credential-less. Sequence is **bootstrap → sync → container → sync again**.
- **Restore box state into a STOPPED container.** `state.db` is live SQLite; unpacking over a running gateway corrupts it. Untar with `tar` (not a copy tool that drops modes) — it preserves the `0600` on the restored env files, and that is load-bearing.
- **Tailscale key expiry, before anything else.** No public inbound TCP means an expired node key is a total lockout with no fallback path. Disable expiry (or join the node tag-owned so it is exempt), then verify from a second terminal _before closing the first_. Getting this wrong costs you the box you just built.
- **`op` before any secret is read.** Historically nothing installed it, so the secret layer's very first action was `command not found` — silently, with every job then running credential-less. The private bootstrap installs it now; confirm `op --version` answers before step 5.
- **pin-watch cannot bootstrap itself.** It is steady-state only: it harvests the runtime env off the _running_ container via `docker inspect` and reads nothing from `op`. With no container there is nothing to harvest. The first image build and `docker run` are manual, every time.
- **A green `/status` row is not proof.** A probe reporting "not configured" and a cron marker written by a killed run both used to read healthy. Verify for the right reason (below).

## What is NOT in any backup

The nightly [`fluncle-backup`](../../../docs/agents/hermes/backup-timer/README.md) has two legs: the production database, and the box's own state. Neither covers **hand-placed files that no sync writes**. With no attached volumes and no provider snapshots, those die with the root disk and must be re-placed by hand:

- the `/status` prober's target env (the `HEALTHCHECK_*` values) — hand-placed, in no sync
- the render box's SSH key — its only other copy is on the operator's Mac
- the gateway's own dotenv (the Discord home-channel and thread bindings)

The durable fix for each is to fold it into the `op` sync as another template rather than to re-place it by hand next time; the labs doc tracks these as open operator items. Everything else the box accumulates — gateway state db, memories, kanban, cron markers, the render conductor's `box-id` and poison ledger — **is** in leg 2, provided the encryption key was provisioned. With no key, leg 2 skips silently and uploads nothing; `preflight.ts` fails loudly on exactly that.

The big git checkouts (audit and triage workspaces) are deliberately excluded — `git clone` restores them exactly, and including them would turn a few-MB nightly into a 5 GB one.

## Verification — how you know it worked

Not "it should be fine". Concretely, in this order:

1. **Timers.** `systemctl list-timers 'fluncle-*' 'pin-watch*'` — the live count matches what `install-host-timers.sh --dry-run` planned from the repo. A missing timer is a missing sweep, not a rounding error.
2. **Secrets rendered.** Both env files exist at `0600`, and the sweep env's key count matches the template's. `preflight.ts` reports that count; a short render means `op inject` partially failed.
3. **One sweep, by hand, before trusting the schedule.** `sudo systemctl start fluncle-<job>.service`, then `journalctl -u fluncle-<job>.service` — expect the sweep's JSON summary line with `ok: true`, and a fresh marker under the cron-output dir.
4. **`/status` green for the right reason.** A row that is green because its probe is unconfigured is not success. Cross-check a green row against a real artifact — a fresh marker file, a backup object that landed today.
5. **The role boundary intact.** An agent-token read returns `{ok:true}` and a publish-class command comes back **403**. That is [`hermes-agent.md` § Verify](../../../docs/agents/hermes-agent.md); the pre-smoke in `pin-watch` runs the same pair, so a rebuilt box that passes it is a box whose credential is correctly scoped.
6. **The backup loop closed.** Run `preflight.ts` again against the rebuilt box. All seven checks passing is the definition of done, because it means the next rebuild is possible too.

Two timers ship operator-gated on a genuinely new box (the embed sweep wants a peak-RAM validation, the capture sweep wants its bucket) — `install-host-timers.sh` assumes a previously-validated box and starts everything. On a first-ever provision, read those two timer READMEs before trusting them.
