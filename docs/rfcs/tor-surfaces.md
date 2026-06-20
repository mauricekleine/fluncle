# RFC: Tor support for Fluncle's surfaces — off the grid, still in the Galaxy

**Status:** Final (research → /taste → 3-role adversarial panel synthesized, 2026-06-20) — completeness standard applied.
**For:** a fresh build session (or Maurice running the gated production steps himself), once the open decisions below are resolved.
**Canon/authority:** the codebase (`apps/web`, `apps/ssh`, `apps/dns`) and `docs/dig.md` arbitrate the deployment shape; `VOICE.md` / `DESIGN.md` / `PRODUCT.md` arbitrate the words. This is planning, not spec.

> Process note: divergent research across three threads (the HTTP onion mirror; SSH-over-Tor + MCP-over-Tor; the Fluncle VPS deployment + voice), a /taste pass, and a 3-role adversarial review (staff engineer, Tor/security specialist, product-scope + design-brand). Their corrections and reframes are baked in — including two P0 security fixes the security reviewer caught (the upstream-cert verification config and the DoS-defense opt-in are NOT free with onionspray; both must be turned on explicitly). Live verifications and sources are in the appendix.

---

## The standard (definition of done)

This RFC describes a complete delivery, not a menu. When it is built:

- **Every Tor box on the checklist is closed** (`docs/public-surfaces-checklist.md` lines 78–84): the onion mirror, API over Tor, RSS over Tor, SSH over Tor, MCP over Tor, and the deep-space-mirror docs. Several are _free riders_ on one shared piece (the web onion carries API, RSS, and MCP) — that is honest scoping, not a cut.
- **Tests + docs are part of done.** A `docs/tor.md` operator runbook (mirroring `docs/dig.md`) ships with the feature; the README Public Surfaces table and `/about` gain the onion; the `Onion-Location` header has a focused test in `apps/web`.
- **The only sanctioned "not now"** is genuine dependency chaining: the onion address must exist before the `Onion-Location` header can point at it, and the key-custody backup must happen before anything else references the address. Those are sequencing, not deferral. (One scope decision — whether the SSH onion ships in v1 or as a fast-follow — is a real, owner-owned choice; see Decisions.)
- **Dangling threads tied off:** the upstream-cert-verification config, the DoS-defense opt-in, key-custody procedure (where the private keys live, and that a _leak_ is as bad as a _loss_), the SSH host-key fingerprint publication (so first-connect TOFU is verifiable), and the Cloudflare-origin bypass are all in scope here, not follow-ups.

A note on altitude, because it shapes the whole RFC: this is a **principled novelty**, not a load-bearing access path. A public drum & bass archive is not censored, so the real utility is mostly symbolic plus a thin censorship-resistance / visitor-metadata-privacy benefit. The RFC is sized accordingly — it recommends the cheap, high-signal half hard, and treats the full mirror as a tasteful flex that rides existing infrastructure at ~$0 marginal cost.

---

## 0. Summary / the reframe

**The unifying simplification: one Tor daemon on the rave VPS, forwarding to local ports — and it opens zero new inbound holes.** Almost everything else falls out of that one fact.

