// The admin UI's per-track video-push platform set — the platforms the
// `/social/:platform/draft` push endpoint supports. Pure data (no React, no icons).
// Adding a member here fails the build until the exhaustive `PLATFORM_ICONS`
// record in components/admin/platform-cell.tsx covers it. The server keeps its own
// copy (the `SUPPORTED` set in lib/server/orpc/admin-social.ts and the contract's
// `z.enum` in packages/contracts/src/orpc/admin-social.ts); keep all three in step.
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
