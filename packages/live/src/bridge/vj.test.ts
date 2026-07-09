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
});

describe("resolveVjTransitionPort", () => {
  test("defaults to VJ_TRANSITION_PORT when the env is unset or junk", () => {
    expect(resolveVjTransitionPort(undefined)).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("")).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("not-a-port")).toBe(VJ_TRANSITION_PORT);
    expect(resolveVjTransitionPort("-1")).toBe(VJ_TRANSITION_PORT);
  });

  test("honours a valid override (0 = an ephemeral OS-assigned port)", () => {
    expect(resolveVjTransitionPort("9100")).toBe(9100);
    expect(resolveVjTransitionPort("0")).toBe(0);
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
