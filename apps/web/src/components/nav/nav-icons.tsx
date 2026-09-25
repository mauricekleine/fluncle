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

type PhosphorIcon = (props: { className?: string; weight?: IconWeight }) => ReactNode;

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

export function navIcon(id: string, className = "size-4"): ReactNode {
  const brand = brandById[id];

  if (brand) {
    return <BrandIcon className={className} icon={brand} />;
  }

  const Phosphor = phosphorById[id];

  return Phosphor ? <Phosphor className={className} weight="bold" /> : undefined;
}
