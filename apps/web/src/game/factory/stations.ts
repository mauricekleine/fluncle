// The factory's data spine — a PURE function of a finding's own public data
// (the same fields /api/tracks already carries) → which station it sits at on
// the belt. The factory is a RENDERER OF TRUE STATE, not a cosmetic animation:
// a finding's position is derived, never faked.
//
// This is the finer-grained sibling of lib/server/track-stage.ts. Where the
// admin board groups into six lifecycle stages, the factory floor has one
// machine per VISIBLE pipeline step, and a finding rides to the furthest step it
// has reached — so findings naturally PILE in front of the slow machines (the
// render bay), making the real backlog physical and honest.
//
// "Furthest reached", not "first incomplete": the async pipeline runs steps in
// parallel (a find can have footage before its note), so we read forward
// progress from the last artifact present, never park a find on a skipped step.

/** The subset of a finding the station model reads — keeps the fn easy to test. */
export type StationInput = {
  addedToSpotify: boolean;
  enrichmentStatus: string;
  note?: string;
  observationAudioUrl?: string;
  postedToTelegram: boolean;
  tiktokUrl?: string;
  videoUrl?: string;
  youtubeUrl?: string;
};

export type StationId =
  | "intake"
  | "spectrograph"
  | "press"
  | "booth"
  | "render"
  | "dispatch"
  | "address"
  | "launch";

export type Station = {
  /** What a finding parked here is waiting for — the quiet "blocked on" line. */
  blocked: string;
  /** What this machine does, said-not-written (the inspect card body). */
  blurb: string;
  id: StationId;
  /** The machine sprite key (procedural; a /factory/<sprite>.png overrides it). */
  sprite: string;
  /** The machine's name on the floor — a quiet terminal label. */
  title: string;
};

// One entry per station, in belt order (left → right). The last, `launch`, is the
// terminal: a finding that reaches it is finished and is sent up to the Galaxy.
// Voice (every word): sentence case, no exclamation marks, no em dashes, no
// emoji, said-not-written (VOICE.md / the copywriting-fluncle rails).
export const STATIONS: readonly Station[] = [
  {
    blocked: "Just landed.",
    blurb: "Where a fresh find lands and gets its number.",
    id: "intake",
    sprite: "intake",
    title: "intake",
  },
  {
    blocked: "Waiting to be read.",
    blurb: "Reads the tempo, the key, and the shape of the sound.",
    id: "spectrograph",
    sprite: "spectrograph",
    title: "spectrograph",
  },
  {
    blocked: "Waiting for its note.",
    blurb: "Stamps the facts and prints the note.",
    id: "press",
    sprite: "press",
    title: "press",
  },
  {
    blocked: "Waiting to be spoken.",
    blurb: "Records the spoken observation.",
    id: "booth",
    sprite: "booth",
    title: "booth",
  },
  {
    blocked: "In the render queue.",
    blurb: "Builds the footage. This one takes a while.",
    id: "render",
    sprite: "render",
    title: "render bay",
  },
  {
    blocked: "Ready to send.",
    blurb: "Sends it out to the channels.",
    id: "dispatch",
    sprite: "dispatch",
    title: "dispatch",
  },
  {
    blocked: "Waiting on the live links.",
    blurb: "Writes the live links back onto the find.",
    id: "address",
    sprite: "address",
    title: "address printer",
  },
  {
    blocked: "Cleared for launch.",
    blurb: "Loads the finished find and sends it up to the Galaxy.",
    id: "launch",
    sprite: "launch",
    title: "launch pad",
  },
] as const;

export const STATION_COUNT = STATIONS.length;
/** The terminal station index — a finding here is done and launches into orbit. */
export const LAUNCH_INDEX = STATION_COUNT - 1;

/**
 * Which station a finding sits at, 0..LAUNCH_INDEX. The gates are the visible
 * artifacts of each pipeline step, in order; a finding rides to the station
 * AFTER the last artifact it has, so the furthest evidence wins (forward
 * progress, never parked on a skipped step). A finding with every artifact
 * reaches `launch`.
 */
export function stationOf(track: StationInput): number {
  // The ordered gates — each true once that step's artifact exists. Index 0 is
  // the synchronous add; the rest are the async pipeline's outputs.
  const gates: boolean[] = [
    track.addedToSpotify && track.postedToTelegram, // intake done
    track.enrichmentStatus === "done", // spectrograph done
    Boolean(track.note), // press done (the editorial note)
    Boolean(track.observationAudioUrl), // booth done (the spoken observation)
    Boolean(track.videoUrl), // render bay done (the footage)
    Boolean(track.youtubeUrl ?? track.tiktokUrl), // dispatch done (first push live)
    Boolean(track.youtubeUrl && track.tiktokUrl), // address done (both links back)
  ];

  // The index of the last completed gate (-1 if not even added). The finding
  // sits at the next station — the one currently working on it — capped at the
  // launch pad once every gate is satisfied.
  let lastDone = -1;
  for (let i = 0; i < gates.length; i++) {
    if (gates[i]) {
      lastDone = i;
    }
  }

  return Math.min(lastDone + 1, LAUNCH_INDEX);
}
