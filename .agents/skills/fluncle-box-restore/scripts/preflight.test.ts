import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  REQUIRED_REPO_ASSETS,
  ageInDays,
  exitCodeFor,
  latestDatedFolder,
  redactTopology,
  resolveLabsDir,
  resolveRepoRoot,
  scanSecretTemplate,
  summariseDrillReport,
  validateBoxStateKey,
  validateBoxStateManifest,
  type CheckResult,
} from "./preflight";

const check = (status: CheckResult["status"]): CheckResult => ({
  detail: "",
  id: status,
  status,
  title: "",
});

describe("resolveRepoRoot", () => {
  test("finds the repo from this script's own directory", () => {
    const root = resolveRepoRoot(import.meta.dir);
    expect(root).toBeString();
    expect(existsSync(join(root ?? "", "docs/agents/hermes/scripts/backup-sweep.ts"))).toBe(true);
  });

  test("returns undefined outside a Fluncle checkout", () => {
    expect(resolveRepoRoot("/")).toBeUndefined();
  });
});

describe("REQUIRED_REPO_ASSETS", () => {
  // The whole point of the skill is that a rebuild never has to hunt for its assets. If one of
  // these moves, this test fails HERE rather than at 3am with the box gone.
  test("every listed asset exists in this checkout", () => {
    const root = resolveRepoRoot(import.meta.dir) ?? "";
    const missing = REQUIRED_REPO_ASSETS.filter((path) => !existsSync(join(root, path)));
    expect(missing).toEqual([]);
  });
});

describe("latestDatedFolder", () => {
  const prefix = "box-state/daily/";

  test("picks the newest date regardless of listing order", () => {
    expect(
      latestDatedFolder(
        [
          `${prefix}2026-07-24/box-state.tar.gz.enc`,
          `${prefix}2026-07-26/manifest.json`,
          `${prefix}2026-07-25/manifest.json`,
        ],
        prefix,
      ),
    ).toBe("2026-07-26");
  });

  test("accepts a monthly YYYY-MM folder", () => {
    expect(latestDatedFolder(["box-state/monthly/2026-07/x"], "box-state/monthly/")).toBe(
      "2026-07",
    );
  });

  test("ignores keys outside the prefix and non-date folders", () => {
    expect(
      latestDatedFolder([`${prefix}not-a-date/x`, "db-backups/daily/2030-01-01/x"], prefix),
    ).toBeUndefined();
  });

  test("returns undefined for an empty listing", () => {
    expect(latestDatedFolder([], prefix)).toBeUndefined();
  });
});

