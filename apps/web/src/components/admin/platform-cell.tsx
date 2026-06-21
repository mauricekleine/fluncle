import { type ComponentType } from "react";
import { TiktokIcon, YoutubeIcon } from "@/components/platform-icons";

// The publish targets shared by the board's stage cells + push dialog. `directPost`
// distinguishes the push shapes: TikTok pushes a private inbox DRAFT (the operator
// finishes in-app), YouTube posts DIRECTLY and publicly on click. Instagram is
// intentionally absent — there's no legitimate automated audio path
// (docs/track-lifecycle.md). Logos are the official simple-icons brand marks (the
// platform-icons / interface-icons split; DESIGN.md).

export type PlatformConfig = {
  Icon: ComponentType<{ className?: string; weight?: "fill" | "bold" | "regular" }>;
  directPost: boolean;
  key: string;
  label: string;
};

export const PLATFORMS: PlatformConfig[] = [
  { Icon: TiktokIcon, directPost: false, key: "tiktok", label: "TikTok" },
  { Icon: YoutubeIcon, directPost: true, key: "youtube", label: "YouTube" },
];
