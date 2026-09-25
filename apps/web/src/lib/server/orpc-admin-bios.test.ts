import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const getArtistBySlug = vi.fn();
const fillEmptyArtistBio = vi.fn();
const listArtistsMissingBio = vi.fn();
const getLabelBySlug = vi.fn();
const fillEmptyLabelBio = vi.fn();
const listLabelsMissingBio = vi.fn();
const getAlbumBySlug = vi.fn();
const fillEmptyAlbumBio = vi.fn();
const listAlbumsMissingBio = vi.fn();
const fetchEntityFacts = vi.fn();
const buildEntityBioPrompt = vi.fn();
const getFindingsByArtist = vi.fn();
const getFindingsByLabel = vi.fn();
const getFindingsByAlbum = vi.fn();
const resolveBioReview = vi.fn();

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => undefined }));

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

vi.mock("./albums", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./albums")>();

  return {
    ...actual,
    fillEmptyAlbumBio: (...args: unknown[]) => fillEmptyAlbumBio(...args),
    getAlbumBySlug: (slug: string) => getAlbumBySlug(slug),
    listAlbumsMissingBio: (...args: unknown[]) => listAlbumsMissingBio(...args),
  };
});

vi.mock("./bio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bio")>();

  return {
    ...actual,
    buildEntityBioPrompt: (...args: unknown[]) => buildEntityBioPrompt(...args),
    fetchEntityFacts: (...args: unknown[]) => fetchEntityFacts(...args),
  };
});

vi.mock("./bio-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bio-review")>();

  return {
    ...actual,
    resolveBioReview: (...args: unknown[]) => resolveBioReview(...args),
  };
});

vi.mock("./tracks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracks")>();

  return {
    ...actual,
    getFindingsByAlbum: (...args: unknown[]) => getFindingsByAlbum(...args),
    getFindingsByArtist: (...args: unknown[]) => getFindingsByArtist(...args),
    getFindingsByLabel: (...args: unknown[]) => getFindingsByLabel(...args),
  };
});

beforeAll(() => {
  setAdminTokenEnv();
});

warmOrpcRouter();

const ARTIST = { id: "artist-1", mbid: undefined, name: "Calibre", slug: "calibre" };
const LABEL = { id: "label-1", logoImageUrl: undefined, name: "Signature", slug: "signature" };
const ALBUM = { id: "album-1", name: "Second Sun", slug: "second-sun" };

const GOOD_BIO =
  "One of the names I keep coming back to when the rollers need to breathe. The drums do the talking, and I have logged enough of them to trust the stamp.";

beforeEach(() => {
  getArtistBySlug.mockReset();
  fillEmptyArtistBio.mockReset();
  listArtistsMissingBio.mockReset();
  getLabelBySlug.mockReset();
  fillEmptyLabelBio.mockReset();
  listLabelsMissingBio.mockReset();
  getAlbumBySlug.mockReset();
  fillEmptyAlbumBio.mockReset();
  listAlbumsMissingBio.mockReset();
  fetchEntityFacts.mockReset();
  buildEntityBioPrompt.mockReset();
  getFindingsByArtist.mockReset();
  getFindingsByLabel.mockReset();
  getFindingsByAlbum.mockReset();
  resolveBioReview.mockReset();
});

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

    expect(fillEmptyArtistBio).toHaveBeenCalledWith("calibre", GOOD_BIO, 3, null);
  });

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

    expect(fillEmptyArtistBio).not.toHaveBeenCalled();
  });

  it("reports skipped (never clobbers) when it LOSES the fill-empty race", async () => {
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

describe("the final-attempt bypass reaches the store as a review flag", () => {
  const REFUSED_BIO =
    "A clean transmission of rolling menace, and I have logged plenty of them here.";

  it("hands the accepted violations to the fill, so the bypass raises a review row", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);
    fillEmptyArtistBio.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, {
        bio: REFUSED_BIO,
        finalAttempt: true,
        promptVersion: 2,
      }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as {
      gateBypassed?: boolean;
      voiceViolations?: string[];
    };
    expect(data.gateBypassed).toBe(true);
    expect(data.voiceViolations?.length ?? 0).toBeGreaterThan(0);

    expect(fillEmptyArtistBio).toHaveBeenCalledWith(
      "calibre",
      REFUSED_BIO,
      2,
      data.voiceViolations,
    );
  });

  it("carries the flag on a bypassed label and album bio too", async () => {
    getLabelBySlug.mockResolvedValueOnce(LABEL);
    fillEmptyLabelBio.mockResolvedValueOnce(true);
    getAlbumBySlug.mockResolvedValueOnce(ALBUM);
    fillEmptyAlbumBio.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(
      req("/admin/labels/signature/bio", "POST", AGENT_TOKEN, {
        bio: REFUSED_BIO,
        finalAttempt: true,
      }),
    );
    await handleOrpc(
      req("/admin/albums/second-sun/bio", "POST", AGENT_TOKEN, {
        bio: REFUSED_BIO,
        finalAttempt: true,
      }),
    );

    expect(fillEmptyLabelBio.mock.calls[0]?.[3]).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(fillEmptyAlbumBio.mock.calls[0]?.[3]).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it("raises no review when the final attempt's draft actually clears the gate", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);
    fillEmptyArtistBio.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, {
        bio: GOOD_BIO,
        finalAttempt: true,
      }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { gateBypassed?: boolean };
    expect(data.gateBypassed).toBeUndefined();
    expect(fillEmptyArtistBio).toHaveBeenCalledWith("calibre", GOOD_BIO, undefined, null);
  });

  it("still 422s a final attempt that is too short to be a paragraph", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artists/calibre/bio", "POST", AGENT_TOKEN, {
        bio: "Too short.",
        finalAttempt: true,
      }),
    );

    expect(response?.status).toBe(422);
    expect(fillEmptyArtistBio).not.toHaveBeenCalled();
  });
});

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
    expect(fillEmptyLabelBio).toHaveBeenCalledWith("signature", GOOD_BIO, undefined, null);
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

