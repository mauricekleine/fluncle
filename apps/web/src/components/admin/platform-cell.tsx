import { type ComponentType } from "react";
import { TiktokIcon, YoutubeIcon } from "@/components/platform-icons";
import { type Platform, type PlatformMeta, PLATFORMS as PLATFORM_META } from "@/lib/platforms";

export type { Platform };

// The publish targets shared by the board's stage cells + push dialog. The set,
// labels, and push shapes live in the pure `lib/platforms.ts` source of truth
// (server-safe, no icons); this module joins each to its brand logo. Logos are
// the official simple-icons brand marks (the platform-icons / interface-icons
// split; DESIGN.md). A new platform without an icon fails the build (the
// PLATFORM_ICONS map is exhaustive over `Platform`).

type PlatformIcon = ComponentType<{
  className?: string;
  weight?: "fill" | "bold" | "regular";
}>;

const PLATFORM_ICONS: Record<Platform, PlatformIcon> = {
  tiktok: TiktokIcon,
  youtube: YoutubeIcon,
};

export type PlatformConfig = PlatformMeta & {
  Icon: PlatformIcon;
  key: Platform;
};

export const PLATFORMS: readonly PlatformConfig[] = PLATFORM_META.map((platform) => ({
  ...platform,
  Icon: PLATFORM_ICONS[platform.key],
}));
