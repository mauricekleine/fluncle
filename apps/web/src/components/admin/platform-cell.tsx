import { type ComponentType } from "react";
import { TiktokIcon, YoutubeIcon } from "@/components/platform-icons";
import { type Platform, type PlatformMeta, PLATFORMS as PLATFORM_META } from "@/lib/platforms";

export type { Platform };

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
