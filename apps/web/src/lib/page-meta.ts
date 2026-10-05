import { artistTitleLine } from "@/lib/log-prose";
import { META_DESCRIPTION_MAX, bioMetaDescription, leadingSentences } from "@/lib/meta-description";

export const PAGE_TITLE_MAX = 60;

const SITE_SUFFIX = " · Fluncle";

type Credited = { artists: string[]; title: string };

function pickTitle(heads: string[]): string {
  const titles = heads.map((head) => `${head}${SITE_SUFFIX}`);

  return titles.find((title) => title.length <= PAGE_TITLE_MAX) ?? titles.at(-1) ?? SITE_SUFFIX;
}

function pickDescription(candidates: string[]): string {
  const fitting = candidates.find((candidate) => candidate.length <= META_DESCRIPTION_MAX);

  return fitting ?? bioMetaDescription(candidates.at(-1) ?? "");
}

function withBio(bio: string | undefined, facts: string[], fallback: string[]): string {
  if (bio === undefined) {
    return pickDescription(fallback);
  }

  for (const fact of facts) {
    const lead = leadingSentences(bio, META_DESCRIPTION_MAX - fact.length - 1);

    if (lead !== undefined) {
      return `${lead} ${fact}`;
    }
  }

  return bioMetaDescription(bio);
}

function nameList(names: string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }

  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

function uniqueNames(names: Array<string | undefined>): string[] {
  const seen = new Set<string>();

  return names.flatMap((raw) => {
    const name = raw?.trim();

    if (!name || seen.has(name.toLowerCase())) {
      return [];
    }

    seen.add(name.toLowerCase());

    return [name];
  });
}

function trackNoun(count: number, genre: boolean): string {
  return `${count} ${genre ? "drum & bass " : ""}${count === 1 ? "track" : "tracks"}`;
}

function recommendedClause(trackCount: number, findingCount: number): string {
  if (findingCount <= 0) {
    return "";
  }

  if (findingCount >= trackCount) {
    return trackCount === 1
      ? ", recommended by Fluncle"
      : trackCount === 2
        ? ", both recommended by Fluncle"
        : ", all recommended by Fluncle";
  }

  return `, ${findingCount} recommended by Fluncle`;
}

function countClause(trackCount: number, findingCount: number, genre: boolean): string {
  return `${trackNoun(trackCount, genre)}${recommendedClause(trackCount, findingCount)}`;
}

function yearOf(date: string | undefined): string | undefined {
  const year = date?.slice(0, 4);

  return year && /^\d{4}$/u.test(year) ? year : undefined;
}

export function artistPageTitle(name: string): string {
  return pickTitle([
    `${name}: drum & bass tracks and releases`,
    `${name}: drum & bass tracks`,
    name,
  ]);
}

export function labelPageTitle(name: string): string {
  return pickTitle([
    `${name}: drum & bass releases and artists`,
    `${name}: drum & bass releases`,
    name,
  ]);
}

export function albumArtistCredit(tracks: Array<{ artists: string[] }>): string | undefined {
  const [first, ...rest] = tracks;

  if (first === undefined) {
    return undefined;
  }

  const shared = uniqueNames(first.artists).filter((name) =>
    rest.every((track) =>
      track.artists.some((artist) => artist.trim().toLowerCase() === name.toLowerCase()),
    ),
  );

  return shared.length > 0 && shared.length <= 2 ? shared.join(" & ") : undefined;
}

export function completeAlbumArtistCredit(album: {
  catalogue: Array<{ artists: string[] }>;
  catalogueTotal: number;
  findings: Array<{ artists: string[] }>;
}): string | undefined {
  if (album.catalogue.length < album.catalogueTotal) {
    return undefined;
  }

  return albumArtistCredit([...album.findings, ...album.catalogue]);
}

export function albumPageTitle(album: {
  artist: string | undefined;
  name: string;
  releaseDate: string | undefined;
}): string {
  const { artist, name } = album;
  const year = yearOf(album.releaseDate);
  const by = artist === undefined ? undefined : `${name} by ${artist}`;

  return pickTitle(
    [
      by && year ? `${by}: ${year} drum & bass release` : undefined,
      by ? `${by}: drum & bass release` : undefined,
      by,
      year ? `${name}: ${year} drum & bass release` : undefined,
      `${name}: drum & bass release`,
      name,
    ].filter((head) => head !== undefined),
  );
}

export function trackPageTitle(track: Credited & { releaseDate: string | undefined }): string {
  const line = artistTitleLine(track);
  const year = yearOf(track.releaseDate);

  return pickTitle(
    [
      year ? `${line}: ${year} drum & bass track` : undefined,
      `${line}: drum & bass track`,
      line,
    ].filter((head) => head !== undefined),
  );
}

