/** What the game needs to know about one finding, fetched at boot. */
export type GameTrack = {
  addedAt: string;
  artists: string[];
  logId?: string;
  spotifyUrl: string;
  title: string;
  trackId: string;
};

// The entity spine (docs/ROADMAP.md, "The expanding frontier"; the frontier
// RFC). Everything in the galaxy — a banger, the Roadster, a UFO, a black
// hole, an asteroid, a laser bolt — is "a thing at a world coordinate the ship
// can be near, that may drift, that may collide." That is one shape with a
// `kind` discriminator and a small per-kind behavior table (see sim.ts), so
// new frontier content is data plus a behavior function, never a re-architect.
//
// Two lifecycles, two arrays (SimState), both Entity-typed: stars are placed
// once at boot and never spawn or despawn, so the star list is stable (its
// index is a durable handle and selectors over it need no per-frame filter);
// the frontier list churns (bolts spawn, asteroids/holes are seeded per run).

export type EntityKind = "asteroid" | "blackhole" | "bolt" | "roadster" | "star" | "ufo";

/** The frontier kinds: everything that is not a banger star. */
export type FrontierKind = Exclude<EntityKind, "star">;

type EntityBase = {
  /** Stable handle: logId for stars, `${kind}:${seed}` placed, `bolt:${n}` spawned. */
  id: string;
  kind: EntityKind;
  /** Radial distance from Earth (world units); the spawn-density + cull band. */
  radius: number;
  /** Drift velocity, world units/second; 0 for static bodies. */
  vx: number;
  vy: number;
  /** Render-only fake height above/below the horizon plane. */
  vOffset: number;
  x: number;
  y: number;
};

/** A banger star, placed at its Log ID coordinate. */
export type Star = EntityBase & {
  /** Bearing-stable angle on its ring, radians. */
  angle: number;
  artistLine: string;
  /** Logged on the visit that reaches it (folds the old parallel collected[]). */
  collected: boolean;
  kind: "star";
  logId: string;
  sector: number;
  spotifyUrl: string;
  title: string;
  trackId: string;
};

/** Set-dressing, hazards, and spawned projectiles — the dynamic frontier. */
export type FrontierEntity = EntityBase & {
  /** Physical size in world units (collision + render scale); stars size off STAR_BODY. */
  bodyRadius?: number;
  /** Black hole: the world coordinates this hole flings the ship to. */
  exits?: Vec2[];
  kind: FrontierKind;
  /** Bolts/transient entities: the sim time they were spawned, for TTL cull. */
  spawnedAt?: number;
  /** Render tumble/drift phase seed (set-dressing, asteroids). */
  spin?: number;
};

export type Entity = FrontierEntity | Star;

export type Vec2 = {
  x: number;
  y: number;
};

export function isStar(entity: Entity): entity is Star {
  return entity.kind === "star";
}
