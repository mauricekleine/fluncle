import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const OUT = join(PKG, "out");
const PUBLIC = join(PKG, "public");
const CLIPS_TS = join(PKG, "src", "explainer", "factory-clips.ts");
const FOUND_BASE = "https://found.fluncle.com";
const LETTERS = ["a", "b", "c"] as const;
const TILE = 540;

const ids = process.argv.slice(2);
if (ids.length !== 3) {
  console.error(
    "Usage: bun run factory:clips <id> <id> <id>  (exactly three findings)\n" +
      "       prefix an id with @ to force the published master on found.fluncle.com\n" +
      "       (e.g. @027.9.5H) when the local out/ render is stale.",
  );
  process.exit(1);
}

const localSource = (id: string): string | undefined => {
  const candidates = [
    join(OUT, id, "footage.mp4"),
    join(OUT, `${id}.square.mp4`),
    join(OUT, `${id}.mp4`),
  ];
  return candidates.find((p) => existsSync(p));
};

const fetchSource = async (id: string): Promise<string> => {
  const url = `${FOUND_BASE}/${encodeURIComponent(id)}/footage.mp4`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`no local render for ${id} and ${url} returned ${res.status}`);
  }
  const scratchDir = join(OUT, ".factory-src");
  mkdirSync(scratchDir, { recursive: true });
  const dest = join(scratchDir, `${id.replaceAll("/", "_")}.mp4`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
};

const transcode = (source: string, dest: string) => {
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      source,
      "-vf",
      `scale=${TILE}:${TILE}:flags=lanczos`,
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "30",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      dest,
    ],
    { stdio: "pipe" },
  );
};

mkdirSync(PUBLIC, { recursive: true });
const names: string[] = [];
for (let i = 0; i < ids.length; i++) {
  const raw = ids[i] ?? "";

  const forceRemote = raw.startsWith("@");
  const id = forceRemote ? raw.slice(1) : raw;
  const letter = LETTERS[i];
  const name = `factory-${letter}.mp4`;
  const local = forceRemote ? undefined : localSource(id);
  const source = local ?? (await fetchSource(id));
  transcode(source, join(PUBLIC, name));
  names.push(name);
  console.log(`  ${id} → public/${name}  (${local ? "local render" : "found.fluncle.com"})`);
}

const body = `export const FACTORY_CLIPS: string[] = [\n${names.map((n) => `  "${n}",`).join("\n")}\n];\n`;

const header = `// The factory beat plays real rendered track footage when it is present, and
// falls back to the procedural shader tiles otherwise. That footage is a LOCAL,
// export-time asset: \`packages/video/public/*.mp4\` is gitignored, so a clean
// checkout renders the procedural stand-in (works anywhere, nothing in history).
//
// To wire real footage for an export, name three findings (by Log ID or Spotify
// id) and run:
//
//   bun run --cwd packages/video factory:clips <id> <id> <id>
//
// It resolves each source (a local out/<id> render first, else the public
// footage on found.fluncle.com), transcodes to tile size into public/, and
// rewrites the array below. Reset with \`git checkout src/explainer/factory-clips.ts\`.
`;
writeFileSync(CLIPS_TS, header + body);
console.log(
  `\nWired ${names.length} clips into src/explainer/factory-clips.ts (local, uncommitted).`,
);
console.log("Render with: bun run --cwd packages/video tour:studio  (or a remotion render).");
