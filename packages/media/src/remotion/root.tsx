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

      {/* Mixtape covers — one <MixtapeCover> per size (square / 16:9 / OG), from
          mixtape-cover-specs.ts. `bun run render:mixtape-cover -- --number N
          --coordinate XXX.F.ZZ` writes them to packages/media/out/mixtapes/<coord>/.
          The defaults below are previewable in Studio; the render script overrides them. */}
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
