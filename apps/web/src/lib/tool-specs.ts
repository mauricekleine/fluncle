import { z } from "zod";

export type Transport = "mcp" | "chat" | "webmcp";

export type ToolTier = "lore-canon" | "catalogue" | "system";

export type Projection =
  | "acknowledgement"
  | "browseIndex"
  | "browseTracks"
  | "chainCard"
  | "compactCard"
  | "entityCard"
  | "identity"
  | "neighbourList"
  | "publicRecord"
  | "twoBucket";

export type ToolAccess = "public" | "session";

export type ToolEffect = "read" | "write";

export function defineSpec<In extends z.ZodType>(spec: ToolSpec<In>): ToolSpec<In> {
  return spec;
}

export type ToolSpec<In extends z.ZodType = z.ZodType> = {
  name: string;

  title: string;

  description: string;

  input: In;

  tier: ToolTier;

  access: ToolAccess;

  effect: ToolEffect;

  transports: Transport[];

  project: Partial<Record<Transport, Projection>>;
};

export const MAX_RECENT_LIMIT = 48;

export const FRESH_LIMIT_MAX = 100;

export const listFindingsSpec = defineSpec({
  access: "public",
  description:
    "List the most recent findings and mixtapes in Fluncle's drum & bass archive, newest first. Dates mark when each was found or published into the spine.",
  effect: "read",
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECENT_LIMIT)
      .optional()
      .describe("How many tracks to return (1 to 48, default 10)."),
  }),
  name: "list_findings",
  project: { chat: "compactCard", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Recent findings",
  transports: ["mcp", "chat", "webmcp"],
});

export const listTracksSpec = defineSpec({
  access: "public",
  description:
    "List every track in Fluncle's drum & bass archive, newest RELEASE first, one page at a time. Ordered by when each track came OUT, not by when Fluncle found it, so do not say Fluncle found them. Set certified to true for only the certified findings (which carry a Log ID coordinate), false for only the quieter uncertified rows, or leave it off for both. Every row carries its trackId and, when it has a page, the url of that page on fluncle.com.",
  effect: "read",
  input: z.object({
    certified: z
      .boolean()
      .optional()
      .describe(
        "Filter by tier: true for only certified findings, false for only uncertified rows, omitted for both.",
      ),
    page: z.number().int().min(1).optional().describe("Which page to return (1-based, default 1)."),
  }),
  name: "list_tracks",

  project: { chat: "browseTracks", mcp: "browseTracks", webmcp: "browseTracks" },
  tier: "catalogue",
  title: "Browse the whole archive",
  transports: ["mcp", "chat", "webmcp"],
});

export const listFreshSpec = defineSpec({
  access: "public",
  description:
    "List the newest drum & bass RELEASES across Fluncle's archive: every track that came OUT in the trailing 30-day window, freshest release first. These are ordered by RELEASE date (when a track landed), not by when Fluncle found it, so do not say Fluncle found them, only that they just came out. Certified findings carry a Log ID coordinate and cover art; the quieter uncertified rows carry neither.",
  effect: "read",
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(FRESH_LIMIT_MAX)
      .optional()
      .describe(`How many releases to return (1 to ${FRESH_LIMIT_MAX}).`),
    view: z
      .enum(["albums", "all", "tracks"])
      .optional()
      .describe(
        "Which cut to return: 'tracks' for the individual releases, 'albums' for the records those releases sit on, or 'all' for both (the default).",
      ),
  }),
  name: "list_fresh",

  project: { chat: "twoBucket", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Fresh releases",
  transports: ["mcp", "chat", "webmcp"],
});

