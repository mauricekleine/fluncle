// Least-privilege child environment (the run registry's spawns). The daemon's own
// process.env is NOT what a child gets: the in-process admin bridge loads the
// CLI's env files via dotenv, which writes FLUNCLE_API_TOKEN (and friends) into
// process.env as a side effect — an inherited environment would hand the admin
// token to every ffprobe, show, and script the helm ever spawns. Instead every
// child starts from a minimal base (PATH, HOME, TMPDIR, LANG — snapshotted at
// module load, BEFORE any dotenv side effect can pollute them), plus the caller's
// explicit opts.env, plus — only when a run is started with `adminToken: true` —
// the CLI credentials, deliberately.

/** The only daemon env vars a child inherits. */
export const INHERITED_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

/** Snapshotted at module load, before any loadEnv/dotenv call can run. */
const BASE_ENV: Record<string, string> = pickInherited(process.env);

function pickInherited(env: Record<string, string | undefined>): Record<string, string> {
  const picked: Record<string, string> = {};

  for (const key of INHERITED_ENV_KEYS) {
    const value = env[key];

    if (value !== undefined) {
      picked[key] = value;
    }
  }

  return picked;
}

export type ChildEnvOptions = {
  /** The CLI credentials, resolved lazily and only when a run asks for them. */
  adminEnv?: () => Record<string, string | undefined>;
  /** Present the admin credentials to this child. Off by default. */
  adminToken?: boolean;
  /** The caller's explicit extras — always win. */
  extra?: Record<string, string | undefined>;
};

/**
 * The pure assembly, over an injected base — what the tests pin. Order: base →
 * admin credentials (opt-in) → the caller's explicit extras.
 */
export function buildChildEnv(
  base: Record<string, string>,
  opts: ChildEnvOptions,
): Record<string, string | undefined> {
  const admin = opts.adminToken === true && opts.adminEnv ? opts.adminEnv() : {};

  return { ...base, ...admin, ...opts.extra };
}

/** The child env for one spawn, from the pre-pollution snapshot. */
export function childEnv(opts: ChildEnvOptions): Record<string, string | undefined> {
  return buildChildEnv(BASE_ENV, opts);
}
