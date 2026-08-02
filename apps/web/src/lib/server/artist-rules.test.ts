import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: undefined as Client | undefined,
  mbFetch: vi.fn(),
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => mocks.db };
});

vi.mock("./musicbrainz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./musicbrainz")>();

  return { ...actual, mbFetch: mocks.mbFetch };
});

import { createIntegrationDb } from "./integration-db";
import {
  addArtistRule,
  DuplicateGlobalArtistRuleError,
  listArtistRules,
  listLabelArtistRules,
  MissingArtistRuleNameError,
  removeArtistRule,
  replaceLabelArtistRules,
} from "./artist-rules";
import { LabelNotFoundError } from "./labels";

let db: Client;

async function seedLabel(
  id: string,
  opts: { ruledAt?: null | string; scopeChangedAt?: null | string } = {},
): Promise<void> {
  const now = "2026-08-02T00:00:00.000Z";
  await db.execute({
    args: [
      id,
      `Label ${id}`,
      `label-${id}`,
      opts.ruledAt ?? null,
      opts.scopeChangedAt ?? null,
      now,
      now,
    ],
    sql: `insert into labels
            (id, name, slug, ruled_at, scope_changed_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function seedLocalArtist(input: {
  id: string;
  mbid: string;
  name: string;
  spotifyArtistId?: null | string;
}): Promise<void> {
  const now = "2026-08-02T00:00:00.000Z";
  await db.execute({
    args: [
      input.id,
      input.name,
      `artist-${input.id}`,
      input.mbid,
      input.spotifyArtistId ?? null,
      now,
      now,
    ],
    sql: `insert into artists
            (id, name, slug, mbid, spotify_artist_id, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
  });
}

function mbArtist(input: {
  name?: string;
  relations?: Array<{ url?: { resource?: string } }>;
}): void {
  mocks.mbFetch.mockResolvedValueOnce({ data: input, rateLimited: false });
}

function mbMiss(): void {
  mocks.mbFetch.mockResolvedValueOnce({ data: null, rateLimited: false });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  mocks.db = db;
  mocks.mbFetch.mockReset();
});

describe("label artist rules", () => {
  it("resolves the Spotify bridge from the exact MB artist url-rel", async () => {
    await seedLabel("lbl_bridge");
    mbArtist({
      name: "Jus Now",
      relations: [
        { url: { resource: "https://example.com/not-spotify" } },
        { url: { resource: "https://open.spotify.com/artist/spotify-jus-now?si=abc" } },
      ],
    });

    const [rule] = await replaceLabelArtistRules("lbl_bridge", [
      { artistMbid: "mbid-jus-now", artistName: "Jus Now", verdict: "block" },
    ]);

    expect(mocks.mbFetch).toHaveBeenCalledWith("/artist/mbid-jus-now?inc=url-rels");
    expect(rule?.artistSpotifyId).toBe("spotify");
  });

  it("falls back to the local artist graph when MB has no Spotify relation", async () => {
    await seedLabel("lbl_fallback");
    await seedLocalArtist({
      id: "artist-local",
      mbid: "mbid-local",
      name: "Local Artist",
      spotifyArtistId: "spotify-local",
    });
    mbArtist({ name: "MusicBrainz Name", relations: [] });

    const [rule] = await replaceLabelArtistRules("lbl_fallback", [
      { artistMbid: "mbid-local", artistName: "Credited Name", verdict: "allow" },
    ]);

    expect(rule?.artistName).toBe("Credited Name");
    expect(rule?.artistSpotifyId).toBe("spotify-local");
  });

  it("stores a tap-blind null bridge when both MB and the local graph miss", async () => {
    await seedLabel("lbl_null");
    mbMiss();

    const [rule] = await replaceLabelArtistRules("lbl_null", [
      { artistMbid: "mbid-nowhere", artistName: "Known Name", verdict: "block" },
    ]);

    expect(rule?.artistSpotifyId).toBeNull();
  });

  it("keeps a supplied-name rule tap-blind when the MB client errors", async () => {
    await seedLabel("lbl_error");
    mocks.mbFetch.mockRejectedValueOnce(new Error("MusicBrainz unavailable"));

    const [rule] = await replaceLabelArtistRules("lbl_error", [
      { artistMbid: "mbid-error", artistName: "Known Artist", verdict: "allow" },
    ]);

    expect(rule?.artistName).toBe("Known Artist");
    expect(rule?.artistSpotifyId).toBeNull();
  });

  it("checks that the label exists before making any MB calls", async () => {
    await expect(
      replaceLabelArtistRules("lbl_missing", [
        { artistMbid: "mbid", artistName: "Artist", verdict: "block" },
      ]),
    ).rejects.toBeInstanceOf(LabelNotFoundError);

    expect(mocks.mbFetch).not.toHaveBeenCalled();
  });

  it("keeps the old set when the atomic replacement fails", async () => {
    await seedLabel("lbl_atomic");
    mbMiss();
    await replaceLabelArtistRules("lbl_atomic", [
      { artistMbid: "mbid-old", artistName: "Old Rule", verdict: "block" },
    ]);
    mbMiss();
    mbMiss();

    await expect(
      replaceLabelArtistRules("lbl_atomic", [
        { artistMbid: "mbid-duplicate", artistName: "Duplicate One", verdict: "allow" },
        { artistMbid: "mbid-duplicate", artistName: "Duplicate Two", verdict: "block" },
      ]),
    ).rejects.toThrow();

    const rules = await listLabelArtistRules("lbl_atomic");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.artistMbid).toBe("mbid-old");
  });

  it("stamps the scope watermark but never changes ruled_at", async () => {
    const ruledAt = "2026-07-31T12:00:00.000Z";
    await seedLabel("lbl_provenance", { ruledAt });
    mbMiss();

    await replaceLabelArtistRules("lbl_provenance", [
      { artistMbid: "mbid-rule", artistName: "Rule Artist", verdict: "block" },
    ]);

    const state = await db.execute({
      args: ["lbl_provenance"],
      sql: `select ruled_at, scope_changed_at, updated_at from labels where id = ?`,
    });
    expect(state.rows[0]?.ruled_at).toBe(ruledAt);
    expect(state.rows[0]?.scope_changed_at).toBeTruthy();
    expect(state.rows[0]?.updated_at).toBe(state.rows[0]?.scope_changed_at);
  });
});