- **One daemon, two onion identities, on the box we already run.** The Hetzner `rave.fluncle.com` VPS already hosts two always-on services beside each other (the Wish SSH terminal on `:22`, the `fluncle-dns` authoritative DNS on `:53` — see `docs/dig.md`). Tor becomes the third. It hosts **two onion addresses**: a _web onion_ (an onionspray rewriting proxy → the live `www.fluncle.com` Cloudflare site) and a _rave onion_ (→ the SSH app already on `:22`). Cloudflare Workers categorically cannot host an onion (no daemon, no listener, no key storage), so the VPS is the only origin in the fleet that can — settled, not a choice.
- **The security inversion that makes this easy: an onion service opens NO inbound public ports.** `fluncle-dns` needed `UDP/53`+`TCP/53` opened at two firewall layers; the SSH app needs public `TCP/22`. Tor needs **nothing opened** — it reaches the network by _outbound_ connections only, and clients arrive through rendezvous points inside Tor. The HTTP proxy binds `127.0.0.1`. So the onion adds a reachable surface with **strictly fewer open ports than any existing surface** — the most counter-intuitive and most reassuring fact in the proposal.
- **API, RSS, and MCP over Tor are free riders, not separate builds.** They are all just paths on `www.fluncle.com` (`/api/v1/*`, `/rss.xml`, `/mcp`). The web onion proxies them like any other path. MCP is especially clean: Fluncle's MCP server is **stateless, JSON-only, POST-only, no SSE** (`apps/web/src/lib/server/mcp.ts`, verified), so the classic "SSE-through-a-reverse-proxy buffering" gotcha simply does not apply today. Five of the six checklist boxes collapse into "stand up the web onion."
- **The cheap, high-signal half ships from the Worker: the `Onion-Location` header.** A Tor Browser desktop user on `www.fluncle.com` gets a purple ".onion available" pill, one click to the mirror. It is one response header — but it touches the response pipeline (the existing seam is homepage-only; see §C.1) and it needs the address to exist first.
- **The two things this is NOT free of (panel corrections, do not skip):** (1) onionspray's upstream fetch from the Hetzner IP to `www.fluncle.com` will likely be **challenged/blocked by Cloudflare's own bot management** unless the origin grants the proxy a trusted bypass — so Unit A _does_ need a Cloudflare change (the RFC's earlier "no dashboard toggle" was wrong for the web onion). (2) onionspray's upstream-cert verification and its DoS defenses are **OFF by default** and must be turned on explicitly — pinning a recent version only makes them _available_.
- **Decomposition (what's truly coupled vs. free):**
  - **Unit A — the web onion.** The one real build. Two sub-problems: **A1** stand up onionspray's rewriting proxy on the VPS, and **A2** make Cloudflare _not block_ the proxy's origin fetch (a WAF/IP bypass). Carries web + API + RSS + MCP. Ships standalone.
  - **Unit B — the rave/SSH onion.** One `torrc` block → the Wish app on `:22`, plus a published host-key fingerprint and a documented client snippet. _Independent_ of A; same daemon, separate identity. **Optional in v1** (it's the thinnest-value unit — see Decisions).
  - **Unit C — the `Onion-Location` header + the docs/surfaces wiring** (`apps/web` + `docs/tor.md` + README/about). _Depends on_ A's address existing (sequencing), otherwise independent. This is the cheap, high-signal half.

---

## 1. Context & goals

**Why now.** The public-surfaces push has reached its long tail; the Tor section is six unchecked boxes (`docs/public-surfaces-checklist.md`). The owner explicitly wants a reference doc because he "has no idea how this works." The Galaxy canon makes the framing natural: an onion is _the same findings, reached off the grid_ — the deepest end of the Depth Gradient, past even the SSH "recovered terminal."

**Goals, honestly calibrated:**

- **In reach, fully:** stand up a self-hosted v3 onion mirror of the web/API/RSS/MCP; (optionally) expose the rave terminal as an onion; advertise it via `Onion-Location`; document it. All buildable with current tooling on the existing box. _This is the deliverable._
- **In reach, thin value:** censorship-resistant reachability (someone on a network that blocks `fluncle.com` or port 22 can still reach the archive) and visitor-metadata privacy (no exit node, no DNS leak, no IP at the origin). Real, but narrow — the archive isn't actually censored.
- **What it is NOT:** not a security feature for _Fluncle_ (the archive is public, read-only, nothing to protect on our side); it will not drive meaningful traffic; it does **not** hide Fluncle's infrastructure (the mirror proxies to the known clearnet origin, so the onion's hosting is trivially co-located with the public site — it protects the _visitor's_ metadata, not the operator's location). And whether anyone uses it is outside our control. The value is principled and on-brand, not operational. We state this plainly rather than oversell it.

**The honest worth-it read (baked in up front so the build is sized right):** the single highest-leverage move is **Unit C's `Onion-Location` header plus Unit A's onionspray mirror on the existing VPS** — low marginal cost, on-brand, industry-standard (BBC, NYT, ProPublica, DuckDuckGo all run onion mirrors exactly this way). Unit B (SSH-over-Tor) and MCP-over-Tor are completeness flexes that cost almost nothing because they ride the same daemon. Nothing here is load-bearing; size the effort to "a tasteful, principled mirror," not "a critical access path."

---

## 2. Unit A — the web onion (the mirror)

### A.1 The decision: an onionspray rewriting proxy on the rave VPS → the live Cloudflare site

An onion service is a long-running `tor` process that forwards inbound onion requests to a backing web server over localhost. The backing server **cannot be the Cloudflare Worker** (no persistent process, no inbound listener, no `HiddenServiceDir`). Two shapes are viable:

- **(a) `tor` → a rewriting reverse proxy → `https://www.fluncle.com`** (the live Worker). A true mirror; always reflects production; nothing about the app is duplicated. **Recommended.**
- **(b) `tor` → a local copy of the app on the VPS.** Avoids proxy fragility but duplicates the entire TanStack Start deploy (build, Turso access, RSS) onto the VPS — a real second surface to keep in sync. **Not recommended** for a dynamic Worker app.

Option (a)'s catch: a naive reverse proxy breaks because the app emits absolute `https://www.fluncle.com/...` URLs in HTML/CSS/JS, redirects to the clearnet host, CSP headers scoped to the clearnet origin, and canonical/OG/`rel` links — all of which would yank a Tor user back onto clearnet or break the load. The proxy must rewrite `www.fluncle.com` → the `.onion` throughout the response body and headers, fix redirects, and send the correct upstream `Host`. **This rewriting is exactly what onionspray automates** — so we do not hand-roll an nginx config.

**The upstream `Host` must be exactly `www.fluncle.com`, and the page must hydrate isomorphically.** The router does a host-based rewrite — `apps/web/src/router.tsx` branches on `url.hostname.startsWith("galaxy.")` and rewrites `/` → `/galaxy` _isomorphically_ (SSR and client hydration must agree, per the comment there: "A server-only rewrite isn't enough"). So onionspray must send `Host: www.fluncle.com` upstream (not the `.onion` host), or SSR and hydration disagree and the page breaks _after_ hydration even when the first byte looks fine. Verify with a driven real browser over the onion **past hydration**, not just `curl | head` (the repo's own hard-won lesson; see Appendix).

### A.2 Make Cloudflare not block the proxy's origin fetch (the sub-problem the earlier draft denied)

onionspray's upstream fetch is a **server-to-server HTTPS request from the Hetzner datacenter IP to your own Cloudflare-fronted origin** — exactly the profile Cloudflare's bot management flags (datacenter IP, no browser fingerprint, traffic collapsed to one source IP). The Fluncle zone already has Cloudflare bot/AI-crawler controls in play (the managed-robots/AI-crawler history). If a managed/JS challenge fires, onionspray fetches the _challenge page_, rewrites it, and every onion visitor sees a Cloudflare challenge they cannot solve (Tor → no stable IP, no JS-challenge cookie). If rate-limiting fires on the single egress IP, all onion traffic collapses.

**Resolve it with a trusted bypass for the proxy's egress:** a Cloudflare WAF skip rule / IP Access Rule allow-listing the Hetzner egress IP, or a secret header the Worker recognizes and exempts. **This is a Cloudflare dashboard / config change** — so Unit A is **not** "no Cloudflare change" (that claim holds only for Unit C's header). Gate it: from the VPS, `curl -sI -H 'Host: www.fluncle.com' https://www.fluncle.com/` must return `200` HTML, **not** a challenge, _before_ standing up the onion.

### A.3 Use onionspray, not EOTK

The well-known tool for this is **EOTK (Enterprise Onion Toolkit)** — an nginx+OpenResty/Lua rewriting proxy. **EOTK is effectively unmaintained**: its last release was "Final release with v2 Onion Support," **18 May 2021**, and the author has publicly said he hasn't had time to maintain it for years. **The Tor Project forked it into [`onionspray`](https://onionservices.torproject.org/apps/web/onionspray/)**, the actively-maintained successor — "compatible with EOTK," adds DoS protections, MetricsPort, circuit-ID logging, and "will be supported as long as C Tor is supported." It is genuinely current: **v1.8.0, released 2026-06-02**, bundling Tor 0.4.9.9. Use the latest release.

onionspray generates the onion keys, the nginx rewriting config, and the `torrc`, and runs the whole stack. The project config (the `.conf`) is the real work of Unit A (see §6.1) — everything else in this RFC is one-config-block precise; this is the one black box, so budget the time there.

### A.4 Verify the upstream cert (P0 — OFF by default, must be turned on)

Pinning onionspray ≥ 1.6.0 makes upstream-HTTPS certificate verification _available_, but **it is OFF by default** (Tor Project Security Advisory 002: not enabled by default because it depends on a trusted CA bundle that varies by upstream). Since Unit A's entire design re-originates clearnet HTTPS to Cloudflare, this is the single most load-bearing config line in the deployment. In the onionspray project config, set:

```
set nginx_proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt
```

then reconfigure and restart. Without it, the proxy does not verify Cloudflare's cert and is open to upstream MITM — exactly the threat this advisory addresses. _Acceptance gate: confirm upstream cert verification is configured, not merely that the version is ≥ 1.6.0._

### A.5 Turn on the DoS defenses (P0 — also OFF by default)

Onion services are a known DoS target via introduction-point flooding. Tor ships layered defenses, **but PoW and intro-DoS are disabled by default in C-Tor and in onionspray** — what 0.4.8.1-alpha+ ships by default is the _compiled-in PoW module_ (the capability), not per-service enablement. You must opt in, per project, via onionspray's directives:

```
set tor_pow_enabled 1
set tor_pow_queue_rate 250
set tor_pow_queue_burst 2500
set tor_intro_dos_defense 1
set tor_intro_dos_rate_per_sec 25
set tor_intro_dos_burst_per_sec 200
```

(These map to C-Tor's `HiddenServicePoWDefensesEnabled` / `HiddenServiceEnableIntroDoSDefense` and rate/burst knobs; tune to taste.) The June-2024 Tor recommendation is to enable both. _Acceptance gate: confirm PoW + intro-DoS are actually enabled in the running config, not assumed._

### A.6 What rides the web onion for free

- **The JSON API** (`/api/v1/*`, and the permanent `/api/*` alias) — origin-relative and absolute-URL content the rewriter handles. Any client pointed at Tor (`torsocks curl`, or `--proxy socks5h://127.0.0.1:9050`) reaches it.
- **RSS** (`/rss.xml`) — a static-ish XML response; trivially proxied.
- **MCP** (`/mcp`) — **the cleanest case.** Fluncle's MCP server is stateless, JSON-only, POST-only, and _rejects GET_ (`apps/web/src/lib/server/mcp.ts`, verified: "We don't offer a server-initiated SSE stream; tools speak over POST only", and a 405 on any non-POST). Each request is one short POST → one short JSON response. No long-lived stream, no `Mcp-Session-Id` affinity, no chunked transfer. It survives any default reverse-proxy/onion config with zero special handling. (Note: the server ignores `Accept` and always returns JSON — it does not content-negotiate; the verify snippet sends both anyway for spec-correctness.)

**The one dormant caveat to record (not act on):** _if_ Fluncle's MCP server ever gains streaming/server notifications (`text/event-stream`), the onion proxy would need `proxy_buffering off`, `proxy_cache off`, `chunked_transfer_encoding off`, and `proxy_read_timeout ≥ 300s`, or buffering breaks SSE. Today it does not stream, so this is a future flag, not a build item — record it in `docs/tor.md`.

### A.7 No TLS cert on the onion itself

A v3 `.onion` address encodes the service's Ed25519 public key together with a checksum and version byte (`pubkey(32) ‖ checksum(2) ‖ version(1)` = 35 bytes → 56 base32 chars; the full address is 62 chars including `.onion`). The connection is therefore **self-authenticating and end-to-end encrypted by Tor itself** — no CA, no DNS, no PKI in the path. A TLS cert is **not required** on the onion: the only reasons to add one are mixed HTTP/HTTPS content (the rewriter prevents this — _contingent on the rewriter being complete, which is the same completeness §A.1/§A.4 depend on_), frameworks that hard-require HTTPS, or the web server and `tor` living on different machines (they're co-located). Serve plain HTTP on the onion. (For the record: if a cert is ever wanted, HARICA issues publicly-trusted **DV certs for `.onion`** cheaply — but we don't need it.)

---

## 3. Unit B — the rave/SSH onion (the terminal, off the grid) — optional in v1

### B.1 A separate onion, on the same daemon

The rave terminal (`ssh rave.fluncle.com`) is a Go Wish/Bubble Tea app on the VPS. Exposing it as an onion is **one `torrc` block** pointing at the local SSH listener:

```
HiddenServiceDir /var/lib/tor/rave_ssh/
HiddenServicePort 22 127.0.0.1:22
```

**Point the onion at `:22`, not `:2222`.** Verified: production binds the _Wish app_ to `:22` (`FLUNCLE_SSH_PORT=22` written into `/etc/fluncle-ssh.env` by the deploy; the unit binds `:22` via `CAP_NET_BIND_SERVICE`), while the bootstrap **moves the admin OpenSSH daemon to `:2222`** (Tailscale-only). So `:2222` is the _admin_ sshd — pointing the onion there would expose the wrong service. The default `127.0.0.1:2222` in `apps/ssh/main.go` is only the local-dev fallback. Verify on the box: `sudo ss -tlpn | grep -E ':22 |:2222 '` and confirm `fluncle-ssh` owns `:22`.

A single onion _can_ carry both port 80 and port 22 (just add `HiddenServicePort` lines under one `HiddenServiceDir`), but a separate address is correct for Fluncle: the web onion (Unit A) proxies the Cloudflare-fronted site while SSH is the rave VPS itself, and a dedicated `rave….onion` reads as "the terminal," matching `ssh rave.fluncle.com`, with independent keys and lifecycle. **Two identities, one daemon.** Read the address: `sudo cat /var/lib/tor/rave_ssh/hostname`.

### B.2 The dual-authentication story (and the one config users must set)

Two independent crypto checks stack, and both are good:

1. **The onion address authenticates the endpoint at the Tor layer.** A v3 `.onion` encodes the service's public key; Tor's rendezvous handshake is mutually authenticated against it. You provably reach _the_ service holding the onion key — no exit node, no DNS, no MITM surface for "is this the right onion."
2. **The SSH host key still authenticates the host process.** Fluncle's persisted `ssh_host_ed25519_key` (`apps/ssh/main.go`, `wish.WithHostKeyPath`) is what pins "this is the rave sshd." First connect shows the usual TOFU fingerprint prompt; thereafter it's pinned in `known_hosts`.

**Publish the rave host-key fingerprint on the clearnet site** so a first-connect user can verify TOFU out-of-band (e.g. on `/about` or in `docs/tor.md`) — in scope here.

**The one client config that is non-negotiable: `VerifyHostKeyDNS=no`.** Without it, OpenSSH tries an SSHFP DNS lookup _before_ invoking `ProxyCommand` — which fails (no DNS for `.onion`) and leaks the lookup. The documented client snippet must include it.

### B.3 What does NOT change over Tor

SSH-over-Tor is a transparent TCP tunnel — Tor carries an opaque byte stream; the SSH protocol and the Wish middleware (which forces the TUI and rejects shell/exec/SFTP via `activeterm` + `routeCommandMiddleware`) are untouched and unaware. One incidental, on-theme effect: the onion forwards from `127.0.0.1`, so GeoIP sees a loopback source, and `countryCodeForSession` returns **`VOID`** (it maps loopback/private/unparseable addresses to `VOID`). **Tor ravers show as `VOID` in the crew counter** — which reads exactly as "an anonymous traveler from nowhere on the map." A feature, not a bug.

### B.4 Latency — usable, just laggier

Tor interactive RTT runs roughly 5× a direct path; onion-to-onion adds a second circuit (~6 hops, low-hundreds-of-ms RTT). For a _browse-and-read_ TUI this is perfectly usable, visibly slower — every `j`/`k` round-trips. The Galaxy mini-game (which round-trips steer/boost keys) will feel the lag most; the rest is fine. The runbook should say so plainly so nobody files "the terminal is slow over Tor" as a bug.

---

## 4. Unit C — Onion-Location, and the surface/doc wiring

### C.1 The `Onion-Location` header (the cheap, high-signal half) — a Worker change

`Onion-Location` is an HTTP response header the **clearnet** site sets to advertise its onion twin. Tor Browser desktop shows a purple ".onion available" pill; clicking reloads onto the onion (it offers a choice, it does not force a redirect). Rules (verified): the value is a valid `http://<onion>.onion<path>` URL; the page setting it must be served over HTTPS (`www.fluncle.com` is); and the page setting it must not itself be an onion. Desktop Tor Browser only (not yet Android).

**The seam — and the decision the builder must NOT have to make.** The existing pipeline in `apps/web/src/server.ts` appends headers only on the homepage:

```ts
return new URL(request.url).pathname === "/" ? appendAgentLinkHeaders(response) : response;
```

`appendAgentLinkHeaders` (`apps/web/src/lib/server/agent-discovery.ts`) re-wraps the immutable Worker response (`new Response(response.body, response)`) and appends headers. **Decision, made here:** the `Onion-Location` pill is most valuable _per-path_ (a Tor user on `/log/<id>` should land on that finding's onion page), and the existing `/`-only branch cannot deliver that. So **do not fold it into the `/`-only branch.** Add a sibling helper `appendOnionLocation(response, url)` that appends `Onion-Location: http://<web-onion>.onion<pathname+search>`, **gated on `response.headers.get("content-type")?.includes("text/html")`**, applied to the `handler.fetch` result for _all_ HTML responses (before, and independent of, the existing `/`-only `Link` append). The HTML gate matters: do not emit `Onion-Location` on `/api/v1/*`, `/rss.xml`, or `/mcp` (JSON/XML), where the pill does nothing and the header is noise. The onion hostname lives as a Worker constant/var.

This ships through the **normal Worker deploy** (Workers Builds on push to `main`). **For Unit C: no DNS record, no Cloudflare dashboard toggle** — an onion has no DNS, and the header is pure code. (Unit A is the part that needs a Cloudflare bypass; see §A.2 — don't conflate them.)

**One interaction to handle in the runbook:** onionspray will _also_ see this `Onion-Location` header on its upstream fetch and could serve the onion an `Onion-Location` pointing at itself. Tor Browser generally ignores `Onion-Location` when already on an onion, but have onionspray strip `Onion-Location` from upstream responses to be clean.

### C.2 Cloudflare's own "Onion Routing" is NOT the answer

Cloudflare has an **"Onion Routing"** toggle (Network tab). It is current and active across plans, but it does **not** give Fluncle a usable, advertisable `.onion`:

- It's an **opportunistic, Cloudflare-operated, shared** onion delivered via an `Alt-Svc` header to Tor Browser. The visible domain stays `www.fluncle.com`; there is **no per-customer vanity address** you can publish or put in `Onion-Location`.
- **No HTTPS on it** (Cloudflare provides no cert for it).
- Its purpose is UX/security for Tor users (skip exit nodes, distinguish humans from bots) — not a brandable onion presence.

Cloudflare has never offered a customer-operated custom `.onion` for your hostname. To have a real `fluncle…onion`, **Fluncle must self-host** (Unit A). The Cloudflare toggle is orthogonal and arguably redundant once we have our own onion + `Onion-Location`; leave it out of scope.

### C.3 The docs and surface wiring

- **`docs/tor.md`** — the operator runbook, mirroring `docs/dig.md`'s structure (install → configure → keys/backup → firewall note → systemd → verify), with the full client snippets for SSH-over-onion and curling the API/MCP onion. The full runbook content is in §6.
- **README Public Surfaces table** — add the onion addresses (web + rave) as surfaces, in the established table format.
- **`/about`** (or a small mention) — the host-key fingerprint + the off-the-grid framing (§7).

---

## 5. Where it runs, the cost, and the firewall correctness point

**Recommendation: the existing rave VPS, marginal $0.** It already runs the SSH app + `fluncle-dns`; a third systemd-managed service (`tor`/onionspray) is the established multi-service pattern, not a new precedent. Tor bandwidth for a hobby DnB archive's onion is negligible, well inside the `cx22`'s headroom.

**When a separate box would be warranted (the honest tradeoff).** The rave box is hardened precisely because it terminates _public_ TCP/22 (the user-facing showpiece). A Tor onion is a new ingress; if onion-side abuse/DoS could degrade the live `ssh rave.fluncle.com` experience, blast-radius isolation argues for a dedicated box (~€4–5/mo, another `cx22`, provisioned via the `hetzner-devbox` skill). The mitigating reality: Tor traffic to this onion will be near-zero, `tor` is a mature sandboxable daemon, and the PoW + intro-DoS defenses (§A.5) — once _actually enabled_ — cap the flooding risk. **Honest call: start on the rave box.** If onion traffic ever becomes non-trivial or abusive, lifting `tor` + the proxy to a dedicated box is a clean migration (the `HiddenServiceDir` keys move with it). Don't pay for isolation against a concern that may never materialize.

**The firewall correctness point, restated because it's load-bearing:** unlike `fluncle-dns` (open `:53` at two layers) and the SSH app (open `:22`), **the onion opens no inbound public ports.** The existing Hetzner provider firewall and UFW rules stay exactly as they are. The HTTP proxy binds `127.0.0.1`; the SSH onion reuses the already-open `:22`. The runbook must state this — it's the most reassuring fact in the proposal and the easiest to get wrong by reflex ("do I need to open a Tor port?" — no).

**Systemd hardening:** match the repo bar. `fluncle-dns.service` is heavily sandboxed (`ProtectSystem=strict`, `SystemCallFilter=@system-service`, `MemoryDenyWriteExecute`, etc.). A new internet-reachable daemon should not get _less_. The stock Debian `tor` unit is already fairly hardened (its own `debian-tor` user, `NoNewPrivileges`, `ProtectHome`, `PrivateTmp`, a syscall filter); use it as-is and, if extra hardening is wanted, add a `systemctl edit` drop-in rather than forking the vendor unit (so package updates keep flowing) — don't leave it as "if wanted," confirm the running unit meets the bar.

**Cost summary:** rave box = **$0 marginal**; dedicated box (if ever) = **~€4–5/mo**. The onion address itself is free. No new domain, no cert, no Cloudflare add-on.

---

## 6. The operator runbook (this becomes `docs/tor.md`)

Mirrors `docs/dig.md`'s "gated production steps — run them yourself" model. Admin access to the rave box is over Tailscale on port 2222 (per the `hetzner-devbox` profile).

### 6.0 The key contrast vs. `fluncle-dns`, up front

`fluncle-dns` is a **repo Go binary** shipped to `/opt/` with a hand-written hardened systemd unit. **Tor is the opposite shape:** stock package, its own `debian-tor` user, its own config, its own service. With onionspray, the rewriting stack is generated, not hand-written. **There is no `apps/tor/` directory and no repo binary to build.** The only repo artifact is the `Onion-Location` header (Unit C). State this plainly so nobody hunts for a binary.

### 6.1 Stand up the web onion (onionspray) — the real work; budget the time here

First clear the Cloudflare bypass (§A.2): from the VPS, `curl -sI -H 'Host: www.fluncle.com' https://www.fluncle.com/` must return `200` HTML, not a challenge. Add the WAF/IP bypass for the Hetzner egress IP if it does not.

Then install a pinned-recent onionspray (≥ 1.6.0, ideally latest 1.8.0+) and create one project that maps `www.fluncle.com` → a generated web onion. The project `.conf` is where the real configuration lives — at minimum it sets the onion mapping, the upstream-cert verification (§A.4), and the DoS opt-ins (§A.5):

```
# onionspray project .conf (illustrative — consult onionspray docs for exact keys)
set hardmode 1
onions www.fluncle.com
set nginx_proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt   # §A.4 — OFF by default
set tor_pow_enabled 1                                                         # §A.5 — OFF by default
set tor_intro_dos_defense 1                                                   # §A.5 — OFF by default
```

Then run onionspray's `config` → `make` → `start` lifecycle (per its docs) and note **where it writes the generated `HiddenServiceDir`** — you need that exact path for the backup (§6.3). onionspray upstreams to `https://www.fluncle.com` with `Host: www.fluncle.com` preserved (§A.1).

### 6.2 (Optional) add the rave/SSH onion

A second `HiddenServiceDir` (either in onionspray's bundled `tor`, or a plain `tor` instance if cleaner):

```
HiddenServiceDir /var/lib/tor/rave_ssh/
HiddenServicePort 22 127.0.0.1:22     # the Wish app — NOT :2222 (that's admin OpenSSH); see §B.1
```

Read the address: `sudo cat /var/lib/tor/rave_ssh/hostname`.

### 6.3 Keys, and the CRITICAL backup (a hard checkpoint — do this before anything references the address)

Each `HiddenServiceDir` holds `hostname` (the address) and `hs_ed25519_secret_key` / `hs_ed25519_public_key` (the identity). **The secret key IS the address. Lose the dir → the `.onion` is gone forever** — no re-issue, no recovery; every published link, the `Onion-Location` header, the docs would break. **And a _leak_ is as bad as a loss:** whoever holds the secret key can run a malicious clone at your published address, so the backup is about confidentiality too, not just durability — keep on-box perms `0700 debian-tor:debian-tor` and treat the backup like a root credential.

**Back up each `HiddenServiceDir` off-box immediately after first start.** Repo precedent for secret custody: Cloudflare/Turso creds live in **1Password (`op://Fluncle/...`)** — `docs/dig.md` reads from `op://Fluncle/Cloudflare DNS/...`. **Store the onion private keys as 1Password items in the Fluncle vault** (e.g. `op://Fluncle/Tor onion fluncle_web`, `op://Fluncle/Tor onion rave_ssh`). _This is the single irreversible step — gate the rest of the rollout on it being done._

### 6.4 Firewall — nothing to open

No new Hetzner provider-firewall rule. No new UFW allow rule. The HTTP proxy binds `127.0.0.1`; the SSH onion reuses `:22`. (See §5.)

### 6.5 systemd

Use onionspray's / the package's own service management; confirm the running `tor`/onionspray unit meets the repo's hardening bar (§5). Enable and confirm:

```bash
sudo systemctl enable --now tor      # or onionspray's service
sudo systemctl status tor --no-pager
```

### 6.6 Ship the `Onion-Location` header (repo + normal deploy)

Add `appendOnionLocation` at the `apps/web/src/server.ts` seam (§C.1), HTML-gated, with the web onion address as a Worker constant. `git push` → Workers Builds deploys it. No DNS, no dashboard.

### 6.7 Verify

```bash
# Read the addresses off the box (use onionspray's actual HiddenServiceDir path from §6.1):
sudo cat <onionspray-web-hsdir>/hostname
sudo cat /var/lib/tor/rave_ssh/hostname

# Before the onion: confirm Cloudflare doesn't challenge the proxy's origin fetch (§A.2):
curl -sI -H 'Host: www.fluncle.com' https://www.fluncle.com/   # expect 200 HTML, not a challenge

# From a Tor-enabled shell (a standalone `tor` exposes SOCKS5 on 127.0.0.1:9050):
torsocks curl -s http://<web-onion>.onion/ | head
torsocks curl -s http://<web-onion>.onion/rss.xml | head

# MCP over the onion (stateless JSON-RPC; the server ignores Accept and always returns JSON):
torsocks curl -s http://<web-onion>.onion/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# The rave terminal over the onion (needs netcat-openbsd; see §6.8):
ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:9050 %h %p' -o VerifyHostKeyDNS=no <rave-onion>.onion
ssh -t -o ProxyCommand='nc -X 5 -x 127.0.0.1:9050 %h %p' -o VerifyHostKeyDNS=no <rave-onion>.onion latest

# Onion-Location header on clearnet, after the Worker deploy (HTML pages only):
curl -sI https://www.fluncle.com/ | grep -i onion-location
curl -sI https://www.fluncle.com/log | grep -i onion-location     # per-path

# Confirm the DoS defenses are actually on (§A.5) and upstream cert verification is set (§A.4)
# in the running onionspray/tor config — don't assume the version pin did it.
```

Then **drive a real browser over the onion and check past hydration** (§A.1) — the page must not flip to the wrong content after the client router hydrates. When `torsocks curl` returns the archive, the page survives hydration, the SSH onion opens the rave terminal, and Tor Browser shows the ".onion available" pill, the surface is live.

### 6.8 What a _user_ needs (put this in the doc — it proves reachability, doesn't just claim it)

Tor Browser handles the _website_ onion. For SSH/MCP/curl, the user runs their own `tor` client (SOCKS5 on `127.0.0.1:9050`):

```bash
# macOS:        brew install tor && brew services start tor
# Debian/Ubuntu: sudo apt install tor && sudo systemctl enable --now tor
```

**Two footguns to document:** (1) a standalone `tor` daemon uses SOCKS port **`9050`**; the Tor Browser bundle uses **`9150`** — the wrong port is the single most common user failure. (2) the `nc -X 5` SOCKS5 form needs **`netcat-openbsd`** (macOS's stock `nc` works; GNU netcat does not support `-X`). Then `torsocks ssh <rave-onion>.onion` / `torsocks curl ... http://<web-onion>.onion/...`, or point any HTTP client at `--proxy socks5h://127.0.0.1:9050` (the `socks5h` form makes Tor resolve the `.onion`, so it isn't leaked locally). A persistent `~/.ssh/config` block lets the user just type the onion:

```
Host *.onion
  ProxyCommand nc -X 5 -x 127.0.0.1:9050 %h %p
  VerifyHostKeyDNS no
```

---

## 7. Voice — off the grid, still in the Galaxy (subordinate to canon)

The framing maps onto existing canon without inventing anything. Anchors (from `packages/skills/copywriting-fluncle/references/voice.md`):

- A **"surface"** is the canonical word for a place in the Galaxy. An onion is _another surface_, not a new concept — don't coin a capitalized proper noun for it (no "the Void Mirror"). It's _the archive, over Tor_.
- **The Depth Gradient:** technical density rises as you descend; at SSH it's "a recovered terminal from a research vessel." Tor sits **at or just past SSH** on that gradient — the same archive, reached off the grid. Use the **SSH register**: dry, deadpan, fully in-fiction, most technical, **no exclamation marks**, sentence case.
- **The Light-Years Rule:** everything arrives lossy from how far it travelled. An onion — slow, indirect, routed through the dark — is the most literal "cost of light-years" surface there is, and the Tor latency (§B.4) makes that real rather than decorative.
- **`recovered`** is the on-theme supporting verb; **"transmission(s)" and "signal(s)" are BANNED** (retired radio metaphor) — do not reach for them when describing Tor, however tempting. **"deep space" / "sector"** stay first-person prose garnish only, never UI labels.

**Framing — lead with the off-grid fact (the real property), keep "deep-space mirror" as buried garnish (the brief's phrase; canon wins over briefs).** Candidate lines, strongest first:

- _"Off the grid, still in the Galaxy."_ — foregrounds the real thing Tor does (off-grid reach) while keeping it in the fiction. Strongest; the doc title borrows it.
- _"The archive with the lights off."_ — direct, deadpan, scene-true; reads like the uncle said it.
- _"A deep-space mirror."_ — closest to the brief, fine as a one-time aside, but it's the weakest because it's a description-from-outside, not a thing Fluncle _does_.

A worked user-facing line (the Selector's stack: lead with his act, pass it to the crew, address them — active voice, not the agentless passive a ghost hides in):

> _"I dug these up and left a way in through the dark — same findings, same Log IDs, no map needed. Reach the archive off the grid when the lights are out, cosmonauts."_

(The earlier draft's _"Same findings… reached off the grid"_ failed the Active-Voice test — agentless passive, no body, no crew-turn. Fixed.)

Keep it tasteful: one or two lines, present on the surfaces, load-bearing nowhere (The Garnish Rule). DESIGN/PRODUCT/VOICE win on any conflict; route the final strings through the `copywriting-fluncle` skill.

---

## Sequencing & ownership

**The dependency chain is short and real:**

1. **Clear the Cloudflare origin bypass** (§A.2) — `curl` from the VPS returns 200, not a challenge. Cheapest gate; do it first so onionspray has something to mirror.
2. **Stand up the web onion** (Unit A: onionspray on the rave box, with the cert-verification and DoS opt-ins). Generates the web onion address. The real work.
3. **Back up the `HiddenServiceDir` keys to 1Password** — immediately, before anything references the address (the one irreversible step; hard checkpoint).
4. **(Optional) stand up the rave/SSH onion** (Unit B) — parallel with (2)/(3), same daemon, separate key (also backed up).
5. **Ship the `Onion-Location` header + docs/surfaces wiring** (Unit C) — _after_ the address exists; normal Worker deploy + a docs PR.

**What parallelizes:** the `docs/tor.md` authoring and the README/about wiring can be drafted while the box work happens (filling in the addresses last); Unit B runs alongside Unit A. **The one thing that de-risks the most: the key backup** — do it the moment the address exists. **The riskiest single step is onionspray's project config (§6.1)** — it's the one black box; everything else is one-config-block precise. Budget the real time there.

**Deploy discipline:** the `Onion-Location` header is a Worker change → Workers Builds on push to `main` (watch for build coalescing if pushing rapidly). The VPS steps and the Cloudflare bypass are gated production steps Maurice runs himself (per `docs/dig.md`'s model).

---

## Decisions needed BEFORE handoff

1. **Same box vs. new box.** Recommended: the existing rave VPS ($0). A dedicated box is ~€4–5/mo for blast-radius isolation only — paid infra, so it needs an explicit yes (AGENTS.md "External Effects"). _Default: same box._
2. **Scope: A+C only, or A+B+C?** The web onion (A) + `Onion-Location` (C) closes five of six checklist boxes and captures essentially all the value. The SSH onion (B) is the thinnest-value unit (a public, no-auth terminal toy over Tor). It's nearly free since it rides the same daemon, so "do it for completeness" is defensible — but it's a genuine choose, not a foregone "both." _Recommended: ship A+C first; add B as a fast-follow once A proves the daemon out._
3. **Vanity `.onion` prefix?** Optional flex: mine a readable prefix (e.g. `fluncle…`) with **`mkp224o`** / oniongen-go before first start. Costs local CPU wall-clock (a short prefix is minutes-to-hours; longer is exponentially slower), no money. Pure novelty, on-brand. _Default: no._ If yes, note that onionspray generates its own key by default, so the mined `hs_ed25519_secret_key` must be injected into the project's `HiddenServiceDir` _before_ first start (or mine the vanity address against a plain-`tor` `HiddenServiceDir` outside onionspray) — confirm the injection path before committing to vanity.
4. **Key-backup location + item names.** Recommended: 1Password Fluncle vault, matching `op://Fluncle/...` custody. _Confirm the item names._
5. **TLS cert on the onion?** Recommended: **no** (self-authenticating; avoid mixed content via the rewriter). _Default: no._

Everything else is settled in this RFC and needs no further decision: onionspray over EOTK; the cert-verification + DoS opt-ins are mandatory (not optional); the no-open-ports firewall posture; the Cloudflare bypass is required for Unit A; the `appendOnionLocation` HTML-gated seam in `apps/web/src/server.ts`; point the SSH onion at `:22` not `:2222`; the VOID-in-the-crew-counter behavior; the voice register.

---

## Acceptance criteria

Ship gates (verifiable now):

- [ ] From the VPS, `curl -sI -H 'Host: www.fluncle.com' https://www.fluncle.com/` returns `200` HTML, not a Cloudflare challenge (the §A.2 bypass is in place).
- [ ] `torsocks curl http://<web-onion>.onion/` returns the live archive; `/rss.xml` and `/api/v1/tracks` resolve over the onion; **the page survives hydration in a driven real browser** (no post-hydration content flip).
- [ ] `torsocks curl http://<web-onion>.onion/mcp` with a `tools/list` JSON-RPC body returns the tool list (MCP over Tor).
- [ ] onionspray's **upstream cert verification is configured** (`nginx_proxy_ssl_trusted_certificate` set) — not merely that the version is ≥ 1.6.0.
- [ ] **PoW + intro-DoS defenses are confirmed enabled** in the running onion config (not assumed-because-onionspray).
- [ ] (If Unit B) `ssh -o ProxyCommand=... -o VerifyHostKeyDNS=no <rave-onion>.onion` opens the rave terminal (the one on `:22`, not admin OpenSSH); `... latest` deep-links; `whoami` is still rejected by the Wish app.
- [ ] `curl -sI https://www.fluncle.com/` and `.../log` both show the `Onion-Location` header (per-path); JSON/XML endpoints (`/api/v1/*`, `/rss.xml`, `/mcp`) do **not**; Tor Browser shows the ".onion available" pill and one-click reaches the mirror.
- [ ] Each `HiddenServiceDir` is backed up to 1Password (the irreversible step is done) and on-box perms are `0700 debian-tor`.
- [ ] No new inbound rule exists in the Hetzner provider firewall or UFW (the posture is unchanged — verify nothing was opened by reflex); the `tor`/onionspray unit meets the repo hardening bar.
- [ ] **Docs:** `docs/tor.md` exists (runbook + client snippets + the `9050`-vs-`9150` and `netcat-openbsd` footguns + the SSH host-key fingerprint + the dormant MCP-SSE note); README Public Surfaces table lists the onions; the `appendOnionLocation` change in `apps/web` has a focused test.

Monitoring outcomes (NOT ship gates — outside our control): whether anyone uses the onion; Tor traffic volume. Don't block ship on these.

---

## Risks & open questions

- **Cloudflare challenges the proxy's origin fetch (most likely failure of the web onion).** A datacenter-IP, fingerprint-less server-to-server fetch is exactly what bot management flags, and the zone already has bot/AI controls in play. Mitigation: the WAF/IP bypass (§A.2) + the pre-onion `curl` gate. If unaddressed, every onion visitor sees an unsolvable Cloudflare challenge.
- **The two off-by-default safeguards (P0).** Upstream cert verification (§A.4) and the DoS defenses (§A.5) are NOT enabled by pinning a version — they're per-project opt-ins. Skipping them ships an onion that doesn't verify Cloudflare's cert and has no flood protection while looking done. Both are acceptance gates.
- **Irreversible key loss — and leak.** Lose a `HiddenServiceDir` → the address is permanently gone; _leak_ it → someone clones your address. Mitigation: back up to 1Password the moment it exists; `0700 debian-tor`; treat it as a root credential.
- **Onionspray drift / staleness.** It's an external tool; pin a recent version (≥ 1.6.0 for the cert-verification _option_, ideally latest) and keep `tor`/onionspray patched — `tor` ships security releases regularly. A stale rewriting proxy is a real attack surface.
- **The mirror touches decrypted traffic, and does not hide the operator.** Option (a) terminates the onion on the VPS and re-originates a clearnet HTTPS request to Cloudflare — the box sees the (public) content in the clear, and the onion's hosting is trivially co-located with the known clearnet site. So the onion gives _visitor_-metadata privacy, not _operator_-location privacy. Acceptable for a public, read-only archive; stated so nobody mistakes it for hiding Fluncle's infrastructure.
- **Hydration isomorphism.** The host-based router rewrite (`router.tsx`) means a wrong upstream `Host` breaks the page after hydration even when the first byte looks fine. Mitigation: pin `Host: www.fluncle.com`; verify past hydration in a real browser.
- **Blast radius on the rave box.** A shared box means onion-side abuse could degrade the SSH showpiece. Mitigated by PoW/intro-DoS (once on) + near-zero expected traffic; the dedicated-box escape hatch exists if it ever bites.
- **Dormant MCP-SSE caveat.** If the MCP server ever streams, the onion proxy needs buffering-off config. Recorded in `docs/tor.md`.
- **It might just not get used.** The honest one: this is a principled, on-brand flex, not a load-bearing path. We size and message it as such — `Onion-Location` + the onionspray mirror is the right amount of effort; anything heavier would be gold-plating.

---

## Appendix — verifications & sources

**Live code verifications (done during research + review):**

- `apps/web/src/server.ts` — the header seam fires **only on `pathname === "/"`** (`pathname === "/" ? appendAgentLinkHeaders(response) : response`); `Onion-Location` therefore needs a _new_ HTML-gated append for per-path pills, not a fold-in.
- `apps/web/src/lib/server/agent-discovery.ts` — `appendAgentLinkHeaders` re-wraps the immutable Worker response (`new Response(response.body, response)`) and appends headers — the re-wrap precedent for `appendOnionLocation`.
- `apps/web/src/router.tsx` — the SSR `rewrite` branches on `url.hostname.startsWith("galaxy.")` _isomorphically_; the proxy must send `Host: www.fluncle.com` upstream and the page must hydrate consistently.
- `apps/web/src/lib/server/mcp.ts` — MCP is stateless, JSON-only, POST-only, **rejects GET with 405** ("We don't offer a server-initiated SSE stream; tools speak over POST only"), issues no `Mcp-Session-Id`, ignores `Accept` — so MCP-over-Tor is free of the SSE/affinity gotchas.
- `apps/ssh/main.go` — `:2222` is only the local-dev fallback (`loadConfig`); the persisted `ssh_host_ed25519_key`; the no-shell `activeterm`+`routeCommandMiddleware` chain; `countryCodeForSession` → `VOID` for loopback/private/unparseable sources.
- `packages/skills/hetzner-devbox/SKILL.md` + `scripts/deploy-ssh-app-service.sh` — **production binds the Wish app to `:22`** (`FLUNCLE_SSH_PORT=22`); the admin OpenSSH daemon is moved to `:2222`, Tailscale-only. The SSH onion must target `:22`.
- `apps/dns/fluncle-dns.service` + `docs/dig.md` — the multi-service-on-rave-VPS precedent, the systemd hardening bar to match, and the "open the port at two firewall layers" pattern the onion _inverts_ (opens nothing).

**External sources (verified against primary docs, current 2024–2026 practice):**

- Tor Project — Set up Your Onion Service: <https://community.torproject.org/onion-services/setup/>
- Tor Project — Onion-Location (HTTPS-only, not-onion, desktop-only, the pill): <https://community.torproject.org/onion-services/advanced/onion-location/>, <https://support.torproject.org/onionservices/onion-location/>
- Tor Project — onion DoS guidelines (PoW + intro-DoS **disabled by default**, must enable): <https://community.torproject.org/onion-services/advanced/dos/>; PoW intro (module default in 0.4.8.1-alpha+): <https://blog.torproject.org/introducing-proof-of-work-defense-for-onion-services/>
- onionspray — homepage, changelog (v1.8.0 = 2026-06-02, Tor 0.4.9.9; v1.6.0 = 2024-02-09), and **Security Advisory 002 (`proxy_ssl_verify` is OFF by default; set `nginx_proxy_ssl_trusted_certificate`)**: <https://onionservices.torproject.org/apps/web/onionspray/>, <https://onionservices.torproject.org/apps/web/onionspray/changelog/>, <https://onionservices.torproject.org/apps/web/onionspray/security/advisories/002-proxy_ssl_verify/>, <https://onionservices.torproject.org/apps/web/onionspray/guides/dos/>
- EOTK (original, unmaintained since 2021-05): <https://github.com/alecmuffett/eotk>; author on the fork: <https://alecmuffett.com/article/109098>
- Cloudflare Onion Routing (opportunistic `Alt-Svc`, no controllable address, no HTTPS): <https://developers.cloudflare.com/network/onion-routing/>
- SSH over Tor — TorifyHOWTO/ssh (the `nc -X 5` SOCKS5 form, `9050` vs `9150`): <https://trac.torproject.org/projects/tor/wiki/doc/TorifyHOWTO/ssh>; `VerifyHostKeyDNS` SSHFP pre-resolution leak: <https://blog.des.no/2013/10/verifyhostkeydns/>
- MCP transports (2025-06-18; JSON-or-SSE; session IDs are MAY): <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>; SSE-through-proxy buffering (future caveat): <https://gofastmcp.com/deployment/http>
- v3 onion address construction (`pubkey ‖ checksum ‖ version`, base32) + vanity mining: <https://github.com/rdkr/oniongen-go>, mkp224o
- Tor latency figures: ShorTor <https://arxiv.org/pdf/2204.04489>, DarkHorse <https://arxiv.org/html/2307.02429v1>
