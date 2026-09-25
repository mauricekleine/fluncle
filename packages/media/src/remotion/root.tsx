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
      <Still component={GalaxyOg} height={630} id="GalaxyOg" width={1200} />

      <Still
        component={FrontierCover}
        defaultProps={{ crewNumber: 42 }}
        height={640}
        id="FrontierCover"
        width={640}
      />

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
