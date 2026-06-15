import { TiktokLogoIcon, YoutubeLogoIcon } from "@phosphor-icons/react";
import { type ComponentType } from "react";

// The publish targets shared by the board's stage cells + push dialog. `directPost`
// distinguishes the push shapes: TikTok pushes a private inbox DRAFT (the operator
// finishes in-app), YouTube posts DIRECTLY and publicly on click. Instagram is
// intentionally absent — there's no legitimate automated audio path
// (docs/track-lifecycle.md).

export type PlatformConfig = {
  Icon: ComponentType<{ className?: string; weight?: "fill" | "bold" | "regular" }>;
  directPost: boolean;
  key: string;
  label: string;
};

export const PLATFORMS: PlatformConfig[] = [
  { Icon: TiktokLogoIcon, directPost: false, key: "tiktok", label: "TikTok" },
  { Icon: YoutubeLogoIcon, directPost: true, key: "youtube", label: "YouTube" },
];
