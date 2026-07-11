// Icon mapping for the nav model (kept out of the pure data module). Interface
// glyphs come from Phosphor; the Playlist item and every "Follow" social carry the
// official brand mark via `simple-icons` through `BrandIcon` (DESIGN.md Iconography
// — never a Phosphor lookalike for a third-party mark).

import {
  CassetteTapeIcon,
  VinylRecordIcon,
  EnvelopeSimpleIcon,
  FadersIcon,
  type IconWeight,
  InfoIcon,
  ListDashesIcon,
  NotebookIcon,
  PaperPlaneTiltIcon,
  PlanetIcon,
  RadioIcon,
  TagIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import {
  type SimpleIcon,
  siBluesky,
  siInstagram,
  siMixcloud,
  siSoundcloud,
  siSpotify,
  siTelegram,
  siTiktok,
  siTwitch,
  siX,
  siYoutube,
} from "simple-icons";
import { type ReactNode } from "react";
import { BrandIcon } from "@/components/brand-icon";

// A Phosphor icon component signature (weight + className) — the subset the nav uses.
type PhosphorIcon = (props: { className?: string; weight?: IconWeight }) => ReactNode;

// Explore + Listen + Crew glyphs, keyed by NavItem id. Playlist is a brand mark and
// lives in the social map below, so it is intentionally absent here.
const phosphorById: Record<string, PhosphorIcon> = {
  about: InfoIcon,
  albums: VinylRecordIcon,
  artists: UsersThreeIcon,
  galaxies: PlanetIcon,
  labels: TagIcon,
  log: ListDashesIcon,
  logbook: NotebookIcon,
  mix: FadersIcon,
  mixtapes: CassetteTapeIcon,
  newsletter: EnvelopeSimpleIcon,
  radio: RadioIcon,
  submit: PaperPlaneTiltIcon,
};

// Brand marks by id — the Playlist item and the follow-row socials.
const brandById: Record<string, SimpleIcon> = {
  bluesky: siBluesky,
  instagram: siInstagram,
  mixcloud: siMixcloud,
  playlist: siSpotify,
  soundcloud: siSoundcloud,
  telegram: siTelegram,
  tiktok: siTiktok,
  twitch: siTwitch,
  x: siX,
  youtube: siYoutube,
};

/** The glyph for a NavItem / social id, sized to the text. Undefined → no icon. */
export function navIcon(id: string, className = "size-4"): ReactNode {
  const brand = brandById[id];

  if (brand) {
    return <BrandIcon className={className} icon={brand} />;
  }

  const Phosphor = phosphorById[id];

  return Phosphor ? <Phosphor className={className} weight="bold" /> : undefined;
}
