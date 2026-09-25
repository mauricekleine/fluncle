import {
  siApplemusic,
  siInstagram,
  siMixcloud,
  siSpotify,
  siTiktok,
  siYoutube,
} from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";

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

export function SpotifyIcon({ className }: PlatformIconProps) {
  return <BrandIcon className={className} icon={siSpotify} />;
}

export function AppleMusicIcon({ className }: PlatformIconProps) {
  return <BrandIcon className={className} icon={siApplemusic} />;
}
