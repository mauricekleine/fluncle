import { type RegionModule } from "./_shared";

// The Landing (center) — the home base, the spawn. Five objects: the logbook,
// the monolith, the notice board, a Nokia brick, and a magnifying lens on a
// stand. Three owned surfaces (registry) and two gated client cards.
//
// Tile box (world.ts REGION_BOXES.landing): x 22..33, y 18..29.
// Spawn tile (27,24), corridor mouths — all kept clear.
// Prop ids globally unique, prefixed landing_…

// A thick book, slightly splayed open — dark boards, cream pages, a faint gold
// spine stripe. Reads as a logbook at a glance.
const logbook = [
  "..oooooooooooo..",
  ".okkkkkkkkkkkoo.",
  ".okddddddddkkoo.",
  ".okdccccccckoo..",
  ".okdcddddddkoo..",
  ".okdcddddddkoo..",
  ".okdcddddddkoo..",
  ".okdcddddddkoo..",
  ".okdcddddddkoo..",
  ".okdccccccckoo..",
  ".okddddddddkoo..",
  ".okyyyyyyyykoo..",
  ".okkkkkkkkkkoo..",
  "..oooooooooooo..",
  "....kkkkkkkk....",
];

// An upright slab of dark stone — flat top, a faint cream band near the peak
// (a cover-art glint), heavier shadow at the base.
const monolith = [
  "....ooooooooo....",
  "...okkkkkkkko....",
  "...okddddddko....",
  "...okdccccDko....",
  "...okdCcCcDko....",
  "...okdCcCcDko....",
  "...okdccccDko....",
  "...okddddddko....",
  "...okddddddko....",
  "...okddddddko....",
  "...okddddddko....",
  "...okddddddko....",
  "...okkkkkkko.....",
  "...oooooooooo....",
  "....kkkkkkkk.....",
];

// A framed notice board mounted on two short posts — dark frame, cream face,
// a dim grid of pinned notes, two wooden posts below.
const board = [
  "oooooooooooooooooo",
  "okkkkkkkkkkkkkkkko",
  "okdcccccccccccddko",
  "okdcdcdcdcdcdcddko",
  "okdcccccccccccddko",
  "okdcdcdcdcdcdcddko",
  "okdcccccccccccddko",
  "okdcdcdcdcdcdcddko",
  "okdcccccccccccddko",
  "okddddddddddddddko",
  "okkkkkkkkkkkkkkkko",
  "oooooooooooooooooo",
  "......oo..oo......",
  "......kk..kk......",
  "......kk..kk......",
];

// A chunky Nokia-style brick phone — dark body, a cream screen panel, four
// rows of small keypad nubs below, a short antenna stub up top.
const nokia = [
  ".......mm.......",
  ".....oooooo.....",
  "....okkkkkko....",
  "....okdddddko...",
  "....okdcccDko...",
  "....okdcddDko...",
  "....okdcccDko...",
  "....okdddddko...",
  "....okkkkkko....",
  "....okddddddko..",
  "....okdcdcdcko..",
  "....okddddddko..",
  "....okdcdcdcko..",
  "....okddddddko..",
  "....okkkkkkkko..",
  "....oooooooooo..",
  ".....kkkkkkkk...",
];

// A round magnifying glass mounted on a short stand — a dark ring, cream lens
// interior, a warm-dark handle/post anchored to a small base.
const lens = [
  "....oooooooooo....",
  "...okkkkkkkkkko...",
  "..okddddddddddko..",
  "..okdcccccccddko..",
  "..okdcddddcdkko...",
  "..okdcdddddkko....",
  "..okdcddddckko....",
  "..okdcccccddkko...",
  "..okddddddddkko...",
  "...okkkkkkkkko....",
  ".....okkkkkko.....",
  "......okkkkko.....",
  ".......okkkko.....",
  "........oooo......",
  ".......okkkko.....",
  ".......okkkko.....",
  "......oooooooo....",
  "......kkkkkkkk....",
];

const region: RegionModule = {
  doors: [
    { label: "the log", prop: "landing_logbook", surface: "web.log", tx: 23, ty: 21 },
    { label: "the archive", prop: "landing_monolith", surface: "web.home", tx: 31, ty: 21 },
    { label: "about Fluncle", prop: "landing_board", surface: "web.about", tx: 24, ty: 26 },
    {
      card: "mobile",
      label: "the mobile app",
      prop: "landing_nokia",
      status: "gated",
      tx: 31,
      ty: 26,
    },
    {
      card: "lens",
      label: "Fluncle Lens",
      prop: "landing_lens",
      status: "gated",
      tx: 26,
      ty: 22,
    },
  ],
  id: "landing",
  props: {
    landing_board: board,
    landing_lens: lens,
    landing_logbook: logbook,
    landing_monolith: monolith,
    landing_nokia: nokia,
  },
};

export default region;