describe("global artist rules", () => {
  it("uses the MB canonical name when the operator omits --name", async () => {
    mbArtist({
      name: "Canonical Artist",
      relations: [{ url: { resource: "https://open.spotify.com/artist/spotifycanonical" } }],
    });

    const rule = await addArtistRule({ artistMbid: "mbid-canonical", verdict: "allow" });

    expect(rule.artistName).toBe("Canonical Artist");
    expect(rule.artistSpotifyId).toBe("spotifycanonical");
    expect(rule.resolvedMbid).toBeNull();
    expect(rule.resolvedName).toBeNull();
    expect(rule.checkedAt).toBeNull();

    const internal = await db.execute({
      args: [rule.id],
      sql: `select rearmed_at, resolved_mbid, resolved_name, checked_at
            from artist_rules where id = ?`,
    });
    expect(internal.rows[0]).toMatchObject({
      checked_at: null,
      rearmed_at: null,
      resolved_mbid: null,
      resolved_name: null,
    });
  });

  it("falls back to the local artist name when MB misses", async () => {
    await seedLocalArtist({
      id: "artist-name-fallback",
      mbid: "mbid-name-fallback",
      name: "Local Canonical Name",
      spotifyArtistId: "spotify-name-fallback",
    });
    mbMiss();

    const rule = await addArtistRule({ artistMbid: "mbid-name-fallback", verdict: "block" });

    expect(rule.artistName).toBe("Local Canonical Name");
    expect(rule.artistSpotifyId).toBe("spotify-name-fallback");
  });

  it("rejects an omitted name when neither identity source can supply one", async () => {
    mbMiss();

    await expect(
      addArtistRule({ artistMbid: "mbid-nameless", verdict: "block" }),
    ).rejects.toBeInstanceOf(MissingArtistRuleNameError);
    expect(await listArtistRules()).toEqual([]);
  });

  it("translates the partial-unique collision into DuplicateGlobalArtistRuleError", async () => {
    mbMiss();
    await addArtistRule({ artistMbid: "mbid-once", artistName: "Once", verdict: "block" });

    await expect(
      addArtistRule({ artistMbid: "mbid-once", artistName: "Again", verdict: "allow" }),
    ).rejects.toBeInstanceOf(DuplicateGlobalArtistRuleError);
    expect(mocks.mbFetch).toHaveBeenCalledTimes(1);
  });

  it("lists and removes global rules without touching a label-scoped sibling", async () => {
    await seedLabel("lbl_sibling");
    mbMiss();
    const global = await addArtistRule({
      artistMbid: "mbid-shared",
      artistName: "Global Artist",
      verdict: "block",
    });
    mbMiss();
    await replaceLabelArtistRules("lbl_sibling", [
      { artistMbid: "mbid-shared", artistName: "Scoped Artist", verdict: "allow" },
    ]);

    await removeArtistRule(global.id);

    expect(await listArtistRules()).toEqual([]);
    expect(await listLabelArtistRules("lbl_sibling")).toHaveLength(1);
  });
});