describe("oRPC describe_album (POST /admin/albums/{slug}/bio)", () => {
  it("fills an EMPTY album bio (agent), voice-gated", async () => {
    getAlbumBySlug.mockResolvedValueOnce(ALBUM);
    fillEmptyAlbumBio.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/albums/second-sun/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { bio: string; slug: string };
    expect(data.slug).toBe("second-sun");
    expect(fillEmptyAlbumBio).toHaveBeenCalledWith("second-sun", GOOD_BIO, undefined, null);
  });

  it("NEVER overwrites an existing album bio — skipped no-op", async () => {
    getAlbumBySlug.mockResolvedValueOnce({ ...ALBUM, bio: "The operator's own album bio." });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/albums/second-sun/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { bio: string; skipped?: boolean };
    expect(data.skipped).toBe(true);
    expect(data.bio).toBe("The operator's own album bio.");
    expect(fillEmptyAlbumBio).not.toHaveBeenCalled();
  });

  it("404s an unknown album slug", async () => {
    getAlbumBySlug.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/albums/nope/bio", "POST", AGENT_TOKEN, { bio: GOOD_BIO }),
    );

    expect(response?.status).toBe(404);
  });
});

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

  it("list_albums_missing_bio returns the worklist rows", async () => {
    listAlbumsMissingBio.mockResolvedValueOnce([
      { id: "al1", name: "Second Sun", slug: "second-sun" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/albums/bio-queue?limit=10", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { albums: { slug: string }[] };
    expect(data.albums).toEqual([{ id: "al1", name: "Second Sun", slug: "second-sun" }]);
  });
});

type BioDraft = {
  findingCount: number;
  found: boolean;
  hasFacts: boolean;
  name: string;
  prompt: string;
  promptVersion: number;
};

describe("draft_artist_bio (GET /admin/artists/{slug}/bio-draft)", () => {
  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/artists/calibre/bio-draft", "GET", undefined));

    expect(response?.status).toBe(401);
  });

  it("assembles the prompt from Firecrawl facts + finding titles (hasFacts true)", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);
    getFindingsByArtist.mockResolvedValueOnce([{ title: "Iron Heart" }, { title: "Mr Right On" }]);
    fetchEntityFacts.mockResolvedValueOnce({ facts: "A producer on Signature.", sources: ["u"] });
    buildEntityBioPrompt.mockResolvedValueOnce({ body: "THE ASSEMBLED PROMPT", version: 3 });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/artists/calibre/bio-draft", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as BioDraft;
    expect(data.found).toBe(true);
    expect(data.name).toBe("Calibre");
    expect(data.findingCount).toBe(2);
    expect(data.prompt).toBe("THE ASSEMBLED PROMPT");
    expect(data.promptVersion).toBe(3);
    expect(data.hasFacts).toBe(true);

    expect(buildEntityBioPrompt).toHaveBeenCalledWith({
      facts: "A producer on Signature.",
      findingTitles: ["Iron Heart", "Mr Right On"],
      kind: "artist",
      name: "Calibre",
    });
  });

  it("reports hasFacts:false when Firecrawl gathered nothing", async () => {
    getArtistBySlug.mockResolvedValueOnce(ARTIST);
    getFindingsByArtist.mockResolvedValueOnce([{ title: "Iron Heart" }]);
    fetchEntityFacts.mockResolvedValueOnce(null);
    buildEntityBioPrompt.mockResolvedValueOnce({ body: "PROMPT (no facts)", version: 0 });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/artists/calibre/bio-draft", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as BioDraft;
    expect(data.hasFacts).toBe(false);
    expect(data.prompt).toBe("PROMPT (no facts)");
    expect(buildEntityBioPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ facts: null, kind: "artist" }),
    );
  });

  it("returns found:false for an unknown slug (never throws)", async () => {
    getArtistBySlug.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/artists/nope/bio-draft", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as BioDraft;
    expect(data.found).toBe(false);
    expect(data.prompt).toBe("");
    expect(fetchEntityFacts).not.toHaveBeenCalled();
    expect(buildEntityBioPrompt).not.toHaveBeenCalled();
  });
});

