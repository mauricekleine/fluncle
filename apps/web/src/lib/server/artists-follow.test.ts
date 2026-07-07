import { beforeEach, describe, expect, it, vi } from "vitest";

// The auto-follow sweep (Epic B, Unit 5): `followPendingArtists` follows a bounded batch
// of high-confidence artists across Spotify + YouTube, idempotent by `followed_at IS
// NULL`, and stamps the follow. Spotify + YouTube are MOCKED here — a test never hits a
// real platform. The DB is mocked with a SQL-dispatching `execute`.

const execute = vi.fn();
const followSpotifyArtist = vi.fn();
const resolveYouTubeChannelId = vi.fn();
const subscribeToYouTubeChannel = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./spotify", () => ({ followSpotifyArtist }));
vi.mock("./youtube", () => ({ resolveYouTubeChannelId, subscribeToYouTubeChannel }));

type PendingRow = {
  social_id: string;
  platform: "spotify" | "youtube";
  url: string;
  artist_id: string;
  name: string;
  spotify_artist_id: string | null;
};

// Wire `execute` to answer the sweep's three query shapes: the pending SELECT, the
// per-target followed_at UPDATE (recorded), and the remaining COUNT.
function wireDb(pending: PendingRow[], remaining: number) {
  const updates: string[] = [];

  execute.mockImplementation(async ({ args, sql }: { args: unknown[]; sql: string }) => {
    if (sql.includes("from artist_socials s") && sql.includes("join artists a")) {
      return { rows: pending };
    }
    if (sql.startsWith("update artist_socials set followed_at")) {
      updates.push(String(args[2]));
      return { rows: [] };
    }
    if (sql.includes("count(*)")) {
      return { rows: [{ n: remaining }] };
    }
    return { rows: [] };
  });

  return updates;
}

beforeEach(() => {
  vi.clearAllMocks();
  followSpotifyArtist.mockResolvedValue(undefined);
  resolveYouTubeChannelId.mockResolvedValue("UCchannel123");
  subscribeToYouTubeChannel.mockResolvedValue(undefined);
});

