/** What the game needs to know about one finding, fetched at boot. */
export type GameTrack = {
  addedAt: string;
  artists: string[];
  logId?: string;
  spotifyUrl: string;
  title: string;
  trackId: string;
};

/** A banger star, placed at its Log ID coordinate. */
export type Star = {
  /** Bearing-stable angle on its ring, radians. */
  angle: number;
  artistLine: string;
  logId: string;
  /** Radial distance from Earth (world units). */
  radius: number;
  sector: number;
  spotifyUrl: string;
  title: string;
  trackId: string;
  /** Render-only fake height above/below the horizon plane. */
  vOffset: number;
  x: number;
  y: number;
};

export type Vec2 = {
  x: number;
  y: number;
};
