import dgram from "node:dgram";

import { VJ_TRANSITION_PORT } from "../contract";

export type Rng = () => number;

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

export type ShuffleBag = {
  next(): number;

  take(index: number): boolean;

  readonly size: number;
};

export function createShuffleBag(size: number, rng: Rng): ShuffleBag {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`shuffle bag size must be a positive integer, got ${size}`);
  }

  let bag: number[] = [];
  let cursor = 0;
  let lastDrawn = -1;

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

  function refill(): void {
    bag = shuffled();
    cursor = 0;

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
      if (cursor >= bag.length) {
        refill();
      }

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

type VjIdentity = {
  title: string;
  artist: string;
  bpm?: number;
  key?: string;
};

export type VjTransition = { deck: 1 | 2; identity?: VjIdentity };

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

export function resolveVjTransitionPort(env = process.env.FLUNCLE_VJ_TRANSITION_PORT): number {
  if (env === undefined || !/^\d+$/.test(env.trim())) {
    return VJ_TRANSITION_PORT;
  }
  const parsed = Number.parseInt(env.trim(), 10);
  return parsed <= 65535 ? parsed : VJ_TRANSITION_PORT;
}

export type VjTransitionListener = {
  readonly port: number;

  close(): Promise<void>;
};

export function startVjTransitionListener(opts: {
  port: number;
  onTransition: (msg: VjTransition) => void;
  onError?: (err: Error) => void;
}): Promise<VjTransitionListener> {
  const { onTransition, port } = opts;
  const onError = opts.onError ?? ((err) => console.error("bridge: VJ transition socket —", err));
  const socket = dgram.createSocket("udp4");

  socket.on("message", (buf) => {
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