describe("followPendingArtists", () => {
  it("follows a Spotify + a YouTube target, stamps each, and reports remaining", async () => {
    const updates = wireDb(
      [
        {
          artist_id: "a1",
          name: "Changing Faces",
          platform: "spotify",
          social_id: "s1",
          spotify_artist_id: "3TVXtAsR1Inumwj472S9r4",
          url: "https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4",
        },
        {
          artist_id: "a2",
          name: "Flowidus",
          platform: "youtube",
          social_id: "s2",
          spotify_artist_id: null,
          url: "https://www.youtube.com/@flowidus",
        },
      ],
      0,
    );

    const { followPendingArtists } = await import("./artists");
    const summary = await followPendingArtists(5, false);

    expect(followSpotifyArtist).toHaveBeenCalledWith("3TVXtAsR1Inumwj472S9r4");
    expect(resolveYouTubeChannelId).toHaveBeenCalledWith("https://www.youtube.com/@flowidus");
    expect(subscribeToYouTubeChannel).toHaveBeenCalledWith("UCchannel123");
    expect(summary.followedCount).toBe(2);
    expect(summary.failedCount).toBe(0);
    expect(summary.remaining).toBe(0);
    // Both targets got a followed_at UPDATE (idempotency stamp).
    expect(updates.length).toBe(2);
  });

  it("dry run reports targets but never calls the platforms or writes", async () => {
    const updates = wireDb(
      [
        {
          artist_id: "a1",
          name: "Changing Faces",
          platform: "spotify",
          social_id: "s1",
          spotify_artist_id: "3TVXtAsR1Inumwj472S9r4",
          url: "https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4",
        },
      ],
      1,
    );

    const { followPendingArtists } = await import("./artists");
    const summary = await followPendingArtists(5, true);

    expect(summary.dryRun).toBe(true);
    expect(summary.followedCount).toBe(1);
    expect(followSpotifyArtist).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it("a per-target failure is recorded and never aborts the batch", async () => {
    wireDb(
      [
        {
          artist_id: "a1",
          name: "Good",
          platform: "spotify",
          social_id: "s1",
          spotify_artist_id: "3TVXtAsR1Inumwj472S9r4",
          url: "https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4",
        },
        {
          artist_id: "a2",
          name: "No channel",
          platform: "youtube",
          social_id: "s2",
          spotify_artist_id: null,
          url: "https://www.youtube.com/watch?v=x",
        },
      ],
      1,
    );
    // The YouTube URL has no resolvable channel → the sweep records a failure, keeps going.
    resolveYouTubeChannelId.mockResolvedValue(undefined);

    const { followPendingArtists } = await import("./artists");
    const summary = await followPendingArtists(5, false);

    expect(summary.followedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.failed[0]?.platform).toBe("youtube");
    expect(summary.failed[0]?.socialId).toBe("s2");
  });

  it("falls back to the Spotify id parsed from the url when the artist row has none", async () => {
    wireDb(
      [
        {
          artist_id: "a1",
          name: "White label",
          platform: "spotify",
          social_id: "s1",
          spotify_artist_id: null,
          url: "https://open.spotify.com/artist/1vCWHaC5f2uS3yhpwWbIA6",
        },
      ],
      0,
    );

    const { followPendingArtists } = await import("./artists");
    await followPendingArtists(5, false);

    expect(followSpotifyArtist).toHaveBeenCalledWith("1vCWHaC5f2uS3yhpwWbIA6");
  });

  // BLOCKER-gate invariant: a scraped `candidate` (e.g. Firecrawl-sourced) is NEVER a follow
  // target — only `auto`/`confirmed` rows are. The mock HONOURS the query's own status filter
  // (it returns the candidate only if the SQL forgot the `status in ('auto','confirmed')`
  // clause), so dropping that filter from the production query would fail this test.
  it("never follows a firecrawl candidate — only auto/confirmed rows are targets", async () => {
    const seeded = [
      {
        artist_id: "a1",
        followed_at: null,
        name: "Scraped Candidate",
        platform: "spotify" as const,
        social_id: "cand1",
        source: "firecrawl",
        spotify_artist_id: "3TVXtAsR1Inumwj472S9r4",
        status: "candidate",
        url: "https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4",
      },
      {
        artist_id: "a2",
        followed_at: null,
        name: "Auto Artist",
        platform: "spotify" as const,
        social_id: "auto1",
        source: "musicbrainz",
        spotify_artist_id: "1vCWHaC5f2uS3yhpwWbIA6",
        status: "auto",
        url: "https://open.spotify.com/artist/1vCWHaC5f2uS3yhpwWbIA6",
      },
    ];
    const followable = (status: string) => status === "auto" || status === "confirmed";
    const updates: string[] = [];

    execute.mockImplementation(async ({ args, sql }: { args: unknown[]; sql: string }) => {
      if (sql.includes("from artist_socials s") && sql.includes("join artists a")) {
        const rows = sql.includes("s.status in ('auto', 'confirmed')")
          ? seeded.filter((r) => followable(r.status) && r.followed_at === null)
          : seeded;

        return { rows };
      }
      if (sql.startsWith("update artist_socials set followed_at")) {
        updates.push(String(args[2]));

        return { rows: [] };
      }
      if (sql.includes("count(*)") && sql.includes("status in ('auto', 'confirmed')")) {
        const n = seeded.filter((r) => followable(r.status) && r.followed_at === null).length - 1;

        return { rows: [{ n: Math.max(0, n) }] };
      }
      return { rows: [{ n: 0 }] };
    });

    const { followPendingArtists } = await import("./artists");
    const summary = await followPendingArtists(5, false);

    // Only the `auto` row was followed; the candidate never was.
    expect(summary.followedCount).toBe(1);
    expect(summary.followed[0]?.socialId).toBe("auto1");
    expect(summary.followed.some((f) => f.socialId === "cand1")).toBe(false);
    expect(followSpotifyArtist).toHaveBeenCalledTimes(1);
    expect(followSpotifyArtist).toHaveBeenCalledWith("1vCWHaC5f2uS3yhpwWbIA6");
    // The candidate is not a follow target, so it never counts toward `remaining` either.
    expect(summary.remaining).toBe(0);
    // Exactly one follow stamp, for the auto row (the followed_at UPDATE carries the socialId).
    expect(updates).toEqual(["auto1"]);
  });
});

describe("addArtistSocial URL scheme guard (stored-XSS)", () => {
  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox"])(
    "rejects a non-http(s) URL: %s",
    async (badUrl) => {
      const { addArtistSocial, InvalidArtistSocialError } = await import("./artists");

      await expect(addArtistSocial("a1", "homepage", badUrl)).rejects.toBeInstanceOf(
        InvalidArtistSocialError,
      );
      // It threw at the scheme guard — before ever touching the DB.
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rejects an unparseable URL", async () => {
    const { addArtistSocial, InvalidArtistSocialError } = await import("./artists");

    await expect(addArtistSocial("a1", "homepage", "not a url")).rejects.toBeInstanceOf(
      InvalidArtistSocialError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts a valid https URL and persists it", async () => {
    const stored = {
      artist_id: "a1",
      followed_at: null,
      id: "s1",
      platform: "spotify",
      source: "operator",
      status: "confirmed",
      url: "https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4",
    };

    execute.mockImplementation(async ({ sql }: { args: unknown[]; sql: string }) => {
      if (sql.startsWith("insert into artist_socials")) {
        return { rows: [] };
      }
      if (sql.includes("from artist_socials where artist_id = ?")) {
        return { rows: [stored] };
      }
      return { rows: [] };
    });

    const { addArtistSocial } = await import("./artists");
    const social = await addArtistSocial(
      "a1",
      "spotify",
      "  https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4  ",
    );

    expect(social.url).toBe("https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4");
    expect(execute).toHaveBeenCalled();
  });
});
