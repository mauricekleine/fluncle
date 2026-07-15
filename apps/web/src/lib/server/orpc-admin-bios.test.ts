import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// The entity-bio engine driven end-to-end through `handleOrpc` against
// `/api/v1/admin/{artists,labels}/{slug}/bio`, so the REAL admin auth spine
// (../orpc-auth: `adminAuth`) + the REAL voice gate (../bio: `gateBioText`) run; only the
// entity data layer (Turso reads/writes) is mocked. This is the security-critical half:
//   - the AGENT tier (adminAuth) authenticates the box sweep; no token = 401.
//   - the VOICE gate re-scans server-side and 422s a violation before storing.
//   - THE CARDINAL SAFETY GUARANTEE: an existing bio is NEVER overwritten — the agent
//     fills an EMPTY bio only, enforced both by the fast-path skip and (race-safe) by the
//     `fillEmpty*Bio` DB predicate, whose lost-race path reports `skipped`, never clobbers.

const getArtistBySlug = vi.fn();
const fillEmptyArtistBio = vi.fn();
const listArtistsMissingBio = vi.fn();
const getLabelBySlug = vi.fn();
const fillEmptyLabelBio = vi.fn();
const listLabelsMissingBio = vi.fn();

// The router graph imports `env` from cloudflare:workers at module load; stub it so the
// import resolves in the test runtime (this suite touches no Worker binding).
vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("./artists", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./artists")>();

  return {
    ...actual,
    fillEmptyArtistBio: (...args: unknown[]) => fillEmptyArtistBio(...args),
    getArtistBySlug: (slug: string) => getArtistBySlug(slug),
    listArtistsMissingBio: (...args: unknown[]) => listArtistsMissingBio(...args),
  };
});

vi.mock("./labels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./labels")>();

  return {
    ...actual,
    fillEmptyLabelBio: (...args: unknown[]) => fillEmptyLabelBio(...args),
    getLabelBySlug: (slug: string) => getLabelBySlug(slug),
    listLabelsMissingBio: (...args: unknown[]) => listLabelsMissingBio(...args),
  };
});

beforeAll(() => {
  setAdminTokenEnv();
});

const ARTIST = { id: "artist-1", mbid: undefined, name: "Calibre", slug: "calibre" };
const LABEL = { id: "label-1", logoImageUrl: undefined, name: "Signature", slug: "signature" };

// A clean, dry, in-voice bio (clears the real voice gate + the length bounds).
const GOOD_BIO =
  "One of the names I keep coming back to when the rollers need to breathe. The drums do the talking, and I have logged enough of them to trust the stamp.";

beforeEach(() => {
  getArtistBySlug.mockReset();
  fillEmptyArtistBio.mockReset();
  listArtistsMissingBio.mockReset();
  getLabelBySlug.mockReset();
  fillEmptyLabelBio.mockReset();
  listLabelsMissingBio.mockReset();
});