export const getTrackSpec = defineSpec({
  access: "public",
  description:
    "Read one finding (or mixtape) in full by its Log ID coordinate or Spotify track id. Returns the same public record its /log page shows: artist, title, Found date, note, BPM, key, links, galaxy, and the recovered observation transcript. The resource form is fluncle://finding/<logId>.",
  effect: "read",
  input: z.object({
    idOrLogId: z
      .string()
      .describe("A Log ID coordinate (e.g. 012.8.0A) or a Spotify track id / URL."),
  }),
  name: "get_track",
  project: { chat: "compactCard", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Read one finding",
  transports: ["mcp", "chat", "webmcp"],
});

export const getRandomTrackSpec = defineSpec({
  access: "public",
  description: "Pull one random certified track from Fluncle's archive.",
  effect: "read",
  input: z.object({}),
  name: "get_random_track",
  project: { chat: "compactCard", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Random finding",
  transports: ["mcp", "chat", "webmcp"],
});

export const getStatusSpec = defineSpec({
  access: "public",
  description:
    "Check whether all of Fluncle's systems are operational. Returns an overall ok flag, a one-line headline, and the current status of each service (the website, the API, the media zone, the SSH terminal, the DNS zone, the Tor mirror, the render box, and the on-box prober). Read-only; the same health the public /status page shows.",
  effect: "read",
  input: z.object({}),
  name: "get_status",

  project: { chat: "identity", mcp: "identity" },
  tier: "system",
  title: "Are all systems up?",
  transports: ["mcp", "chat"],
});

export const searchArchiveSpec = defineSpec({
  access: "public",
  description:
    "Search Fluncle's drum & bass archive. Handles a name, a label, a key or BPM ask, or 'sounds like <a real track>' (it anchors on a real finding and returns the sonically nearest). An empty result means nothing in the archive matched.",
  effect: "read",
  input: z.object({
    query: z
      .string()
      .min(2)
      .describe("What to dig for (a name, a label, a key/BPM, or 'sounds like <track>')."),
  }),
  name: "search_archive",

  project: { chat: "twoBucket", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Search the archive",
  transports: ["mcp", "chat", "webmcp"],
});

export const getArtistSpec = defineSpec({
  access: "public",
  description:
    "Look up one artist Fluncle has logged, BY NAME (e.g. Netsky). Returns his certified findings from that artist, plus their public socials and the slug of their page. Returns nothing (he has not logged them) when there is no certified finding from that name.",
  effect: "read",
  input: z.object({
    name: z.string().min(1).describe("The artist's name, as it reads on a finding (e.g. Netsky)."),
  }),
  name: "get_artist",

  project: { chat: "entityCard", mcp: "entityCard" },
  tier: "lore-canon",
  title: "Look up an artist",
  transports: ["mcp", "chat"],
});

export const getLabelSpec = defineSpec({
  access: "public",
  description:
    "Look up one label Fluncle has logged, BY NAME (e.g. Hospital Records). Returns his certified findings on that label, plus any confirmed alternate spellings and the slug of its page. Returns nothing (he has found nothing on it) when there is no certified finding on that name.",
  effect: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe("The label's name, as it reads on a finding (e.g. Hospital Records)."),
  }),
  name: "get_label",

  project: { chat: "entityCard", mcp: "entityCard" },
  tier: "lore-canon",
  title: "Look up a label",
  transports: ["mcp", "chat"],
});

export const buildSetSpec = defineSpec({
  access: "public",
  description:
    "Chain a mixable set from one of Fluncle's findings. Give it a starting finding, either a Log ID coordinate he has logged (e.g. 004.7.2I) or a track name, and it returns an ordered set of what mixes in cleanly after it, each step carrying the REASON it mixes (same key, next key over, tempo locked), never a number. It starts from a finding, and returns nothing when he has not logged a starting point.",
  effect: "read",
  input: z.object({
    seed: z
      .string()
      .min(1)
      .describe("A finding to start from, either a Log ID coordinate (004.7.2I) or a track name."),
  }),
  name: "build_set",

  project: { chat: "chainCard", mcp: "chainCard" },
  tier: "lore-canon",
  title: "Build a mixable set",
  transports: ["mcp", "chat"],
});

export const SIMILAR_ARTISTS_DEFAULT = 4;
export const SIMILAR_ARTISTS_MAX = 12;

export const listSimilarArtistsSpec = defineSpec({
  access: "public",
  description:
    "Given an artist Fluncle has logged, BY NAME (e.g. Koven), return the artists whose sound sits nearest to theirs across his findings. Naming an artist is always allowed. Returns nothing when the name resolves to no artist he has logged, and an empty list when he has one but nothing near it yet.",
  effect: "read",
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(SIMILAR_ARTISTS_MAX)
      .optional()
      .describe(`How many nearest artists to return (1 to ${SIMILAR_ARTISTS_MAX}, default 4).`),
    name: z.string().min(1).describe("The artist's name, as it reads on a finding (e.g. Koven)."),
  }),
  name: "list_similar_artists",

  project: { chat: "neighbourList", mcp: "neighbourList" },
  tier: "lore-canon",
  title: "Artists like this one",
  transports: ["mcp", "chat"],
});

