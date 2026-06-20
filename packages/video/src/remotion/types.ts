// Shared inputProps contract for the "NostalgicCosmos" composition.
// Every producer (pipeline, Studio default props, CLI) must satisfy this shape.

export type EnergySample = {
  timeMs: number;
  /** Normalized 0..1 */
  energy: number;
};

export type CosmosTrack = {
  trackId: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
  /** ISO timestamp */
  discoveredAt: string;
  note?: string;
  /**
   * The finding's permanent coordinate in the Galaxy (a star designation),
   * shown bare as `007.8.1B`; canonical URI is `fluncle://007.8.1B`. Recovered
   * telemetry on the video stamp (VOICE.md §3/§6, DESIGN.md's Tabular Rule).
   */
  logId?: string;
  /** Track duration in ms (Spotify metadata). Optional telemetry. */
  durationMs?: number;
  /** Record label (Spotify metadata). Authoritative, render-safe fact. */
  label?: string;
  /**
   * Release date ("2015-12-18", Spotify metadata). Authoritative, render-safe;
   * the on-screen plate shows only the YEAR (a catalog credit beside the label),
   * kept distinct from Fluncle's own Found date.
   */
  releaseDate?: string;
  /**
   * Enrichment's track-level spectral summary (creative fuel — steers the
   * vehicle, texture, and which band drives what; NOT per-frame reactivity, that
   * is the audio analysis). Absent until the track is enriched.
   */
  features?: {
    /** Spectral centroid in Hz — overall brightness (low = dark/warm, high = bright/airy). */
    centroidHz?: number;
    /** Fraction of energy >5kHz — treble/air. 0..1. */
    highRatio?: number;
    /** Spectral flatness of the mids — tonal (low) vs noisy (high). 0..1. */
    midFlatness?: number;
    /** Onsets per second — rhythmic busyness. */
    onsetRate?: number;
    /** Fraction of energy <120Hz — sub-bass weight. 0..1. */
    subBassRatio?: number;
  };
};

export type CosmosAudio = {
  /** Filename inside packages/video/public/ for staticFile() */
  file: string;
  startMs: number;
  /** Clip length, 10000-30000; 20s default, agent-overridable via --duration-ms */
  durationMs: number;
  bpm: number;
  /** ms offsets relative to clip start */
  beatGrid: number[];
  /** ms offsets relative to clip start */
  onsets: number[];
  energyCurve: EnergySample[];
  /** Low band, <150Hz (kick/sub). 0..1, normalized. */
  bassCurve: EnergySample[];
  /** Mid band, 150Hz-2kHz (lead/vocal/snare body). 0..1, normalized. */
  midCurve: EnergySample[];
  /** High band, >2kHz (hats/cymbals/air). 0..1, normalized. */
  trebleCurve: EnergySample[];
};

export type CosmosPalette = {
  /** Warm near-black field (Warm Dark Rule). */
  background: string;
  /** Type-safe scene ink (cream-family). The only palette role meant for text. */
  ink: string;
  /**
   * The vehicle's heat accent — the artwork's OWN most-chromatic swatch,
   * scene-led (no gold lean). LIGHT MATERIAL for shaders/glows, never type ink.
   * For type emphasis, pick from `swatches` or derive from the scene.
   */
  accent: string;
  /** The scene's hot light — the accent lifted toward the brightest swatch. Light material, never type ink. */
  glow: string;
  /** Artwork-derived hexes */
  swatches: string[];
};

/**
 * Render aspect. `portrait` is the unchanged 1080×1920 default (every clip to
 * date). `landscape` is 1920×1080 for the full-screen radio.fluncle.com surface;
 * the bespoke 9:16 shaders reflow under it (expected — landscape is scaffold, not
 * a polished catalogue pass). Resolved to concrete dimensions in `root.tsx`'s
 * `calculateMetadata`; portrait stays the default when the prop is absent.
 */
export type CosmosAspect = "portrait" | "landscape";

export type NostalgicCosmosProps = {
  track: CosmosTrack;
  audio: CosmosAudio;
  palette: CosmosPalette;
  seed: number;
  /**
   * Suppress the BAKED-IN information overlay (the TypePlate identity/telemetry
   * blocks AND the CloseCard sign-off) so a host UI can draw its own metadata
   * over clean footage — the radio.fluncle.com text-free cut. The scene shader is
   * untouched; only the type layer is gated. Read at render time via
   * `getInputProps()` inside TypePlate/CloseCard, so it applies to every
   * (self-contained) workbench composition without touching the composition.
   * Default false — the overlay renders as it always has.
   */
  hideOverlay?: boolean;
  /**
   * Output aspect. Default `portrait` (1080×1920). `landscape` (1920×1080) is the
   * radio full-screen cut. Consumed by `calculateMetadata`; scenes may read it via
   * `getInputProps()` if they want to reflow deliberately.
   */
  aspect?: CosmosAspect;
};
