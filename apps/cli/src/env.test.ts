import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The credential half of the no-network rail (the transport half is packages/test-support).
//
// `loadEnv` reads `~/.config/fluncle/.env.<profile>`, and the operator's `production`
// profile holds a real ADMIN token against www.fluncle.com. A test run must never see it:
// one validation regression, or a new test that forgets to point at a fixture server, and
// the suite fires a real admin command at the live archive.
//
// Proven in a subprocess with a SYNTHETIC $HOME, so this exercises the real file-reading
// path (and asserts the load still works when it should) without ever touching the
// operator's own config.

const envModule = new URL("./env.ts", import.meta.url).pathname;

async function fakeHomeWithProfile(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fluncle-env-rail-"));

  await mkdir(join(home, ".config/fluncle"), { recursive: true });
  await writeFile(
    join(home, ".config/fluncle/.env.production"),
    "FLUNCLE_API_TOKEN=synthetic-token-for-this-test\n",
  );

  return home;
}

async function readTokenAfterLoad(home: string, nodeEnv: string | undefined): Promise<string> {
  const source = `
    const { loadEnv } = await import(${JSON.stringify(envModule)});
    try {
      const loaded = loadEnv(["FLUNCLE_API_TOKEN"]);
      process.stdout.write(loaded.FLUNCLE_API_TOKEN);
    } catch {
      process.stdout.write("MISSING");
    }
  `;

  const env: Record<string, string> = { ...process.env, HOME: home };

  delete env.FLUNCLE_API_TOKEN;
  delete env.NODE_ENV;

  if (nodeEnv !== undefined) {
    env.NODE_ENV = nodeEnv;
  }

  const proc = Bun.spawn([process.execPath, "-e", source], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  return stdout.trim();
}

describe("the credential rail on the CLI's env profile", () => {
  test("does NOT read the operator's profile when NODE_ENV is test", async () => {
    const home = await fakeHomeWithProfile();

    expect(await readTokenAfterLoad(home, "test")).toBe("MISSING");
  });

  test("still reads the profile for a real run, so nothing changes outside tests", async () => {
    const home = await fakeHomeWithProfile();

    expect(await readTokenAfterLoad(home, undefined)).toBe("synthetic-token-for-this-test");
  });
});