describe("ageInDays", () => {
  const now = new Date("2026-07-26T09:00:00Z");

  test("counts whole UTC days", () => {
    expect(ageInDays("2026-07-26", now)).toBe(0);
    expect(ageInDays("2026-07-23", now)).toBe(3);
  });

  test("clamps a future folder to zero rather than reporting a negative age", () => {
    expect(ageInDays("2026-08-01", now)).toBe(0);
  });

  test("an unparseable date is infinitely old, never fresh", () => {
    expect(ageInDays("nonsense", now)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("validateBoxStateKey", () => {
  test("accepts 64 hex chars", () => {
    expect(validateBoxStateKey("a".repeat(64))).toEqual({ bytes: 32, ok: true });
  });

  test("accepts a 32-byte base64 key", () => {
    expect(validateBoxStateKey(Buffer.alloc(32, 7).toString("base64")).ok).toBe(true);
  });

  test("rejects an absent key — with no key there is no artifact at all", () => {
    expect(validateBoxStateKey(undefined).ok).toBe(false);
    expect(validateBoxStateKey("   ").reason).toBe("not set");
  });

  test("rejects a key of the wrong length", () => {
    const verdict = validateBoxStateKey("abcd");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("not 32");
  });
});

describe("validateBoxStateManifest", () => {
  const good = JSON.stringify({
    archiveBytes: 4096,
    cipherBytes: 4124,
    encryption: "AES-256-GCM",
    entries: [
      { bytes: 2048, path: "state.db" },
      { bytes: 2048, path: "memories/a.md" },
    ],
    entryCount: 2,
    generatedAt: "2026-07-26T02:00:00.000Z",
    root: "/opt/data",
    sha256: "0".repeat(64),
  });

  test("accepts a well-formed manifest", () => {
    const verdict = validateBoxStateManifest(good);
    expect(verdict.ok).toBe(true);
    expect(verdict.entryCount).toBe(2);
    expect(verdict.cipherBytes).toBe(4124);
  });

  test("rejects non-JSON", () => {
    expect(validateBoxStateManifest("<html>403</html>").ok).toBe(false);
  });

  test("rejects a missing digest", () => {
    const parsed = JSON.parse(good) as Record<string, unknown>;
    parsed.sha256 = "short";
    const verdict = validateBoxStateManifest(JSON.stringify(parsed));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("sha256");
  });

  test("catches an entryCount that disagrees with the entry list", () => {
    const parsed = JSON.parse(good) as Record<string, unknown>;
    parsed.entryCount = 9;
    expect(validateBoxStateManifest(JSON.stringify(parsed)).problems.join(" ")).toContain(
      "disagrees",
    );
  });

  test("rejects an empty archive", () => {
    const parsed = JSON.parse(good) as Record<string, unknown>;
    parsed.entries = [];
    expect(validateBoxStateManifest(JSON.stringify(parsed)).ok).toBe(false);
  });
});

describe("scanSecretTemplate", () => {
  // Every reference below is a PLACEHOLDER (`op://<…>/…`), never a concrete vault path — this
  // repo is public and CI greps the working tree for `op://` followed by an alphanumeric.
  test("separates op:// references from literals and never returns a literal value", () => {
    const scan = scanSecretTemplate(
      [
        "# the gateway env",
        "",
        "OPENROUTER_API_KEY=op://<vault>/<item>/credential",
        'export FLUNCLE_API_TOKEN="op://<vault>/<other-item>/credential"',
        // Both spellings are pointers `op inject` resolves, and a real vault name has spaces in
        // it — a matcher that misses either form cries "leak" over the whole template.
        "MOUSTACHE_FORM={{ op://<some vault>/<item>/credential }}",
        "SPACED_BARE_FORM=op://<some vault>/<item>/credential",
        "LEAKED_TOKEN=sk-live-realvalue",
        "EMPTY=",
      ].join("\n"),
    );
    expect(scan.refKeys).toEqual([
      "OPENROUTER_API_KEY",
      "FLUNCLE_API_TOKEN",
      "MOUSTACHE_FORM",
      "SPACED_BARE_FORM",
    ]);
    expect(scan.literalKeys).toEqual(["LEAKED_TOKEN"]);
    expect(JSON.stringify(scan)).not.toContain("sk-live-realvalue");
  });

  test("ignores comments and blank lines", () => {
    expect(scanSecretTemplate("# nothing\n\n   \n").refKeys).toEqual([]);
  });
});

describe("redactTopology", () => {
  // Both children whose stderr this report repeats name the map in their failure text, and the
  // report is agent-facing — one paste from a public issue. Diagnostics survive, topology does not.
  test("strips the op:// reference `op` quotes when a ref will not resolve", () => {
    const redacted = redactTopology(
      '[ERROR] "Private Vault" isn\'t a vault: op://<private vault>/<item>/credential',
    );
    expect(redacted).not.toContain("/<item>/credential");
    expect(redacted).toContain("op://<redacted>");
    expect(redacted).toContain("isn't a vault");
  });

  test("a vault name with spaces does not leave the rest of the path behind", () => {
    expect(redactTopology("op://<some long vault name>/<item>/credential")).toBe("op://<redacted>");
  });

  test("strips the bucket endpoint the restore drill quotes on a failed read", () => {
    const redacted = redactTopology(
      "GET https://abc123.r2.cloudflarestorage.com/secret-bucket/box-state failed (403)",
    );
    expect(redacted).not.toContain("r2.cloudflarestorage.com");
    expect(redacted).not.toContain("secret-bucket");
    expect(redacted).toContain("<redacted-url>");
    expect(redacted).toContain("failed (403)");
  });

  test("leaves topology-free diagnostics alone", () => {
    expect(redactTopology("could not authenticate; sign in and retry")).toBe(
      "could not authenticate; sign in and retry",
    );
  });
});

describe("summariseDrillReport", () => {
  test("parses the drill's pretty-printed report rather than tailing its closing brace", () => {
    const summary = summariseDrillReport(
      JSON.stringify(
        {
          entryCount: 11,
          generatedAt: "2026-07-26T02:00:00.000Z",
          object: "box-state/daily/2026-07-26/box-state.tar.gz.enc",
          ok: true,
          restoredBytes: 6438949,
          tamperDetected: true,
        },
        null,
        2,
      ),
    );
    expect(summary).toContain("entryCount=11");
    expect(summary).toContain("tamperDetected=true");
    expect(summary).not.toBe("}");
  });

  test("degrades to a readable phrase when the report is not JSON", () => {
    expect(summariseDrillReport("not json")).toBe("verified, decrypted and unpacked");
  });
});

describe("resolveLabsDir", () => {
  test("returns undefined when no candidate holds the box doc dir", () => {
    expect(resolveLabsDir("/nowhere/repo", "/nowhere/labs", {}, "/nowhere/home")).toBeUndefined();
  });
});

describe("exitCodeFor", () => {
  test("clean run exits 0", () => {
    expect(exitCodeFor([check("pass"), check("pass")])).toBe(0);
  });

  test("a failure wins over an unknown", () => {
    expect(exitCodeFor([check("pass"), check("unknown"), check("fail")])).toBe(1);
  });

  test("unverified is never reported as healthy", () => {
    expect(exitCodeFor([check("pass"), check("unknown")])).toBe(2);
  });
});
