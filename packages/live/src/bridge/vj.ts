// THE RANDOM-VJ DIRECTOR (`--plan all`) — Unit B's other job.
//
// RANDOM-VJ MODE is a DIFFERENT job from the plan-scoped matcher: the DJ plays anything,
// in any order, possibly tracks that aren't in the archive at all. There is no identity to
// match. We just want an on-brand visual that CHANGES on each transition, drawn from the
// WHOLE archive, never repeating within a set. So instead of the matcher, the bridge runs:
//
//   * a SHUFFLE-BAG director — random without replacement (every finding shows exactly once
//     before any repeats), reshuffled on exhaust, and never the same finding back-to-back
//     across the reshuffle boundary; and
//   * a UDP transition channel — the DJ-mixer sender on the other machine fires a datagram
//     on each mix transition; each valid one pulls the next index from the bag and drives
//     the show through the SAME `goto` command path the phone remote already uses.
//
// The bag is PURE and SEEDABLE (inject the RNG) so it is deterministic + unit-testable. The
// listener owns only I/O (a `node:dgram` socket) and a never-crash rail: a malformed / non-
// JSON datagram is ignored silently, and a socket error is logged, never thrown.

import dgram from "node:dgram";

import { VJ_TRANSITION_PORT } from "../contract";

/** A pseudo-random source in `[0, 1)` — injected so the shuffle bag is deterministic. */
export type Rng = () => number;

/**
 * mulberry32 — a tiny, fast, well-distributed seedable PRNG. Exported so the bridge can seed
 * a fresh sequence per set (`mulberry32(Date.now())`) and the tests can pin a seed for a
 * deterministic draw order. Returns an `Rng` in `[0, 1)`.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The shuffle-bag director: `next()` yields the index of the finding to show next. */
export type ShuffleBag = {
  /** Pull the next index (`0..size-1`), refilling + reshuffling the bag when it exhausts. */
  next(): number;
  /**
   * Remove `index` from the CURRENT cycle's remaining draws so it can't come up again before
   * the reshuffle — called when a canonical identity match drives the show to `index` directly
   * (bypassing `next()`), so a matched finding isn't then re-shown by a later random draw this
   * cycle. Returns whether it was removed: `true` when `index` was still pending, `false` when
   * it was already drawn/taken this cycle (a harmless no-op) or is out of range. Also marks
   * `index` as the last-shown, so the reshuffle-boundary anti-repeat covers a taken match too.
   */
  take(index: number): boolean;
  /** The pool size the bag draws over. */
  readonly size: number;
};

/**
 * A shuffle bag over `0..size-1`: random WITHOUT replacement (every index shows exactly once
 * before any repeats), reshuffled on exhaust, and guaranteed never to show the same index
 * back-to-back — including across the reshuffle boundary (the last draw of one bag and the
 * first of the next). Pure + deterministic given `rng`. Degenerate pools: `size === 1` can
 * only ever return `0` (a back-to-back repeat is unavoidable with one finding).
 */
