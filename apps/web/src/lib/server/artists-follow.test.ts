import { beforeEach, describe, expect, it, vi } from "vitest";

// The auto-follow sweep (Epic B, Unit 5): `followPendingArtists` follows a bounded batch
// of high-confidence artists across Spotify + YouTube, idempotent by `followed_at IS
// NULL`, and stamps the follow. Spotify + YouTube are MOCKED here — a test never hits a
// real platform. The DB is mocked with a SQL-dispatching `execute`.

const execute = vi.fn();
const followSpotifyArtist = vi.fn();
const unfollowSpotifyArtist = vi.fn();
const resolveYouTubeChannelId = vi.fn();
const subscribeToYouTubeChannel = vi.fn();
const unsubscribeFromYouTubeChannel = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./spotify", () => ({ followSpotifyArtist, unfollowSpotifyArtist }));
vi.mock("./youtube", () => ({
  resolveYouTubeChannelId,
  subscribeToYouTubeChannel,
  unsubscribeFromYouTubeChannel,
}));

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
      // Honour the sweep's YouTube-only platform filter — a seeded non-YouTube row is
      // excluded exactly as the production query (`s.platform = 'youtube'`) excludes it.
      const rows = sql.includes("s.platform = 'youtube'")
        ? pending.filter((r) => r.platform === "youtube")
        : pending;

      return { rows };
    }
    if (sql.startsWith("update artist_socials set followed_at")) {
      updates.push(String(args[2]));
      return { rows: [] };
    }
    // The per-day YouTube ceiling count (`followed_at >=` day start): none followed yet in a test.
    if (sql.includes("count(*)") && sql.includes("followed_at >=")) {
      return { rows: [{ n: 0 }] };
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
  unfollowSpotifyArtist.mockResolvedValue(undefined);
  resolveYouTubeChannelId.mockResolvedValue("UCchannel123");
  subscribeToYouTubeChannel.mockResolvedValue(undefined);
  unsubscribeFromYouTubeChannel.mockResolvedValue(undefined);
});

