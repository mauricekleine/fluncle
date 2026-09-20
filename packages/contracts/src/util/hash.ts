/**
 * Stable 32-bit FNV-1a hash as an unsigned integer. Persisted Log IDs, plan handles,
 * observability tokens, and replica identities depend on this exact algorithm.
 * The optional seed gives replica identities two independent 32-bit lanes.
 */
export function fnv1a32(value: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

/** Stable 64-bit FNV-1a hash over UTF-8 bytes for persisted due-work source versions. */
export function fnv1a64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;

  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }

  return hash;
}
