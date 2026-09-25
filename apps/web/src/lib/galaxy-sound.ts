// HOW EACH GALAXY SOUNDS — one plain line per named galaxy, keyed by slug.
//
// A galaxy is lore (VOICE.md §5, the Three Areas): a region of Fluncle's findings that hit the
// same way. Its name ("Lunar", "Pulsar") says where it sits on the map and nothing about the
// sound, so a reader who knows no subgenre words cannot choose between galaxies by ear. Each
// line fixes that in plain words a stranger hears the music in, with Fluncle's body in it: the
// sound first, then what it does to him. The four lines stay distinct from each other, because
// their job is to help someone pick one galaxy over the next.
//
// Every line is written from the galaxy's actual findings: the titles and artists in it, the
// notes Fluncle logged on them, and the style evidence on their releases. A line never claims
// a sound the findings do not carry. When the cluster engine reshapes a galaxy far enough that
// its line stops being true, the line is re-heard and rewritten here.
//
// Readers: the `/galaxies` index tiles, the galaxy page masthead, and the galaxy GraphLink hover
// card (which follows every galaxy link, on `/log` pages included). All of them go through
// `galaxySoundLine`, so the sentence is the same everywhere by construction.
//
// A NEWLY NAMED GALAXY gets its line here, drafted through the `copywriting-fluncle` skill and
// gated by the `canon-reviewer` agent like every public string. Until it has one, it renders no
// line at all (honest absence), never a generic stand-in. `galaxy-sound.test.ts` pins the
// mechanics every line must hold.

export const GALAXY_SOUND_LINES = {
  lunar: "Calm, glassy tunes with soft melodies over deep bass, and my shoulders drop.",
  nebular: "Dark, sparse tunes with patient drums and heavy bass that sits right on my chest.",
  pulsar:
    "Bright, lifting tunes with big vocals and the odd remix of a song you might know, and up go my hands.",
  solar:
    "Warm, soulful tunes with voices singing over a steady rolling beat that keeps my feet going.",
} as const satisfies Record<string, string>;

/** The galaxy's sound line, or `undefined` when the galaxy has none yet (render nothing). */
export function galaxySoundLine(slug: string): string | undefined {
  const lines: Readonly<Record<string, string>> = GALAXY_SOUND_LINES;

  // Own keys only, so a slug like "constructor" can never reach the object prototype.
  return Object.hasOwn(lines, slug) ? lines[slug] : undefined;
}
