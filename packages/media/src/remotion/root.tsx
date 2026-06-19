// Composition registry for image assets. Each entry is a <Still> — a
// single-frame image rendered via renderStill. This package grows by adding a
// composition file and registering a <Still> here (see README.md).

import { Still } from "remotion";

import { CosmosBanner } from "./cosmos-banner";
import { GalaxyOg } from "./galaxy-og";
import { MixtapeCover } from "./mixtape-cover";
import { MIXTAPE_COVER_SPECS } from "./mixtape-cover-specs";
import { SOCIAL_SPECS } from "./socials-specs";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* The Open Graph / link-preview card for the /galaxy route (1200×630),
          rendered to apps/web/public/galaxy/og.png by `bun run render:og`. */}
      <Still component={GalaxyOg} height={630} id="GalaxyOg" width={1200} />

      {/* Social profile banners / covers — one CosmosBanner per platform, sized
          and safe-area'd from socials-specs.ts. `bun run render:socials` writes
          the claimed ones to docs/socials/banners/. */}
      {SOCIAL_SPECS.map((spec) => (
        <Still
          component={CosmosBanner}
          defaultProps={{ figure: spec.figure, safe: spec.safe }}
          height={spec.height}
          id={spec.id}
          key={spec.id}
          width={spec.width}
        />
      ))}

      {/* Mixtape cover — one <MixtapeCover> per size (square / 16:9 / OG), from
          mixtape-cover-specs.ts. The per-mixtape text is now stamped on the fly by
          the web cover endpoint (Satori); `bun run render:mixtape-bg` bakes the
          shared, text-free background (markers:false) into apps/web/public. The
          defaults below stay previewable in Studio with the markers on. */}
      {MIXTAPE_COVER_SPECS.map((spec) => (
        <Still
          component={MixtapeCover}
          defaultProps={{ coordinate: "019.F.1A", number: "1" }}
          height={spec.height}
          id={spec.id}
          key={spec.id}
          width={spec.width}
        />
      ))}
    </>
  );
};