const browsePageInput = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("Which page to read (1-based, default 1).");

export const listAlbumCatalogueSpec = defineSpec({
  access: "public",
  description:
    "List the tracks on one album Fluncle knows, by the album's title (e.g. Colours). Returns the tracks on it he has not certified as findings, so none carries a Log ID; each row is its artists, its title, and a Spotify link when there's one. Returns 24 tracks a page; pass page to read the rest. Returns nothing when the name matches no album he knows.",
  effect: "read",
  input: z.object({
    name: z.string().min(1).describe("The album's title, as it reads on a record (e.g. Colours)."),
    page: browsePageInput,
  }),
  name: "list_album_catalogue",
  project: { chat: "twoBucket", mcp: "publicRecord" },
  tier: "catalogue",
  title: "List an album's catalogue",
  transports: ["mcp", "chat"],
});

export const listArtistCatalogueSpec = defineSpec({
  access: "public",
  description:
    "List one artist's tracks Fluncle knows, by name (e.g. Netsky). Returns the records of theirs he has not certified as findings, so none carries a Log ID; each row is the artists, the title, and a Spotify link when there's one. Returns one page of their records a call; pass page to walk the rest. Returns nothing when the name matches no artist he knows.",
  effect: "read",
  input: z.object({
    name: z.string().min(1).describe("The artist's name, as it reads on a finding (e.g. Netsky)."),
    page: browsePageInput,
  }),
  name: "list_artist_catalogue",
  project: { chat: "twoBucket", mcp: "publicRecord" },
  tier: "catalogue",
  title: "List an artist's catalogue",
  transports: ["mcp", "chat"],
});

export const listLabelCatalogueSpec = defineSpec({
  access: "public",
  description:
    "List the tracks on one label Fluncle knows, by name (e.g. Hospital Records). Returns the tracks on it he has not certified as findings, so none carries a Log ID; each row is the artists, the title, and a Spotify link when there's one. Returns one page of the label's artists a call; pass page to walk the rest. Returns nothing when the name matches no label he knows.",
  effect: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe("The label's name, as it reads on a finding (e.g. Hospital Records)."),
    page: browsePageInput,
  }),
  name: "list_label_catalogue",
  project: { chat: "twoBucket", mcp: "publicRecord" },
  tier: "catalogue",
  title: "List a label's catalogue",
  transports: ["mcp", "chat"],
});

export const listArtistsSpec = defineSpec({
  access: "public",
  description:
    "List every artist in Fluncle's drum & bass archive, A to Z. Each row is the artist's name, the slug of their page, whether Fluncle has certified a finding from them, and how many of their tracks the archive holds. A certified artist has a finding logged under a Log ID; the rest he knows are out there but has not yet logged. Returns 50 a page; pass page to walk the whole index.",
  effect: "read",
  input: z.object({ page: browsePageInput }),
  name: "list_artists",
  project: { chat: "browseIndex", mcp: "browseIndex" },
  tier: "catalogue",
  title: "Browse all artists",
  transports: ["mcp", "chat"],
});