export function createShuffleBag(size: number, rng: Rng): ShuffleBag {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`shuffle bag size must be a positive integer, got ${size}`);
  }

  let bag: number[] = [];
  let cursor = 0;
  let lastDrawn = -1;

  /** Fisher–Yates over `0..size-1` using the injected rng. */
  function shuffled(): number[] {
    const arr = Array.from({ length: size }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** Refill: reshuffle, and if the new head repeats the last draw, swap it past the boundary. */
  function refill(): void {
    bag = shuffled();
    cursor = 0;
    // Entries are unique, so bag[1] differs from bag[0] (= lastDrawn) and from lastDrawn —
    // swapping the head with it defuses the only possible back-to-back across the boundary.
    if (size > 1 && bag[0] === lastDrawn) {
      const tmp = bag[0];
      bag[0] = bag[1];
      bag[1] = tmp;
    }
  }

  return {
    next(): number {
      if (cursor >= bag.length) {
        refill();
      }
      const idx = bag[cursor];
      cursor++;
      lastDrawn = idx;
      return idx;
    },
    get size(): number {
      return size;
    },
    take(index: number): boolean {
      // Fill/reshuffle if the current cycle is exhausted (or never started) — a match can be
      // the very FIRST transition, before any `next()`, and we still want it out of this cycle.
      if (cursor >= bag.length) {
        refill();
      }
      // Only the not-yet-drawn tail (`bag[cursor..]`) is still "in the bag" this cycle;
      // anything before the cursor has already been shown. Splice it out of the tail so a
      // later `next()` this cycle can't draw it again, and mark it last-shown for the boundary.
      for (let i = cursor; i < bag.length; i++) {
        if (bag[i] === index) {
          bag.splice(i, 1);
          lastDrawn = index;
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * The optional identity a transition datagram carries — what the DJ has loaded on the deck
 * that just went live, read by `deckwatch.py` on the mixing machine. Structurally the resolver's
 * `ObservedDeck` (`identity.ts`), so `serve.ts` hands it straight to `resolveDeck`. `title` +
 * `artist` are the identity (both required); `bpm`/`key` are the resolver's coarse guards.
 */
export type VjIdentity = {
  title: string;
  artist: string;
  bpm?: number;
  key?: string;
};

/** A parsed VJ transition datagram: which mixer deck the DJ transitioned to, + optional identity. */
export type VjTransition = { deck: 1 | 2; identity?: VjIdentity };

/**
 * Structurally validate a datagram's `identity` field, degrading to `undefined` (never
 * throwing, never rejecting the transition) on anything malformed. `title` + `artist` MUST both
 * be strings for the identity to count — they are the match identity. `bpm` must be a finite
 * number or absent; `key` a string or absent — a malformed guard is simply DROPPED (the resolver
 * treats guards as optional), so a bad guard never costs a good title+artist read.
 */
function parseIdentity(raw: unknown): VjIdentity | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const obj = raw as { title?: unknown; artist?: unknown; bpm?: unknown; key?: unknown };
  if (typeof obj.title !== "string" || typeof obj.artist !== "string") {
    return undefined;
  }
  const identity: VjIdentity = { artist: obj.artist, title: obj.title };
  if (typeof obj.bpm === "number" && Number.isFinite(obj.bpm)) {
    identity.bpm = obj.bpm;
  }
  if (typeof obj.key === "string") {
    identity.key = obj.key;
  }
  return identity;
}

/**
 * Parse one UDP datagram body into a VjTransition, or `null` when it is not a valid
 * `{"type":"transition","deck":1|2}` message — malformed / non-JSON, the wrong `type`, a
 * missing field, or an out-of-range deck. An OPTIONAL `identity` object is validated
 * structurally and attached when well-formed; a missing/malformed one degrades to no identity
 * WITHOUT rejecting the transition. Pure, total, and never throws, so the listener's
 * never-crash rail is a single guard. Unit-tested directly.
 */
export function parseTransition(raw: string): VjTransition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const msg = parsed as { type?: unknown; deck?: unknown; identity?: unknown };
  if (msg.type !== "transition") {
    return null;
  }
  if (msg.deck !== 1 && msg.deck !== 2) {
    return null;
  }
  const identity = parseIdentity(msg.identity);
  return identity ? { deck: msg.deck, identity } : { deck: msg.deck };
}

/**
 * Resolve the VJ transition bind port: `FLUNCLE_VJ_TRANSITION_PORT` over the default. The env
 * value must be a WHOLE valid integer in the bindable range `0..65535` (0 = an ephemeral
 * OS-assigned port) — trailing garbage (`"9000abc"`, which `parseInt` would silently truncate
 * to 9000) and out-of-range values (`"99999"`, which would explode at `bind()`) fall back to
 * the default rather than fail opaquely later. Pure, so the validation table is unit-tested.
 */
export function resolveVjTransitionPort(env = process.env.FLUNCLE_VJ_TRANSITION_PORT): number {
  if (env === undefined || !/^\d+$/.test(env.trim())) {
    return VJ_TRANSITION_PORT;
  }
  const parsed = Number.parseInt(env.trim(), 10);
  return parsed <= 65535 ? parsed : VJ_TRANSITION_PORT;
}

/** A running VJ transition listener — the actual bound port + a graceful close. */
export type VjTransitionListener = {
  /** The port the socket actually bound (the OS-assigned one when `port` was `0`). */
  readonly port: number;
  /** Close the socket. */
  close(): Promise<void>;
};

/**
 * Bind a `node:dgram` UDP listener on `port` (0 = an ephemeral OS-assigned port, for tests —
 * parallel agents share the box, so 9000 would collide). Bound on all interfaces so a
 * LAN/VPN peer (the DJ-mixer sender on the other machine) can reach it — LAN-local by design.
 * Each VALID transition datagram calls `onTransition(msg)`; malformed ones are ignored
 * silently and socket errors go to `onError` (default: logged) — the bridge's never-crash
 * rail. Resolves once the socket is listening, exposing the bound port + a close.
 */
export function startVjTransitionListener(opts: {
  port: number;
  onTransition: (msg: VjTransition) => void;
  onError?: (err: Error) => void;
}): Promise<VjTransitionListener> {
  const { onTransition, port } = opts;
  const onError = opts.onError ?? ((err) => console.error("bridge: VJ transition socket —", err));
  const socket = dgram.createSocket("udp4");

  socket.on("message", (buf) => {
    // Never-crash rail: a bad datagram (or a downstream throw) must not kill the bridge.
    try {
      const msg = parseTransition(buf.toString("utf8"));
      if (msg) {
        onTransition(msg);
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  });
  socket.on("error", (err) => {
    onError(err);
  });

  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, () => {
      socket.removeListener("error", reject);
      resolve({
        close(): Promise<void> {
          return new Promise((res) => socket.close(() => res()));
        },
        port: socket.address().port,
      });
    });
  });
}
