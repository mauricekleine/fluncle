import { type RegionModule } from "./_shared";

// The Comms region (east) — the channels. Five props broadcasting outward:
// the newsletter mailbox, the Telegram pager, the video camcorder, the
// Instagram polaroids, and the crew's Discord robot. The newsletter mailbox
// reads the registry via SurfaceCard; the rest have custom cards in
// ../cards/comms.tsx.
//
// Tile box (world.ts REGION_BOXES.comms): x 38..52, y 15..32.
// West corridor mouth (x 32..39, y 22..25) — all props clear of x38-39.
// Prop ids globally unique, prefixed comms_…

// A mailbox on a post with a flag up — dark metal body, cream flag arm,
// a gold slot on the front. The post is slim; the box sits proud at the top.
const mailbox = [
  "....oooooooooo....",
  "....okkkkkkkko....",
  "....okccccccko....",
  "....okcdddddko....",
  "....okcdddddko....",
  "....okccccccko....",
  "....okkkkkyyko....",
  "....okkkkkyyko....",
  "....ooooooooo.....",
  ".......okko.......",
  ".......okko.......",
  ".......okko.......",
  ".......okko.......",
  "......ookkoo......",
  ".....okkkkko......",
  ".....oooooo.......",
];

// A handheld pager / CB radio — dark plastic body, a cream screen with a dim
// gold glow, a row of function keys below the screen, a little antenna nub.
const pager = [
  "..oooooooooooo",
  "..okkkkkkkkkko",
  "..okccccccccko",
  "..okcddddddcko",
  "..okcddddddcko",
  "..okccccccccko",
  "..okkkkkkkkkko",
  "..okyyyyyydkko",
  "..okyyyyyydkko",
  "..okdddddddkko",
  "..okdcdcdcdkko",
  "..okdcdcdcdkko",
  "..okdddddddkko",
  "..oooooooooooo",
];

// A boxy camcorder — dark chassis, a round lens on the left, a cream
// viewfinder eyepiece on the right, a red tally dot on top.
const camcorder = [
  "...rrr............",
  "...rrr............",
  "..................",
  "oooooooooooooooooo",
  "okkkkkkkkkkkkkkkko",
  "oooookkkkkkkkkkko.",
  "occoookkkkkkkkkko.",
  "ococookkkkkcccko..",
  "occoookkkkkcdcko..",
  "oooookkkkkkccckko.",
  "okkkkkkkkkkkkkkkko",
  "okkkkkkkkkkkkkkkko",
  "oooooooooooooooooo",
  "..kkkkkkkkkkkkkk..",
];

// A pinned row of polaroid photos — three small framed squares with cream
// borders, dim covers inside each frame, a gold pin at each top corner.
const polaroids = [
  ".y...y...y...y....",
  "oooo.oooo.oooo....",
  "occo.occo.occo....",
  "oddo.oddo.oddo....",
  "oddo.oddo.oddo....",
  "oddo.oddo.oddo....",
  "occo.occo.occo....",
  "occo.occo.occo....",
  "oooo.oooo.oooo....",
  "..................",
  "..................",
  ".kkkkkkkkkkkk.....",
];

// A friendly boxy robot — dark chassis, cream face screen with two eye dots,
// a pair of stubby antenna prongs on top, a cream keypad chest panel.
const robot = [
  ".....mm.mm........",
  ".....oo.oo........",
  "..oooooooooo......",
  "..okkkkkkkko......",
  "..okddddddko......",
  "..okdccccddko.....",
  "..okdcoocdko......",
  "..okdccccddko.....",
  "..okddddddko......",
  "..okkkkkkkko......",
  "oooooooooooooo....",
  "okccccccccccko....",
  "okcdcdcdcdcko.....",
  "okccccccccccko....",
  "oooooooooooooo....",
  "....okko..okko....",
  "....okko..okko....",
  "....oooo..oooo....",
];

const region: RegionModule = {
  doors: [
    { label: "the newsletter", prop: "comms_mailbox", surface: "web.newsletter", tx: 42, ty: 18 },
    { card: "telegram", label: "the Telegram channel", prop: "comms_pager", tx: 48, ty: 18 },
    { card: "video", label: "the video channels", prop: "comms_camcorder", tx: 42, ty: 24 },
    { card: "instagram", label: "Instagram", prop: "comms_polaroids", tx: 48, ty: 24 },
    {
      card: "discord",
      label: "the crew on Discord",
      prop: "comms_robot",
      status: "gated",
      tx: 45,
      ty: 29,
    },
  ],
  id: "comms",
  props: {
    comms_camcorder: camcorder,
    comms_mailbox: mailbox,
    comms_pager: pager,
    comms_polaroids: polaroids,
    comms_robot: robot,
  },
};

export default region;
