export type GameTrack = {
  addedAt: string;
  artists: string[];
  logId?: string;
  spotifyUrl: string;
  title: string;
  trackId: string;
};

type EntityKind = "asteroid" | "blackhole" | "bolt" | "roadster" | "star" | "ufo";

export type FrontierKind = Exclude<EntityKind, "star">;

type EntityBase = {
  id: string;
  kind: EntityKind;

  radius: number;

  vx: number;
  vy: number;

  vOffset: number;
  x: number;
  y: number;
};

export type Star = EntityBase & {
  angle: number;
  artistLine: string;

  collected: boolean;

  lifetimeLogged?: boolean;
  kind: "star";
  logId: string;
  sector: number;
  spotifyUrl: string;
  title: string;
  trackId: string;
};

export type FrontierEntity = EntityBase & {
  bodyRadius?: number;

  exits?: Vec2[];
  kind: FrontierKind;

  spawnedAt?: number;

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
