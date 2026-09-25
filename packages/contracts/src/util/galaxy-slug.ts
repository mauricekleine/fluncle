import { fnv1a32 as fnv1a } from "./hash";

export { fnv1a };

export const GALAXY_ADJECTIVES = [
  "liquid",
  "rolling",
  "deep",
  "dark",
  "heavy",
  "molten",
  "weightless",
  "hypnotic",
  "feral",
  "luminous",
  "drifting",
  "glacial",
  "restless",
  "distant",
  "boundless",
  "radiant",
  "seismic",
  "fathomless",
] as const;

export const GALAXY_COSMOS = [
  "nebula",
  "orbit",
  "pulsar",
  "quasar",
  "comet",
  "horizon",
  "dimension",
  "cosmos",
  "meteor",
  "aurora",
  "supernova",
  "parsec",
  "singularity",
  "gravity",
] as const;

export const GALAXY_SCENE = [
  "roller",
  "rinse",
  "dubplate",
  "rewind",
  "riddim",
  "stepper",
  "amen",
  "breakbeat",
  "jungle",
  "sublow",
  "bassline",
  "skank",
] as const;

export const BANNED: ReadonlySet<string> = new Set([
  "banger",
  "tune",
  "sector",
  "eclipse",
  "void",
  "transmission",
  "signal",
  "anomaly",
  "curated",
  "content",
  "stream",
  "nirvana",
  "ayahuasca",
  "meditation",
  "buddhism",
  "hippie",
  "incense",
]);

export const GALAXY_SLUG_COMBINATIONS =
  GALAXY_ADJECTIVES.length * GALAXY_COSMOS.length * GALAXY_SCENE.length;

function mix32(value: number): number {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;

  return hash >>> 0;
}

function pick(pool: readonly string[], saltedSeed: string, axis: number): string {
  const index = mix32(fnv1a(`${saltedSeed}\u0000${axis}`)) % pool.length;

  return pool[index] ?? pool[0] ?? "";
}

export function galaxySlug(seed: string, attempt = 0): string {
  const saltedSeed = `${seed}\u0000${attempt}`;
  const adjective = pick(GALAXY_ADJECTIVES, saltedSeed, 0);
  const cosmos = pick(GALAXY_COSMOS, saltedSeed, 1);
  const scene = pick(GALAXY_SCENE, saltedSeed, 2);
  const base = `${adjective}-${cosmos}-${scene}`;

  return attempt >= GALAXY_SLUG_COMBINATIONS ? `${base}-${attempt}` : base;
}

export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function labelFold(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
