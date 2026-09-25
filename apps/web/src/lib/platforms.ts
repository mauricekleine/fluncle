export type PlatformMeta = {
  directPost: boolean;
  key: string;
  label: string;
};

export const PLATFORMS = [
  { directPost: false, key: "tiktok", label: "TikTok" },
  { directPost: true, key: "youtube", label: "YouTube" },
] as const satisfies readonly PlatformMeta[];

export type Platform = (typeof PLATFORMS)[number]["key"];
