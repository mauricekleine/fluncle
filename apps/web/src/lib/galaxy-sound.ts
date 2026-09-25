export const GALAXY_SOUND_LINES = {
  lunar: "Calm, glassy tunes with soft melodies over deep bass, and my shoulders drop.",
  nebular: "Dark, sparse tunes with patient drums and heavy bass that sits right on my chest.",
  pulsar:
    "Bright, lifting tunes with big vocals and the odd remix of a song you might know, and up go my hands.",
  solar:
    "Warm, soulful tunes with voices singing over a steady rolling beat that keeps my feet going.",
} as const satisfies Record<string, string>;

export function galaxySoundLine(slug: string): string | undefined {
  const lines: Readonly<Record<string, string>> = GALAXY_SOUND_LINES;

  return Object.hasOwn(lines, slug) ? lines[slug] : undefined;
}
