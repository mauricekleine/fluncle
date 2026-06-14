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
  /** Spotify/Deezer tags. Creative fuel; not for on-screen text. */
  tags?: string[];
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
  bassCurve: EnergySample[];
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

export type NostalgicCosmosProps = {
  track: CosmosTrack;
  audio: CosmosAudio;
  palette: CosmosPalette;
  seed: number;
};
