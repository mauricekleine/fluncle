// The RANDOM-VJ director (`--plan all`): the shuffle-bag (pure, seeded) + the UDP transition
// channel's datagram parser + the live listener's never-crash rail. The bag guarantees are
// load-bearing (unique-before-repeat, reshuffle, no back-to-back across the boundary), so they
// are tested deterministically with a pinned seed; the parser is total; the listener binds an
// EPHEMERAL port (0) so parallel agents never collide on 9000.

import dgram from "node:dgram";

import { afterEach, describe, expect, test } from "bun:test";

import { VJ_TRANSITION_PORT } from "../contract";
import {
  createShuffleBag,
  mulberry32,
  parseTransition,
  resolveVjTransitionPort,
  startVjTransitionListener,
  type VjTransitionListener,
} from "./vj";

describe("createShuffleBag", () => {
  test("60-pool: the first 60 draws are unique and cover 0..59 (without replacement)", () => {
    const bag = createShuffleBag(60, mulberry32(1234));
    const first = Array.from({ length: 60 }, () => bag.next());
    expect(new Set(first).size).toBe(60);
    expect([...first].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  test("the reshuffle fires: the SECOND 60 is again a full permutation of 0..59", () => {
    const bag = createShuffleBag(60, mulberry32(9));
    Array.from({ length: 60 }, () => bag.next()); // drain the first bag
    const second = Array.from({ length: 60 }, () => bag.next());
    expect(new Set(second).size).toBe(60);
    expect([...second].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  test("no back-to-back repeat anywhere — including across the reshuffle boundary", () => {
    // Draw several full cycles so many reshuffle boundaries are crossed.
    const bag = createShuffleBag(60, mulberry32(42));
    const draws = Array.from({ length: 60 * 5 }, () => bag.next());
    for (let i = 1; i < draws.length; i++) {
      expect(draws[i]).not.toBe(draws[i - 1]);
    }
  });

  test("a size-2 pool alternates — the boundary swap defuses every collision", () => {
    // With 2 findings, ~half of reshuffles would repeat at the boundary without the swap.
    const bag = createShuffleBag(2, mulberry32(7));
    const draws = Array.from({ length: 50 }, () => bag.next());
    for (let i = 1; i < draws.length; i++) {
      expect(draws[i]).not.toBe(draws[i - 1]);
    }
  });

  test("size 1 is the degenerate pool — always 0 (back-to-back unavoidable)", () => {
    const bag = createShuffleBag(1, mulberry32(1));
    expect([bag.next(), bag.next(), bag.next()]).toEqual([0, 0, 0]);
  });

  test("a non-positive / non-integer size throws", () => {
    expect(() => createShuffleBag(0, mulberry32(1))).toThrow(RangeError);
    expect(() => createShuffleBag(-3, mulberry32(1))).toThrow(RangeError);
    expect(() => createShuffleBag(2.5, mulberry32(1))).toThrow(RangeError);
  });

  test("the same seed replays the same draw order (deterministic)", () => {
    const a = createShuffleBag(20, mulberry32(555));
    const b = createShuffleBag(20, mulberry32(555));
    const drawsA = Array.from({ length: 45 }, () => a.next());
    const drawsB = Array.from({ length: 45 }, () => b.next());
    expect(drawsA).toEqual(drawsB);
  });
});

describe("ShuffleBag.take (anti-repeat for a canonical match)", () => {
  test("a taken index never reappears before the reshuffle", () => {
    // Take one index up front, then drain the REST of this cycle — the taken index is gone.
    const bag = createShuffleBag(10, mulberry32(2024));
    expect(bag.take(4)).toBe(true);
    const rest = Array.from({ length: 9 }, () => bag.next()); // 10 - 1 taken = 9 remain
    expect(rest).not.toContain(4);
    expect(new Set(rest).size).toBe(9); // the other nine, each once
    expect([...rest].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9]);
  });

  test("taking mid-cycle removes only from the remaining tail; already-drawn is a no-op", () => {
    const bag = createShuffleBag(8, mulberry32(77));
    const drawn = [bag.next(), bag.next(), bag.next()];
    // Taking an already-drawn index is a harmless no-op (it isn't in the remaining tail).
    expect(bag.take(drawn[0])).toBe(false);
    // Take a still-pending index; it must not surface in the rest of this cycle.
    const pending = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => !drawn.includes(i)) ?? -1;
    expect(bag.take(pending)).toBe(true);
    const rest = Array.from({ length: 4 }, () => bag.next()); // 8 - 3 drawn - 1 taken = 4
    expect(rest).not.toContain(pending);
    // Every index appeared exactly once across the whole cycle (drawn + taken + rest = 0..7).
    expect([...drawn, pending, ...rest].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("taking an out-of-range index is a harmless no-op", () => {
    const bag = createShuffleBag(5, mulberry32(1));
    expect(bag.take(99)).toBe(false);
    expect(bag.take(-1)).toBe(false);
    const draws = Array.from({ length: 5 }, () => bag.next());
    expect([...draws].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  test("a taken index isn't re-shown back-to-back across the reshuffle boundary", () => {
    // Take the LAST remaining index of a cycle, then reshuffle: the boundary swap must still
    // ensure the very next draw isn't the just-shown (taken) one.
    const bag = createShuffleBag(6, mulberry32(31));
    const first = Array.from({ length: 5 }, () => bag.next()); // draw 5 of 6
    const remaining = [0, 1, 2, 3, 4, 5].find((i) => !first.includes(i)) ?? -1;
    expect(bag.take(remaining)).toBe(true); // take the 6th — the cycle is now exhausted
    // Next draw reshuffles a fresh full permutation; it must not repeat the taken index.
    const afterBoundary = bag.next();
    expect(afterBoundary).not.toBe(remaining);
  });

  test("no two consecutively SHOWN indices repeat, across many cycles with interleaved takes", () => {
    // `last` tracks the last SHOWN index whether it was drawn (`next`) or matched (`take`).
    const bag = createShuffleBag(12, mulberry32(808));
    let last = -1;
    for (let i = 0; i < 200; i++) {
      // Every few steps, "match" (take) an index instead of drawing it. Pick one != last.
      if (i % 5 === 0) {
        const candidate = (last + 3) % 12;
        if (bag.take(candidate)) {
          expect(candidate).not.toBe(last);
          last = candidate; // the taken index is now the last-shown finding
        }
      }
      const idx = bag.next();
      expect(idx).not.toBe(last);
      last = idx;
    }
  });
});

describe("parseTransition", () => {
  test("a valid transition datagram parses to its deck", () => {
    expect(parseTransition('{"type":"transition","deck":1}')).toEqual({ deck: 1 });
    expect(parseTransition('{"type":"transition","deck":2}')).toEqual({ deck: 2 });
  });

  test("malformed / non-JSON is ignored (null)", () => {
    expect(parseTransition("not json at all")).toBeNull();
    expect(parseTransition("")).toBeNull();
    expect(parseTransition("{")).toBeNull();
    expect(parseTransition("[1,2,3]")).toBeNull(); // valid JSON, but not a transition object
    expect(parseTransition("null")).toBeNull();
    expect(parseTransition("42")).toBeNull();
  });

  test("the wrong `type` is ignored", () => {
    expect(parseTransition('{"type":"heartbeat","deck":1}')).toBeNull();
    expect(parseTransition('{"deck":1}')).toBeNull(); // no type
  });

  test("a missing / out-of-range deck is ignored", () => {
    expect(parseTransition('{"type":"transition"}')).toBeNull(); // no deck
    expect(parseTransition('{"type":"transition","deck":0}')).toBeNull();
    expect(parseTransition('{"type":"transition","deck":3}')).toBeNull();
    expect(parseTransition('{"type":"transition","deck":"1"}')).toBeNull(); // string, not number
  });

  test("a well-formed identity is attached (title/artist + optional bpm/key guards)", () => {
    expect(
      parseTransition(
        '{"type":"transition","deck":1,"identity":{"title":"Strength","artist":"Technimatic","bpm":174,"key":"6A"}}',
      ),
    ).toEqual({
      deck: 1,
      identity: { artist: "Technimatic", bpm: 174, key: "6A", title: "Strength" },
    });
  });

  test("identity with just title+artist is valid; absent guards are simply omitted", () => {
    expect(
      parseTransition('{"type":"transition","deck":2,"identity":{"title":"X","artist":"Y"}}'),
    ).toEqual({ deck: 2, identity: { artist: "Y", title: "X" } });
  });

  test("a malformed / missing / wrong-typed identity degrades to no identity — never rejects the transition", () => {
    // No identity key at all — still a valid transition.
    expect(parseTransition('{"type":"transition","deck":1}')).toEqual({ deck: 1 });
    // identity is not an object.
    expect(parseTransition('{"type":"transition","deck":1,"identity":"nope"}')).toEqual({
      deck: 1,
    });
    expect(parseTransition('{"type":"transition","deck":1,"identity":42}')).toEqual({ deck: 1 });
    expect(parseTransition('{"type":"transition","deck":1,"identity":null}')).toEqual({ deck: 1 });
    // Missing/non-string title or artist ⇒ the identity doesn't count, but the transition stands.
    expect(parseTransition('{"type":"transition","deck":1,"identity":{"title":"X"}}')).toEqual({
      deck: 1,
    });
    expect(
      parseTransition('{"type":"transition","deck":1,"identity":{"title":5,"artist":"Y"}}'),
    ).toEqual({ deck: 1 });
  });

  test("a malformed bpm/key guard is dropped but a valid title+artist identity survives", () => {
    // Non-finite / non-number bpm is dropped; string title+artist keep the identity.
    expect(
      parseTransition(
        '{"type":"transition","deck":1,"identity":{"title":"X","artist":"Y","bpm":"174","key":5}}',
      ),
    ).toEqual({ deck: 1, identity: { artist: "Y", title: "X" } });
    // NaN/Infinity aren't representable in JSON, but an out-of-shape number field is handled the
    // same way — only a finite number counts (covered by the string-bpm case above).
    expect(
      parseTransition(
        '{"type":"transition","deck":2,"identity":{"title":"X","artist":"Y","key":"5A"}}',
      ),
    ).toEqual({ deck: 2, identity: { artist: "Y", key: "5A", title: "X" } });
  });
});

describe("resolveVjTransitionPort", () => {
  test("defaults to VJ_TRANSITION_PORT when the env is unset, empty, or junk", () => {
    expect(resolveVjTransitionPort(undefined)).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("")).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("not-a-port")).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("-1")).toBe(VJ_TRANSITION_PORT);
  });

  test("rejects trailing garbage instead of truncating it (parseInt('9000abc') = 9000)", () => {
    expect(resolveVjTransitionPort("9000abc")).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("90.5")).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("0x1F90")).toBe(VJ_TRANSITION_PORT);
  });

  test("rejects an out-of-range port (would explode at bind) and falls back", () => {
    expect(resolveVjTransitionPort("99999")).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("65536")).toBe(VJ_TRANSITION_PORT);
  });

  test("honours a valid in-range override (0 = an ephemeral OS-assigned port)", () => {
    expect(resolveVjTransitionPort("9100")).toBe(9100);
    expect(resolveVjTransitionPort("0")).toBe(0);
    expect(resolveVjTransitionPort("65535")).toBe(65535); // the top of the bindable range
    expect(resolveVjTransitionPort(" 9000 ")).toBe(9000); // surrounding whitespace tolerated
  });
});

describe("startVjTransitionListener (the never-crash rail, over a real ephemeral socket)", () => {
  let listener: VjTransitionListener | null = null;
  const client = dgram.createSocket("udp4");

  afterEach(async () => {
    await listener?.close();
    listener = null;
  });

  /** Fire one datagram at the bound listener and wait a beat for delivery. */
  function send(port: number, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.send(Buffer.from(body), port, "127.0.0.1", (err) =>
        err ? reject(err) : setTimeout(resolve, 20),
      );
    });
  }

  test("a valid datagram calls onTransition; malformed ones are ignored silently", async () => {
    const received: number[] = [];
    listener = await startVjTransitionListener({
      onTransition: (msg) => received.push(msg.deck),
      port: 0,
    });
    expect(listener.port).toBeGreaterThan(0);

    await send(listener.port, "garbage not json"); // ignored
    await send(listener.port, '{"type":"heartbeat","deck":1}'); // wrong type, ignored
    await send(listener.port, '{"type":"transition","deck":2}'); // the only valid one
    // Give the loop a final tick to flush.
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toEqual([2]);
    await new Promise<void>((r) => client.close(() => r()));
  });
});