describe("followPendingArtists", () => {
  it("follows a YouTube target, stamps it, and reports remaining", async () => {
    const updates = wireDb(
      [
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

    expect(resolveYouTubeChannelId).toHaveBeenCalledWith("https://www.youtube.com/@flowidus");
    expect(subscribeToYouTubeChannel).toHaveBeenCalledWith("UCchannel123");
    // Spotify is never touched by the sweep (YouTube-only; dev-mode-gated).
    expect(followSpotifyArtist).not.toHaveBeenCalled();
    expect(summary.followedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
    expect(summary.remaining).toBe(0);
    expect(updates.length).toBe(1);
  });

  it("excludes Spotify rows from the sweep (dev-mode-gated — manual only)", async () => {
    // A Spotify `auto` row + a YouTube `auto` row: the YouTube-only query drops the Spotify
    // one, so the sweep follows only YouTube and never calls the Spotify API. Seeding the
    // Spotify row here means: if the production query ever re-added 'spotify', this fails.
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

    expect(followSpotifyArtist).not.toHaveBeenCalled();
    expect(subscribeToYouTubeChannel).toHaveBeenCalledTimes(1);
    expect(summary.followedCount).toBe(1);
    expect(summary.followed[0]?.socialId).toBe("s2");
    expect(summary.followed[0]?.platform).toBe("youtube");
    expect(updates).toEqual(["s2"]);
  });

  it("dry run reports targets but never calls the platform or writes", async () => {
    const updates = wireDb(
      [
        {
          artist_id: "a2",
          name: "Flowidus",
          platform: "youtube",
          social_id: "s2",
          spotify_artist_id: null,
          url: "https://www.youtube.com/@flowidus",
        },
      ],
      1,
    );

    const { followPendingArtists } = await import("./artists");
    const summary = await followPendingArtists(5, true);

    expect(summary.dryRun).toBe(true);
    expect(summary.followedCount).toBe(1);
    expect(subscribeToYouTubeChannel).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it("a per-target failure is recorded and never aborts the batch", async () => {
    wireDb(
      [
        {
          artist_id: "a1",
          name: "Good channel",
          platform: "youtube",
          social_id: "s1",
          spotify_artist_id: null,
          url: "https://www.youtube.com/@good",
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
      0,
    );
    // The second URL has no resolvable channel → the sweep records a failure, keeps going.
    resolveYouTubeChannelId.mockImplementation(async (url: string) =>
      url.includes("@good") ? "UCgood" : undefined,
    );

    const { followPendingArtists } = await import("./artists");
    const summary = await followPendingArtists(5, false);

    expect(summary.followedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.failed[0]?.platform).toBe("youtube");
    expect(summary.failed[0]?.socialId).toBe("s2");
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
        platform: "youtube" as const,
        social_id: "cand1",
        source: "firecrawl",
        spotify_artist_id: null,
        status: "candidate",
        url: "https://www.youtube.com/@candidate",
      },
      {
        artist_id: "a2",
        followed_at: null,
        name: "Auto Artist",
        platform: "youtube" as const,
        social_id: "auto1",
        source: "musicbrainz",
        spotify_artist_id: null,
        status: "auto",
        url: "https://www.youtube.com/@auto",
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
      // The per-day YouTube ceiling count (`followed_at >=` day start) — none followed yet.
      if (sql.includes("count(*)") && sql.includes("followed_at >=")) {
        return { rows: [{ n: 0 }] };
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
    expect(subscribeToYouTubeChannel).toHaveBeenCalledTimes(1);
    expect(followSpotifyArtist).not.toHaveBeenCalled();
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

// The "Undo" op (Epic B, Unit 5). Its durable half: undoing a Spotify/YouTube follow REALLY
// unfollows on the platform AND mutes the row (`muted_at`) so the sweep can't re-follow; a
// no-API platform is a plain bookkeeping clear (no mute, no platform call).
describe("undoArtistSocialFollow", () => {
  // Answer the lookup SELECT + the clearing UPDATE + the getArtistSocialById read-back.
  function wireUndo(lookup: Record<string, unknown>, finalMutedAt: string | null) {
    const updates: unknown[][] = [];

    execute.mockImplementation(async ({ args, sql }: { args: unknown[]; sql: string }) => {
      if (sql.includes("a.spotify_artist_id") && sql.includes("where s.id = ?")) {
        return { rows: [lookup] };
      }
      if (sql.startsWith("update artist_socials set followed_at = null")) {
        updates.push(args);
        return { rows: [] };
      }
      if (sql.includes("from artist_socials where id = ?")) {
        return {
          rows: [
            {
              artist_id: "a1",
              followed_at: null,
              id: "s1",
              muted_at: finalMutedAt,
              platform: lookup["platform"],
              source: "musicbrainz",
              status: "auto",
              url: lookup["url"],
            },
          ],
        };
      }
      return { rows: [] };
    });

    return updates;
  }

  it("unfollows a Spotify row on the platform and mutes it", async () => {
    const updates = wireUndo(
      {
        followed_at: "2026-07-06T00:00:00.000Z",
        platform: "spotify",
        spotify_artist_id: "abc",
        url: "https://open.spotify.com/artist/abc",
      },
      "2026-07-07T00:00:00.000Z",
    );

    const { undoArtistSocialFollow } = await import("./artists");
    const { platformWarning, social } = await undoArtistSocialFollow("s1");

    expect(unfollowSpotifyArtist).toHaveBeenCalledWith("abc");
    // The UPDATE's muted_at arg (args[0]) is a non-null stamp — the durable skip.
    expect(updates[0]?.[0]).toEqual(expect.any(String));
    expect(social.mutedAt).not.toBeNull();
    expect(social.followedAt).toBeNull();
    // The platform unfollow went through, so no soft warning.
    expect(platformWarning).toBeNull();
  });

  it("still clears + mutes + warns when the Spotify unfollow API fails (403)", async () => {
    // The dev-mode-403 reality: the API unfollow throws, but the operator's Undo must still
    // stick — clear the stamp, mute the row, and hand back a soft warning (never hard-gate).
    unfollowSpotifyArtist.mockRejectedValue(new Error("Spotify API request failed: 403 Forbidden"));
    const updates = wireUndo(
      {
        followed_at: "2026-07-06T00:00:00.000Z",
        platform: "spotify",
        spotify_artist_id: "abc",
        url: "https://open.spotify.com/artist/abc",
      },
      "2026-07-07T00:00:00.000Z",
    );

    const { undoArtistSocialFollow } = await import("./artists");
    const { platformWarning, social } = await undoArtistSocialFollow("s1");

    expect(unfollowSpotifyArtist).toHaveBeenCalledWith("abc");
    // Bookkeeping still ran: stamp cleared + muted, despite the API miss.
    expect(updates[0]?.[0]).toEqual(expect.any(String));
    expect(social.followedAt).toBeNull();
    expect(social.mutedAt).not.toBeNull();
    // …and the miss surfaces as a soft warning, not a thrown error.
    expect(platformWarning).toContain("Spotify");
    expect(platformWarning).toContain("403");
  });

  it("clears a no-API row without a platform call and without muting", async () => {
    const updates = wireUndo(
      {
        followed_at: "2026-07-06T00:00:00.000Z",
        platform: "soundcloud",
        spotify_artist_id: null,
        url: "https://soundcloud.com/x",
      },
      null,
    );

    const { undoArtistSocialFollow } = await import("./artists");
    const { platformWarning, social } = await undoArtistSocialFollow("s1");

    expect(unfollowSpotifyArtist).not.toHaveBeenCalled();
    expect(unsubscribeFromYouTubeChannel).not.toHaveBeenCalled();
    // muted_at arg is null for a no-API platform — no durable skip needed (no sweep touches it).
    expect(updates[0]?.[0]).toBeNull();
    expect(social.mutedAt).toBeNull();
    // No API call for a no-API platform, so no warning.
    expect(platformWarning).toBeNull();
  });
});

describe("followArtistSocial", () => {
  // Answer the lookup SELECT + the stamping UPDATE + the getArtistSocialById read-back.
  function wireFollow(lookup: Record<string, unknown>) {
    const updates: unknown[][] = [];

    execute.mockImplementation(async ({ args, sql }: { args: unknown[]; sql: string }) => {
      if (sql.includes("a.spotify_artist_id") && sql.includes("where s.id = ?")) {
        return { rows: [lookup] };
      }
      if (sql.startsWith("update artist_socials set followed_at = ?")) {
        updates.push(args);
        return { rows: [] };
      }
      if (sql.includes("from artist_socials where id = ?")) {
        return {
          rows: [
            {
              artist_id: "a1",
              // The row is followed after the stamp — the read-back reflects it.
              followed_at: "2026-07-07T00:00:00.000Z",
              id: "s1",
              muted_at: null,
              platform: lookup["platform"],
              source: "musicbrainz",
              status: "auto",
              url: lookup["url"],
            },
          ],
        };
      }
      return { rows: [] };
    });

    return updates;
  }

  it("follows a Spotify row on the platform and stamps it (no warning)", async () => {
    const updates = wireFollow({
      followed_at: null,
      platform: "spotify",
      spotify_artist_id: "abc",
      url: "https://open.spotify.com/artist/abc",
    });

    const { followArtistSocial } = await import("./artists");
    const { platformWarning, social } = await followArtistSocial("s1");

    expect(followSpotifyArtist).toHaveBeenCalledWith("abc");
    expect(updates).toHaveLength(1);
    expect(social.followedAt).not.toBeNull();
    expect(platformWarning).toBeNull();
  });

  it("still stamps followed_at + warns when the Spotify follow API fails (403)", async () => {
    // The dev-mode-403 reality on the "Follow now" path: the API follow throws, but the operator
    // must still be able to mark the row — stamp followed_at and return a soft warning.
    followSpotifyArtist.mockRejectedValue(new Error("Spotify API request failed: 403 Forbidden"));
    const updates = wireFollow({
      followed_at: null,
      platform: "spotify",
      spotify_artist_id: "abc",
      url: "https://open.spotify.com/artist/abc",
    });

    const { followArtistSocial } = await import("./artists");
    const { platformWarning, social } = await followArtistSocial("s1");

    expect(followSpotifyArtist).toHaveBeenCalledWith("abc");
    // Bookkeeping still ran despite the API miss.
    expect(updates).toHaveLength(1);
    expect(social.followedAt).not.toBeNull();
    expect(platformWarning).toContain("Spotify");
    expect(platformWarning).toContain("403");
  });

  it("rejects a no-API platform (use recordOperatorFollow there)", async () => {
    wireFollow({
      followed_at: null,
      platform: "soundcloud",
      spotify_artist_id: null,
      url: "https://soundcloud.com/x",
    });

    const { followArtistSocial } = await import("./artists");

    await expect(followArtistSocial("s1")).rejects.toThrow(/no follow API/);
    expect(followSpotifyArtist).not.toHaveBeenCalled();
  });
});

describe("unmuteArtistSocial", () => {
  it("clears muted_at with no platform call", async () => {
    const updates: string[] = [];

    execute.mockImplementation(async ({ sql }: { args: unknown[]; sql: string }) => {
      if (sql.startsWith("update artist_socials set muted_at = null")) {
        updates.push(sql);
        return { rows: [] };
      }
      if (sql.includes("from artist_socials where id = ?")) {
        return {
          rows: [
            {
              artist_id: "a1",
              followed_at: null,
              id: "s1",
              muted_at: null,
              platform: "spotify",
              source: "musicbrainz",
              status: "auto",
              url: "https://open.spotify.com/artist/abc",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { unmuteArtistSocial } = await import("./artists");
    const social = await unmuteArtistSocial("s1");

    expect(updates).toHaveLength(1);
    expect(unfollowSpotifyArtist).not.toHaveBeenCalled();
    expect(social.mutedAt).toBeNull();
  });
});
