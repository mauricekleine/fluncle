// ONE NOUN, ONE DESTINATION: "the archive" is `/findings`, and `/` is the front door.
//
// The two are different pages with different jobs, and the words for them are load-bearing rather
// than decorative. `/findings` is the cover-led feed of every certified finding — the page the canon
// calls the archive in PRODUCT.md, DESIGN.md's Plate and Three Areas Rule, and the voice canon. `/`
// is the front door: search, one edited lead, a band of findings, what just came out, and the four
// ways into the wider index.
//
// The failure this guards is quiet and easy: a label keeps saying "the archive" while its `to=`
// still points at the page that used to be one. The reader is not sent somewhere broken — they are
// sent somewhere ELSE, which no status code notices. Two rails:
//
//   1. Every shipped "Back to the archive" control resolves to `/findings`.
//   2. The two AGENT-facing documents agree. `public/llms.txt` is committed and
//      `agent-discovery.ts` generates the markdown homepage `/` serves to an Accept-negotiating
//      agent; they are read by the same crawlers, so a disagreement between them is a contradiction
//      published in machine-readable form.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const appRoot = resolve(srcRoot, "..");

/** Every `.ts`/`.tsx` source file under `src/`, tests excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }

    return /\.tsx?$/.test(entry) && !/[.](?:test|spec)[.]tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * The `to=` each "Back to the archive" control declares.
 *
 * The label and its route option are not adjacent in every caller — some are a bare
 * `<Link to="…">Back to the archive</Link>`, others hand a `render={<Link to="…" />}` to a Button
 * carrying the label as a child — so the reading walks BACK from the label to the `<Link` that owns
 * it and takes the `to=` in between. Bounded and closing-tag-fenced, so a `<Link>` for something
 * else further up the file is never mistaken for this one: a control that names no destination
 * (the Stories player's own close button, whose `aria-label` reads the same) yields nothing rather
 * than borrowing a neighbour's route.
 */
function archiveDestinations(source: string): string[] {
  const found: string[] = [];

  for (const label of source.matchAll(/Back to the archive/g)) {
    const at = label.index;

    if (at === undefined) {
      continue;
    }

    const window = source.slice(Math.max(0, at - 300), at);
    const opened = window.lastIndexOf("<Link");

    if (opened === -1) {
      continue;
    }

    const own = window.slice(opened);

    // Anything that closes an element between the opening tag and the label means the label is not
    // this `<Link>`'s child.
    if (own.includes("</")) {
      continue;
    }

    const to = /\bto="([^"]*)"/.exec(own);

    if (to?.[1] !== undefined) {
      found.push(to[1]);
    }
  }

  return found;
}

describe('every shipped "Back to the archive" control goes to the archive', () => {
  const callers = sourceFiles(join(srcRoot, "routes"))
    .concat(sourceFiles(join(srcRoot, "components")))
    .map((file) => [relative(srcRoot, file), readFileSync(file, "utf8")] as const)
    .filter(([, source]) => source.includes("Back to the archive"));

  it("finds the callers at all (a rename must not make this suite vacuous)", () => {
    expect(callers.length).toBeGreaterThanOrEqual(15);
  });

  it.each(callers)("%s sends the reader to /findings, never the front door", (_name, source) => {
    const destinations = archiveDestinations(source);

    // A caller with no `to=` in range is a control that closes something rather than navigating
    // (the Stories player's own back button); it names no destination, so it cannot be wrong.
    for (const destination of destinations) {
      expect(
        destination,
        `"Back to the archive" points at "${destination}". The archive is /findings; / is the front door.`,
      ).toBe("/findings");
    }
  });
});

describe("the two agent-facing documents name the same pages", () => {
  const llms = readFileSync(join(appRoot, "public", "llms.txt"), "utf8");
  const markdownHome = readFileSync(join(srcRoot, "lib", "server", "agent-discovery.ts"), "utf8");

  /** The URL a markdown link list gives a named entry, with `${siteUrl}` folded to the real host. */
  function linkTarget(document: string, label: string): string | undefined {
    const match = new RegExp(`\\[${label}\\]\\(([^)]+)\\)`).exec(document);

    return match?.[1]?.replace("${siteUrl}", "https://www.fluncle.com");
  }

  it("both call https://www.fluncle.com/findings the archive", () => {
    expect(linkTarget(llms, "The archive")).toBe("https://www.fluncle.com/findings");
    expect(linkTarget(markdownHome, "The archive")).toBe("https://www.fluncle.com/findings");
  });

  it("both call the bare root the front door", () => {
    expect(linkTarget(llms, "The front door")).toBe("https://www.fluncle.com/");
    expect(linkTarget(markdownHome, "The front door")).toBe("https://www.fluncle.com/");
  });

  it("neither document still points the archive at the root", () => {
    for (const [name, document] of [
      ["llms.txt", llms],
      ["the generated markdown homepage", markdownHome],
    ] as const) {
      expect(
        document.includes("[The archive](https://www.fluncle.com/)") ||
          document.includes("[The archive](${siteUrl}/)"),
        `${name} still calls the front door the archive`,
      ).toBe(false);
    }
  });
});
