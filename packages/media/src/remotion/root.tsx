// Composition registry for image assets. Each entry is a <Still> — a
// single-frame image rendered via renderStill. This package grows by adding a
// composition file and registering a <Still> here (see README.md).

import { Still } from "remotion";

import { AppIcon } from "./app-icon";
import { APP_ICON_SIZE, APP_ICON_SPECS, MOBILE_ASSET_SPECS } from "./app-icon-specs";
import { CosmosBanner } from "./cosmos-banner";
import { FrontierCover } from "./frontier-cover";
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

      {/* The per-user "Fluncle's Frontier" playlist cover (E2), 640×640. Rendered
          NODE-SIDE by apps/web/scripts/render-frontier-covers.ts (parametrized by the
          owner's crew №) and uploaded to Spotify; the default below stays previewable
          in Studio. */}
      <Still
        component={FrontierCover}
        defaultProps={{ crewNumber: 42 }}
        height={640}
        id="FrontierCover"
        width={640}
      />

      {/* App-icon candidates for apps/mobile — one <AppIcon> variant per
          candidate at the 1024² master size (app-icon-specs.ts). A TASTE
          deliverable: `bun run render:app-icons` writes them to out/app-icon/
          for the operator to pick one, which then gets wired into the app. */}
      {APP_ICON_SPECS.map((spec) => (
        <Still
          component={AppIcon}
          defaultProps={{ variant: spec.variant }}
          height={APP_ICON_SIZE}
          id={spec.id}
          key={spec.id}
          width={APP_ICON_SIZE}
        />
      ))}

      {/* The production mobile assets (app-icon-specs.ts MOBILE_ASSET_SPECS):
          the picked icon plus the Android adaptive foreground + the splash
          mark. `bun run render:mobile-assets` writes them to
          apps/mobile/assets/ (committed). The picked icon's still is already
          registered by the candidate map above, so only the ids the candidate
          set doesn't carry are added here. */}
      {MOBILE_ASSET_SPECS.filter(
        (spec) => !APP_ICON_SPECS.some((candidate) => candidate.id === spec.id),
      ).map((spec) => (
        <Still
          component={AppIcon}
          defaultProps={{ variant: spec.variant }}
          height={APP_ICON_SIZE}
          id={spec.id}
          key={spec.id}
          width={APP_ICON_SIZE}
        />
      ))}

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
