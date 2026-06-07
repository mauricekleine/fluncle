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
};

export type CosmosAudio = {
  /** Filename inside packages/video/public/ for staticFile() */
  file: string;
  startMs: number;
  /** Clip length, 15000-30000 */
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
  background: string;
  ink: string;
  accent: string;
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
