// The front door's CLIENT-SAFE shapes.
//
// `-front-door-data.ts` is a server module (it reaches `lib/server/**`, so it can only be reached
// through a dynamic import inside a `createServerFn` handler — docs/client-bundle.md, Rule 1). The
// components that RENDER its payload run in the browser, so the shapes they need live here, where
// both sides can import them without dragging `getDb` and `@libsql/client` into the eager chunk.

/** The four shelves the front door opens onto, with the real size of each. */
export type FrontDoorCounts = {
  albums: number;
  artists: number;
  labels: number;
  tracks: number;
};
