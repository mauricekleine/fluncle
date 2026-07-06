// Self-running checks for the Galaxy-vocab plan handle — no framework.
// Run: `bun src/util/galaxy-slug.test.ts` (or `bun test`).
//
// The LOAD-BEARING invariant is #1: no vocab-pool word may be in `BANNED`. The
// slug is a permanent, machine-minted LABEL, so the Voice canon's label rules
// bite — `banger`/`tune` (the Banger Budget), `sector` (prose-only), `eclipse`/
// `void` (identity image / nihilist), and the standard banned set must never be
// mintable onto a plan. If someone adds `banger` to a pool, this test fails the
// build before `liquid-nebula-banger` can ship.

import assert from "node:assert/strict";

import {
  BANNED,
  GALAXY_ADJECTIVES,
  GALAXY_COSMOS,
  GALAXY_SCENE,
  GALAXY_SLUG_COMBINATIONS,
  galaxySlug,
  slugify,
} from "./galaxy-slug";

const POOLS = [GALAXY_ADJECTIVES, GALAXY_COSMOS, GALAXY_SCENE];
const SLUG_SHAPE = /^[a-z]+(-[a-z]+){2}$/;

// 1. LOAD-BEARING: pools ∩ BANNED = ∅. No pool word is a banned word.
{
  for (const pool of POOLS) {
    for (const word of pool) {
      assert.equal(BANNED.has(word), false, `banned word in a pool: "${word}"`);
    }
  }
}

// 2. Every pool word is a single lowercase [a-z]+ token (so a 3-word join always
//    matches SLUG_SHAPE) and has no duplicates within its pool.
{
  for (const pool of POOLS) {
    assert.equal(new Set(pool).size, pool.length, "duplicate word within a pool");
    for (const word of pool) {
      assert.match(word, /^[a-z]+$/, `pool word not a clean [a-z]+ token: "${word}"`);
    }
  }
}

// 3. The combination space is ≥ 2000 (the ~2k target from the RFC).
{
  assert.equal(
    GALAXY_SLUG_COMBINATIONS,
    GALAXY_ADJECTIVES.length * GALAXY_COSMOS.length * GALAXY_SCENE.length,
  );
  assert.ok(
    GALAXY_SLUG_COMBINATIONS >= 2000,
    `combination count too small: ${GALAXY_SLUG_COMBINATIONS}`,
  );
}

// 4. `galaxySlug` is deterministic per (seed, attempt) and matches the slug shape.
{
  for (const seed of ["019.F.1A", "track:abc123", "", "a plan"]) {
    const first = galaxySlug(seed);
    assert.equal(first, galaxySlug(seed), `not deterministic for "${seed}"`);
    assert.equal(first, galaxySlug(seed, 0), `attempt default must equal attempt 0`);
    assert.match(first, SLUG_SHAPE, `slug shape wrong: "${first}"`);
  }
}

// 5. Two different seeds usually differ. Over many random seeds, collisions must
//    be rare (a slug space of GALAXY_SLUG_COMBINATIONS makes some collisions
//    inevitable, but the vast majority must be distinct).
{
  const slugs = new Set<string>();
  const total = 500;
  for (let index = 0; index < total; index++) {
    slugs.add(galaxySlug(`seed-${index}`));
  }
  assert.ok(slugs.size > total * 0.9, `too many collisions across seeds: ${slugs.size}/${total}`);
}

// 6. The collision re-roll changes the output: a bumped attempt yields a
//    different slug (across a run of seeds — a stray equal is fine, systematic
//    equality is the bug).
{
  let changed = 0;
  const trials = 100;
  for (let index = 0; index < trials; index++) {
    const seed = `collide-${index}`;
    if (galaxySlug(seed, 0) !== galaxySlug(seed, 1)) {
      changed++;
    }
  }
  assert.ok(changed > trials * 0.9, `re-roll rarely changes the slug: ${changed}/${trials}`);
}

// 7. `slugify` lowercases, hyphenates, and strips punctuation/diacritics.
{
  assert.equal(slugify("Liquid Nebula Roller"), "liquid-nebula-roller");
  assert.equal(slugify("  Molten — Comet!!  "), "molten-comet");
  assert.equal(slugify("Café del Mar"), "cafe-del-mar");
  assert.equal(slugify("A/B: the_mix (v2)"), "a-b-the-mix-v2");
  assert.equal(slugify("!!!"), "");
}

// eslint-disable-next-line no-console
console.log("galaxy-slug.test.ts: all checks passed");
