import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const envModule = new URL("./env.ts", import.meta.url).pathname;

async function fakeHomeWithProfile(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fluncle-env-rail-"));

  try {
    await mkdir(join(home, ".config/fluncle"), { recursive: true });
    await writeFile(
      join(home, ".config/fluncle/.env.production"),
      "FLUNCLE_API_TOKEN=synthetic-token-for-this-test\n",
    );

    return home;
  } catch (error) {
    await rm(home, { force: true, recursive: true });
    throw error;
  }
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
  delete env.FLUNCLE_API_TOKEN_REF;
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

    try {
      expect(await readTokenAfterLoad(home, "test")).toBe("MISSING");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("still reads the profile for a real run, so nothing changes outside tests", async () => {
    const home = await fakeHomeWithProfile();

    try {
      expect(await readTokenAfterLoad(home, undefined)).toBe("synthetic-token-for-this-test");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});

async function readTokenWithRef(
  opScript: string,
  ref = "op://<vault>/<item>/credential",
  nodeEnv?: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fluncle-env-ref-"));

  try {
    await writeFile(join(dir, "op"), opScript, { mode: 0o755 });

    const source = `
      const { loadEnv } = await import(${JSON.stringify(envModule)});
      try {
        process.stdout.write(loadEnv(["FLUNCLE_API_TOKEN"]).FLUNCLE_API_TOKEN);
      } catch (error) {
        process.stdout.write("ERROR " + error.message);
      }
    `;
    const env: Record<string, string> = {
      ...process.env,
      FLUNCLE_API_TOKEN_REF: ref,
      HOME: dir,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    };

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
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("FLUNCLE_API_TOKEN_REF", () => {
  test("reads the token through op when the env and profile have none", async () => {
    const token = await readTokenWithRef(
      '#!/bin/sh\n[ "$1 $2 $3" = "read --no-newline op://<vault>/<item>/credential" ] && printf synthetic-ref-token\n',
    );

    expect(token).toBe("synthetic-ref-token");
  });

  test("adds the op:// scheme to a path-only reference", async () => {
    const token = await readTokenWithRef(
      '#!/bin/sh\n[ "$3" = "op://<vault>/<item>/credential" ] && printf synthetic-ref-token\n',
      "<vault>/<item>/credential",
    );

    expect(token).toBe("synthetic-ref-token");
  });

  test("never resolves a reference in test mode", async () => {
    const message = await readTokenWithRef(
      "#!/bin/sh\nprintf synthetic-ref-token\n",
      "op://<vault>/<item>/credential",
      "test",
    );

    expect(message).toBe("ERROR Missing required env vars: FLUNCLE_API_TOKEN");
  });

  test("names the reference, never a value, when op fails", async () => {
    const message = await readTokenWithRef("#!/bin/sh\nexit 1\n");

    expect(message).toBe(
      "ERROR Could not read FLUNCLE_API_TOKEN_REF (op://<vault>/<item>/credential) with op.",
    );
  });
});