export function artistMetaDescription(artist: {
  bio: string | undefined;
  findingCount: number;
  name: string;
  trackCount: number;
}): string {
  const { bio, findingCount, name, trackCount } = artist;
  const behind = ", with the releases and labels behind them.";
  const bare = countClause(trackCount, findingCount, false);
  const genre = countClause(trackCount, findingCount, true);

  return withBio(
    bio,
    [`${genre}${behind}`, `${genre}.`],
    [`Drum & bass by ${name}: ${bare}${behind}`, `Drum & bass by ${name}: ${bare}.`],
  );
}

export function labelMetaDescription(label: {
  artistNames: string[];
  bio: string | undefined;
  findingCount: number;
  name: string;
  trackCount: number;
}): string {
  const { bio, findingCount, name, trackCount } = label;
  const artists = uniqueNames(label.artistNames);
  const including = [3, 2, 1].flatMap((size) =>
    artists.length >= size ? [`, from artists including ${nameList(artists.slice(0, size))}.`] : [],
  );
  const bare = countClause(trackCount, findingCount, false);
  const genre = countClause(trackCount, findingCount, true);
  const lead = `Drum & bass released on ${name}: ${bare}`;

  return withBio(
    bio,
    [...including.map((tail) => `${genre}${tail}`), `${genre}.`],
    [...including.map((tail) => `${lead}${tail}`), `${lead}.`],
  );
}

export function albumMetaDescription(album: {
  artist: string | undefined;
  bio: string | undefined;
  findingCount: number;
  label: string | undefined;
  name: string;
  releaseDate: string | undefined;
  trackCount?: number;
  trackTitles: string[];
}): string {
  const { artist, bio, findingCount, label, name } = album;
  const year = yearOf(album.releaseDate);
  const titles = uniqueNames(album.trackTitles);
  const trackCount = Math.max(album.trackCount ?? 0, album.trackTitles.length, findingCount);

  const release = `a ${year ? `${year} ` : ""}drum & bass release${label ? ` on ${label}` : ""}`;
  const lead = `${name}${artist ? ` by ${artist}` : ""}, ${release}.`;

  const recommends =
    findingCount <= 0
      ? undefined
      : findingCount >= trackCount
        ? trackCount === 1
          ? "Fluncle recommends it."
          : trackCount === 2
            ? "Fluncle recommends both."
            : `Fluncle recommends all ${trackCount}.`
        : `Fluncle recommends ${findingCount} of them.`;
  const listed =
    titles.length > 1 && titles.length === trackCount
      ? `${trackNoun(trackCount, false)}: ${nameList(titles)}.`
      : undefined;

  const facts = [
    listed && recommends ? `${listed} ${recommends}` : undefined,
    listed,
    `${countClause(trackCount, findingCount, false)}.`,
  ].filter((fact) => fact !== undefined);

  return withBio(bio, facts, [...facts.map((fact) => `${lead} ${fact}`), lead]);
}

type TrackMetaInput = Credited & {
  album: string | undefined;
  bpm: number | undefined;
  key: string | undefined;
  label: string | undefined;
  releaseDate: string | undefined;
  tail: string | undefined;
};

function tempoSentence(bpm: number | undefined, key: string | undefined): string | undefined {
  const tempo = bpm ? `${Math.round(bpm)} BPM` : undefined;

  if (tempo && key) {
    return `${tempo} in ${key}.`;
  }

  return tempo ? `${tempo}.` : key ? `In ${key}.` : undefined;
}

export function trackMetaDescription(track: TrackMetaInput): string {
  const line = artistTitleLine(track);
  const year = yearOf(track.releaseDate);
  const kind = year || track.label ? "release" : "track";
  const release = `a ${year ? `${year} ` : ""}drum & bass ${kind}${track.label ? ` on ${track.label}` : ""}`;
  const album =
    track.album && track.album.trim().toLowerCase() !== track.title.trim().toLowerCase()
      ? track.album.trim()
      : undefined;

  const withAlbum = album ? `${line}, from ${album}, ${release}.` : undefined;
  const plain = `${line}, ${release}.`;
  const tempo = tempoSentence(track.bpm, track.key);

  const join = (...parts: Array<string | undefined>): string =>
    parts.filter((part) => part !== undefined && part !== "").join(" ");

  const candidates = [
    withAlbum ? join(withAlbum, tempo, track.tail) : undefined,
    join(plain, tempo, track.tail),
    withAlbum ? join(withAlbum, tempo) : undefined,
    join(plain, tempo),
    plain,
  ].filter((candidate) => candidate !== undefined);

  return pickDescription(candidates);
}

export function twitterCardMeta(card: {
  description: string;
  imageUrl: string;
  title: string;
}): Array<{ content: string; name: string }> {
  return [
    { content: card.title, name: "twitter:title" },
    { content: card.description, name: "twitter:description" },
    { content: card.imageUrl, name: "twitter:image" },
  ];
}