export const listAlbumsSpec = defineSpec({
  access: "public",
  description:
    "List every album in Fluncle's drum & bass archive, A to Z. Each row is the album's title, the slug of its page, whether Fluncle has certified a finding from it, and how many of its tracks the archive holds. A certified album has a finding logged under a Log ID; the rest he knows are out there but has not yet logged. Returns 50 a page; pass page to walk the whole index.",
  effect: "read",
  input: z.object({ page: browsePageInput }),
  name: "list_albums",
  project: { chat: "browseIndex", mcp: "browseIndex" },
  tier: "catalogue",
  title: "Browse all albums",
  transports: ["mcp", "chat"],
});

export const listLabelsSpec = defineSpec({
  access: "public",
  description:
    "List every label in Fluncle's drum & bass archive, A to Z. Each row is the label's name, the slug of its page, whether Fluncle has certified a finding on it, and how many of its tracks the archive holds. A certified label has a finding logged under a Log ID; the rest he knows are out there but has not yet logged. Returns 50 a page; pass page to walk the whole index.",
  effect: "read",
  input: z.object({ page: browsePageInput }),
  name: "list_labels",
  project: { chat: "browseIndex", mcp: "browseIndex" },
  tier: "catalogue",
  title: "Browse all labels",
  transports: ["mcp", "chat"],
});

export const submitTrackSpec = defineSpec({
  access: "public",
  description:
    "Submit a track to Fluncle for review by Spotify track URL. Fluncle gives it a listen before anything publishes. Limited to 5 submissions per connection per hour.",
  effect: "write",
  input: z.object({
    contact: z
      .string()
      .max(120)
      .optional()
      .describe("Optional: where to reach the submitter (max 120 characters)."),
    note: z
      .string()
      .max(500)
      .optional()
      .describe("Optional: tell Fluncle why it's a banger (max 500 characters)."),
    spotifyUrl: z.string().describe("Spotify track URL, e.g. https://open.spotify.com/track/..."),
  }),
  name: "submit_track",
  project: { chat: "acknowledgement", mcp: "acknowledgement", webmcp: "acknowledgement" },
  tier: "system",
  title: "Submit a track",
  transports: ["mcp", "chat", "webmcp"],
});

export const subscribeNewsletterSpec = defineSpec({
  access: "public",
  description:
    "Subscribe an email address to Fluncle's newsletter. Fresh bangers, every Friday, from Fluncle.",
  effect: "write",
  input: z.object({
    email: z.email().describe("The email address boarding the mothership."),
  }),
  name: "subscribe_newsletter",
  project: { chat: "acknowledgement", mcp: "acknowledgement", webmcp: "acknowledgement" },
  tier: "system",
  title: "Subscribe to the newsletter",
  transports: ["mcp", "chat", "webmcp"],
});

export const SHARED_TOOL_SPECS: ToolSpec[] = [
  listFindingsSpec,
  listTracksSpec,
  listFreshSpec,
  getTrackSpec,
  getRandomTrackSpec,
  getStatusSpec,
  searchArchiveSpec,
  getArtistSpec,
  getLabelSpec,
  buildSetSpec,
  listSimilarArtistsSpec,
  listAlbumCatalogueSpec,
  listArtistCatalogueSpec,
  listLabelCatalogueSpec,
  listArtistsSpec,
  listAlbumsSpec,
  listLabelsSpec,
  submitTrackSpec,
  subscribeNewsletterSpec,
];

export function toInputJsonSchema(spec: ToolSpec): Record<string, unknown> {
  return z.toJSONSchema(spec.input, {
    io: "input",
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}

export type WebMcpToolDescriptor = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ text: string; type: "text" }>;
  }>;
  inputSchema: Record<string, unknown>;
  name: string;
};

export function toWebMcpTool(
  spec: ToolSpec,
  httpExecute: WebMcpToolDescriptor["execute"],
): WebMcpToolDescriptor {
  return {
    description: spec.description,
    execute: httpExecute,
    inputSchema: toInputJsonSchema(spec),
    name: spec.name,
  };
}