// ── describe_artist ───────────────────────────────────────────────────────────
describe("oRPC describe_artist (POST /admin/artists/{slug}/bio)", () => {
  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", undefined, { bio: GOOD_BIO }),
    );

    expect(response?.status).toBe(401);
  });

  it("fills an EMPTY bio (agent), voice-gated, with its provenance version", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);
    fillEmptyArtistBio.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO, promptVersion: 3 }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { bio: string; ok: boolean; slug: string };
    expect(data.slug).toBe("calibre");
    expect(data.bio).toBe(GOOD_BIO);
    expect(fillEmptyArtistBio).toHaveBeenCalledWith("calibre", GOOD_BIO, 3);
  });

  // THE CARDINAL SAFETY GUARANTEE: an existing bio is NEVER clobbered.
  it("NEVER overwrites an existing bio — it is a skipped no-op", async () => {
    getArtistBySlug.mockResolvedValueOnce({ ...ARTIST, bio: "The operator's own bio." });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, {
        bio: "A DIFFERENT auto-authored bio that must not land.",
      }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { bio: string; skipped?: boolean };
    expect(data.skipped).toBe(true);
    expect(data.bio).toBe("The operator's own bio.");
    // CRITICAL: the fill was never even attempted — the operator override wins.
    expect(fillEmptyArtistBio).not.toHaveBeenCalled();
  });

  it("reports skipped (never clobbers) when it LOSES the fill-empty race", async () => {
    // The read saw an empty bio, but a bio landed before the atomic write: the predicate
    // matched no row, so fillEmptyArtistBio returns false and we re-read the winner.
    getArtistBySlug
      .mockResolvedValueOnce(ARTIST)
      .mockResolvedValueOnce({ ...ARTIST, bio: "The bio that won the race." });
    fillEmptyArtistBio.mockResolvedValueOnce(false);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { bio: string; skipped?: boolean };
    expect(data.skipped).toBe(true);
    expect(data.bio).toBe("The bio that won the race.");
  });

  it("422s a bio with a banned identity word before storing (the voice gate)", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, {
        bio: "A clean transmission of rolling menace, and I have logged plenty of them here.",
      }),
    );

    expect(response?.status).toBe(422);
    expect(fillEmptyArtistBio).not.toHaveBeenCalled();
  });

  it("422s a bio over the length ceiling", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, { bio: "ok ".repeat(260) }),
    );

    expect(response?.status).toBe(422);
    expect(fillEmptyArtistBio).not.toHaveBeenCalled();
  });

  it("404s an unknown slug", async () => {
    getArtistBySlug.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/nope/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO }),
    );

    expect(response?.status).toBe(404);
  });

  it("dry-run voice-gates and stores NOTHING", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO, dryRun: true }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { bio: string; dryRun?: boolean };
    expect(data.dryRun).toBe(true);
    expect(data.bio).toBe(GOOD_BIO);
    expect(fillEmptyArtistBio).not.toHaveBeenCalled();
  });
});

// ── describe_label (parity) ─────────────────────────────────────────────────────
describe("oRPC describe_label (POST /admin/labels/{slug}/bio)", () => {
  it("fills an EMPTY label bio (agent), voice-gated", async () => {
    getLabelBySlug.mockResolvedValueOnce(LABEL);
    fillEmptyLabelBio.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/labels/signature/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { bio: string; slug: string };
    expect(data.slug).toBe("signature");
    expect(fillEmptyLabelBio).toHaveBeenCalledWith("signature", GOOD_BIO, undefined);
  });

  it("NEVER overwrites an existing label bio — skipped no-op", async () => {
    getLabelBySlug.mockResolvedValueOnce({ ...LABEL, bio: "The operator's own label bio." });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/labels/signature/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { bio: string; skipped?: boolean };
    expect(data.skipped).toBe(true);
    expect(data.bio).toBe("The operator's own label bio.");
    expect(fillEmptyLabelBio).not.toHaveBeenCalled();
  });
});

// ── the bio worklists ───────────────────────────────────────────────────────────
describe("the bio worklists (agent-tier reads)", () => {
  it("list_artists_missing_bio returns the worklist rows", async () => {
    listArtistsMissingBio.mockResolvedValueOnce([{ id: "a1", name: "Calibre", slug: "calibre" }]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/artists/bio-queue?limit=10", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { artists: { slug: string }[] };
    expect(data.artists).toEqual([{ id: "a1", name: "Calibre", slug: "calibre" }]);
  });

  it("list_labels_missing_bio returns the worklist rows", async () => {
    listLabelsMissingBio.mockResolvedValueOnce([
      { id: "l1", name: "Signature", slug: "signature" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/labels/bio-queue?limit=10", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { labels: { slug: string }[] };
    expect(data.labels).toEqual([{ id: "l1", name: "Signature", slug: "signature" }]);
  });
});
