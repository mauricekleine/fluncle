import { siInstagram, siMixcloud, siTiktok, siYoutube } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";

// Platform logo components — the OFFICIAL brand marks from simple-icons, wrapped to
// the `{ className, weight }` call shape an icon slot expects, so a brand logo drops
// into any place that takes a phosphor-style icon component (PLATFORMS[].Icon, the
// board's step glyphs). `weight` is accepted and ignored: a brand mark has one
// canonical form, it never changes weight.
//
// Use these (or `<BrandIcon icon={si…} />` directly when rendering inline, as the
// Spotify mark is) for any THIRD-PARTY PLATFORM LOGO. Phosphor is for INTERFACE icons
// only — see DESIGN.md, "Platform icons vs interface icons".

type PlatformIconProps = { className?: string; weight?: string };

export function YoutubeIcon({ className }: PlatformIconProps) {
  return <BrandIcon className={className} icon={siYoutube} />;
}

export function TiktokIcon({ className }: PlatformIconProps) {
  return <BrandIcon className={className} icon={siTiktok} />;
}

export function InstagramIcon({ className }: PlatformIconProps) {
  return <BrandIcon className={className} icon={siInstagram} />;
}

export function MixcloudIcon({ className }: PlatformIconProps) {
  return <BrandIcon className={className} icon={siMixcloud} />;
}
