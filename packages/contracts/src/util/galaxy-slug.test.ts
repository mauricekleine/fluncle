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

{
  for (const pool of POOLS) {
    for (const word of pool) {
      assert.equal(BANNED.has(word), false, `banned word in a pool: "${word}"`);
    }
  }
}

{
  for (const pool of POOLS) {
    assert.equal(new Set(pool).size, pool.length, "duplicate word within a pool");
    for (const word of pool) {
      assert.match(word, /^[a-z]+$/, `pool word not a clean [a-z]+ token: "${word}"`);
    }
  }
}

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

{
  for (const seed of ["019.F.1A", "track:abc123", "", "a plan"]) {
    const first = galaxySlug(seed);
    assert.equal(first, galaxySlug(seed), `not deterministic for "${seed}"`);
    assert.equal(first, galaxySlug(seed, 0), `attempt default must equal attempt 0`);
    assert.match(first, SLUG_SHAPE, `slug shape wrong: "${first}"`);
  }
}

{
  const slugs = new Set<string>();
  const total = 500;
  for (let index = 0; index < total; index++) {
    slugs.add(galaxySlug(`seed-${index}`));
  }
  assert.ok(slugs.size > total * 0.9, `too many collisions across seeds: ${slugs.size}/${total}`);
}

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

{
  assert.equal(slugify("Liquid Nebula Roller"), "liquid-nebula-roller");
  assert.equal(slugify("  Molten — Comet!!  "), "molten-comet");
  assert.equal(slugify("Café del Mar"), "cafe-del-mar");
  assert.equal(slugify("A/B: the_mix (v2)"), "a-b-the-mix-v2");
  assert.equal(slugify("!!!"), "");
}

console.log("galaxy-slug.test.ts: all checks passed");