describe("draft_label_bio (GET /admin/labels/{slug}/bio-draft)", () => {
  it("assembles the label prompt from facts + finding titles", async () => {
    getLabelBySlug.mockResolvedValueOnce(LABEL);
    getFindingsByLabel.mockResolvedValueOnce([{ title: "Mr Right On" }]);
    fetchEntityFacts.mockResolvedValueOnce({ facts: "A London imprint.", sources: ["u"] });
    buildEntityBioPrompt.mockResolvedValueOnce({ body: "LABEL PROMPT", version: 0 });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/labels/signature/bio-draft", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as BioDraft;
    expect(data.found).toBe(true);
    expect(data.name).toBe("Signature");
    expect(data.findingCount).toBe(1);
    expect(data.prompt).toBe("LABEL PROMPT");
    expect(data.hasFacts).toBe(true);
    expect(buildEntityBioPrompt).toHaveBeenCalledWith({
      facts: "A London imprint.",
      findingTitles: ["Mr Right On"],
      kind: "label",
      name: "Signature",
    });
  });

  it("returns found:false for an unknown label slug", async () => {
    getLabelBySlug.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/labels/nope/bio-draft", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as BioDraft;
    expect(data.found).toBe(false);
    expect(buildEntityBioPrompt).not.toHaveBeenCalled();
  });
});

describe("draft_album_bio (GET /admin/albums/{slug}/bio-draft)", () => {
  it("assembles the album prompt from facts + finding titles", async () => {
    getAlbumBySlug.mockResolvedValueOnce(ALBUM);
    getFindingsByAlbum.mockResolvedValueOnce([{ title: "Higher Ground" }]);
    fetchEntityFacts.mockResolvedValueOnce({ facts: "A 2019 album.", sources: ["u"] });
    buildEntityBioPrompt.mockResolvedValueOnce({ body: "ALBUM PROMPT", version: 0 });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/albums/second-sun/bio-draft", "GET", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as BioDraft;
    expect(data.found).toBe(true);
    expect(data.name).toBe("Second Sun");
    expect(data.findingCount).toBe(1);
    expect(data.prompt).toBe("ALBUM PROMPT");
    expect(data.hasFacts).toBe(true);
    expect(buildEntityBioPrompt).toHaveBeenCalledWith({
      facts: "A 2019 album.",
      findingTitles: ["Higher Ground"],
      kind: "album",
      name: "Second Sun",
    });
  });

  it("returns found:false for an unknown album slug", async () => {
    getAlbumBySlug.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/albums/nope/bio-draft", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as BioDraft;
    expect(data.found).toBe(false);
    expect(buildEntityBioPrompt).not.toHaveBeenCalled();
  });
});

describe("oRPC resolve_bio_review (POST /admin/bio-reviews/{kind}/{slug}/resolve)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/bio-reviews/artist/calibre/resolve", "POST", undefined, { resolution: "keep" }),
    );

    expect(response?.status).toBe(401);
    expect(resolveBioReview).not.toHaveBeenCalled();
  });

  it("403s the AGENT token — the agent authors, only the operator overrules the gate", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/bio-reviews/artist/calibre/resolve", "POST", AGENT_TOKEN, {
        resolution: "rewrite",
      }),
    );

    expect(response?.status).toBe(403);
    expect(resolveBioReview).not.toHaveBeenCalled();
  });

  it("keeps a bypassed bio for the operator", async () => {
    resolveBioReview.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/bio-reviews/artist/future-signal/resolve", "POST", OPERATOR_TOKEN, {
        resolution: "keep",
      }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { ok: boolean; resolution: string; slug: string };
    expect(data.ok).toBe(true);
    expect(data.resolution).toBe("keep");
    expect(data.slug).toBe("future-signal");
    expect(resolveBioReview).toHaveBeenCalledWith({
      kind: "artist",
      resolution: "keep",
      slug: "future-signal",
    });
  });

  it("sends a label bio back for a rewrite", async () => {
    resolveBioReview.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/bio-reviews/label/invaderz/resolve", "POST", OPERATOR_TOKEN, {
        resolution: "rewrite",
      }),
    );

    expect(response?.status).toBe(200);
    expect(resolveBioReview).toHaveBeenCalledWith({
      kind: "label",
      resolution: "rewrite",
      slug: "invaderz",
    });
  });

  it("404s when nothing is under review for that entity", async () => {
    resolveBioReview.mockResolvedValueOnce(false);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/bio-reviews/album/second-sun/resolve", "POST", OPERATOR_TOKEN, {
        resolution: "keep",
      }),
    );

    expect(response?.status).toBe(404);
  });

  it("rejects an unknown entity kind at the contract boundary", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/bio-reviews/mixtape/whatever/resolve", "POST", OPERATOR_TOKEN, {
        resolution: "keep",
      }),
    );

    expect(response?.status).toBe(400);
    expect(resolveBioReview).not.toHaveBeenCalled();
  });
});
