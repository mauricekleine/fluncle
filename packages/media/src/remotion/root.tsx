// Composition registry for image assets. Each entry is a <Still> — a
// single-frame image rendered via renderStill. This package grows by adding a
// composition file and registering a <Still> here (see README.md).

import { Still } from "remotion";

import { GalaxyOg } from "./galaxy-og";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* The Open Graph / link-preview card for the /galaxy route (1200×630),
          rendered to apps/web/public/galaxy/og.png by `bun run render:og`. */}
      <Still component={GalaxyOg} height={630} id="GalaxyOg" width={1200} />
    </>
  );
};
