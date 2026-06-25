import { type RegionModule } from "./_shared";

// The Launch region (north) — the climactic region. The rocket is the bridge
// into the existing Galaxy game. The telescope opens the Galaxy's surface card
// from the registry; the rocket opens the custom launch card that navigates
// to /galaxy. Prop ids prefixed launch_…
//
// Tile box (world.ts REGION_BOXES.launch): x 20..35, y 2..13.
// South corridor mouth (x26-29, y12-13) is kept clear.

// A brass telescope on a tripod — cream-dim tube, gold eyepiece ring, dark
// barrel body, three spindly tripod legs meeting at a collar. Gold kept at the
// eyepiece only (~10%).
const telescope = [
  "......odddo......",
  ".....odddDdo.....",
  "....odddddddo....",
  "....odddddddo....",
  "....odddddddo....",
  "....oddyddyddo...",
  ".....oddddddo....",
  "......oddyddo....",
  ".......oddddo....",
  "........oddo.....",
  ".......kkkkkk....",
  "......k.....k....",
  "....kk.......kk..",
  "...kkkk.....kkkk.",
];

// A classic rocket standing on a launch gantry — cream body, re-entry-red nose
// cone and fin tips, a small porthole, dark launch gantry arms at the base,
// a tiny gold flame hint at the exhaust. Tall: 22 rows × 14 cols.
// Anchored bottom-center; reads as a rocket at a glance.
const rocket = [
  "......rr......",
  ".....rRRr.....",
  "....rRRRRr....",
  "....rRRRRr....",
  "....occcco....",
  "....ocCCco....",
  "....ocCCco....",
  "....occcco....",
  "....ocoooco...",
  "....ocCcCco...",
  "....ocoooco...",
  "....occcco....",
  "....ocCCco....",
  "....ocCCco....",
  "....occcco....",
  "...ooocccoo...",
  "..ookkkkkkkoo.",
  ".rookkkkkkkooo",
  "rrrookkkkkooor",
  "errokkkkkkkorr",
  ".mmmokkkkkomy.",
  "...yyyymmmyyy.",
];

const region: RegionModule = {
  doors: [
    {
      label: "the Galaxy",
      prop: "launch_telescope",
      surface: "web.galaxy",
      tx: 24,
      ty: 7,
    },
    {
      card: "launch",
      label: "the rocket",
      prop: "launch_rocket",
      tx: 31,
      ty: 8,
    },
  ],
  id: "launch",
  props: {
    launch_rocket: rocket,
    launch_telescope: telescope,
  },
};

export default region;
