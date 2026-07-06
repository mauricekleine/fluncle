// The single source of truth for the per-track video-push platform set — the
// platforms the `/social/:platform/draft` push endpoint supports. Pure data (no
// React, no icons) so both the server route and the admin UI import the same
// list. Every per-platform map/switch in the push path is keyed on `Platform`,
// so adding a member here forces those sites to cover it or fail the build (the
// exhaustive switch in the draft route + platforms.test.ts).
//
// `directPost` distinguishes the push shapes: TikTok pushes a private inbox DRAFT
// (the operator finishes in-app), YouTube posts DIRECTLY and publicly on click.
// Instagram is intentionally absent — there's no legitimate automated audio path
// (see postiz.ts).

export type PlatformMeta = {
  directPost: boolean;
  key: string;
  label: string;
};

export const PLATFORMS = [
  { directPost: false, key: "tiktok", label: "TikTok" },
  { directPost: true, key: "youtube", label: "YouTube" },
] as const satisfies readonly PlatformMeta[];

/** A per-track video-push target. The union is derived from `PLATFORMS`. */
export type Platform = (typeof PLATFORMS)[number]["key"];

/** The platform keys, for runtime membership checks (the route validates a string param). */
export const PLATFORM_KEYS: readonly Platform[] = PLATFORMS.map((platform) => platform.key);

/** Narrow an arbitrary string (a route param) to a supported `Platform`. */
export const isPlatform = (value: string): value is Platform =>
  PLATFORM_KEYS.includes(value as Platform);
