import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STRAIN_COUNTER_KEYS, STRAIN_RATE_COUNTERS } from "./fluncle-healthcheck";

type EmitterProof = { file: string; patterns: readonly RegExp[] };

const COUNTER_EMITTER_PROOFS: Readonly<Record<string, EmitterProof>> = {
  errors: {
    file: "sentry-triage-sweep.ts",
    patterns: [/JSON\.stringify\(\{\s*errors:\s*errors\.length,/],
  },
  gateSkipped: {
    file: "entity-bio-sweep.ts",
    patterns: [
      /\bgateSkipped:\s*0,/,

      /JSON\.stringify\(\{\s*ok:[^,]+,\s*\.\.\.summary\s*\}\)/,
    ],
  },
};

const RATE_COUNTER_EMITTER_PROOFS: Readonly<Record<string, EmitterProof>> = {
  failed: {
    file: "crawl-sweep.ts",
    patterns: [
      /const attemptedFailures = Number\(result\.failed \?\? 0\)/,
      /summary\.failed \+= Math\.max\(0, attemptedFailures - \(result\.rateLimited === true \? 1 : 0\)\)/,
      /summary\.checked \+= expanded \+ attemptedFailures/,
    ],
  },
};

describe("strain counter vocabulary coverage", () => {
  test("every configured counter is emitted by at least one sweep summary", () => {
    const unproven: string[] = [];

    for (const key of STRAIN_COUNTER_KEYS) {
      const proof = COUNTER_EMITTER_PROOFS[key];

      if (proof === undefined) {
        unproven.push(key);

        continue;
      }

      const source = readFileSync(join(import.meta.dir, proof.file), "utf8");

      if (proof.patterns.some((pattern) => !pattern.test(source))) {
        unproven.push(key);
      }
    }

    expect(unproven).toEqual([]);
  });

  test("every rate counter has a source-verified numerator and denominator", () => {
    const unproven: string[] = [];

    for (const { denominator, numerator } of STRAIN_RATE_COUNTERS) {
      const proof = RATE_COUNTER_EMITTER_PROOFS[numerator];

      if (proof === undefined) {
        unproven.push(`${numerator}/${denominator}`);

        continue;
      }

      const source = readFileSync(join(import.meta.dir, proof.file), "utf8");

      if (proof.patterns.some((pattern) => !pattern.test(source))) {
        unproven.push(`${numerator}/${denominator}`);
      }
    }

    expect(unproven).toEqual([]);
  });
});
