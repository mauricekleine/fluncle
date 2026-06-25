import { type RegionModule } from "./_shared";

// The Edge (south) — the protocol surfaces. Four relay objects at the frontier
// of the Galaxy: the Tor onion mirror, the delegated DNS dig zone, the status
// board, and the MCP server terminal. All owned surfaces → all SurfaceCards.
// No custom card file needed.
//
// Tile box (world.ts REGION_BOXES.edge): x 20..35, y 34..45.
// South corridor mouth lands near x26-29, y34-35 — kept clear.
// Prop ids globally unique, prefixed edge_…

// A Tor onion — layered dome, cream inner flesh, warm-dark skin, gold band at
// the base, a pointed crown. Reads as an onion at a glance.
const onion = [
  "......ooooo.......",
  "....ooccccoo......",
  "...occcccccco.....",
  "..occcccccccco....",
  ".occccccccccccco..",
  ".occccccccccccco..",
  "occcccccccccccccco",
  "occcccccccccccccco",
  "occdddddddddddccco",
  "ocddddddddddddddco",
  "ocddddddddddddddco",
  "ocdddddddddddddcco",
  "occccccccccccccco.",
  ".oyyyyyyyyyyyyyyo.",
  ".oyyyyyyyyyyyyyo..",
  "..ooooooooooooo...",
  "...okkkkkkkkkko...",
  "....kkkkkkkkk.....",
];

// A vintage telephone switchboard — dark cabinet, rows of cream sockets, gold
// patch cables hanging, a rotary dial inset on the front panel.
const switchboard = [
  "oooooooooooooooooooo",
  "okkkkkkkkkkkkkkkkkko",
  "okddddddddddddddddko",
  "okdccccccccccccccko.",
  "okdcdcdcdcdcdcdcdko.",
  "okdcdcdcdcdcdcdcdko.",
  "okdccccccccccccccko.",
  "okdddddddddddddddko.",
  "okddddmyyyyymdddddko",
  "okddddyYYYYYyddddko.",
  "okddddyYoooYyddddko.",
  "okddddyYoooYyddddko.",
  "okddddyYYYYYyddddko.",
  "okddddmyyyyymdddddko",
  "okdddddddddddddddko.",
  "okddddddddddddddddko",
  "oooooooooooooooooooo",
  ".kkkkkkkkkkkkkkkkkk.",
];

// A server rack with blinking status lights — dark chassis, stacked panels,
// a cool-teal blink row, gold power indicator, cream ventilation grille.
const fusebox = [
  "oooooooooooooooooo",
  "okkkkkkkkkkkkkkkko",
  "okdddddddddddddkko",
  "okdccccccccccdkko.",
  "okdcdcdcdcdcddkko.",
  "okdccccccccccdkko.",
  "okttttttttttttkko.",
  "okdddddddddddddkko",
  "okdccccccccccdkko.",
  "okdcdcdcdcdcddkko.",
  "okdccccccccccdkko.",
  "okttttttttttttkko.",
  "okddddddddddyddkko",
  "okddddddddddyddkko",
  "okdddddddddddddkko",
  "oooooooooooooooooo",
  "..kkkkkkkkkkkkkk..",
];

// A small boxy robot / dumb terminal — dark chassis, cream screen face with a
// dim scanline grid, two stubby antenna prongs on top, cream keypad below.
const terminal = [
  "....oo......oo....",
  "....oo......oo....",
  "oooooooooooooooooo",
  "okkkkkkkkkkkkkkkko",
  "okddddddddddddddko",
  "okdcccccccccccdkko",
  "okdcddddddddcdkko.",
  "okdcddddddddcdkko.",
  "okdcddddddddcdkko.",
  "okdcccccccccccdkko",
  "okddddddddddddddko",
  "okdccccdddddddddko",
  "okdcddcddddddddko.",
  "okdcddcddddddddko.",
  "okdccccdddddddddko",
  "okddddddddddddddko",
  "oooooooooooooooooo",
  "..kkkkkkkkkkkkkk..",
];

const region: RegionModule = {
  doors: [
    { label: "the onion", prop: "edge_onion", surface: "subdomain.onion", tx: 24, ty: 43 },
    { label: "the dig zone", prop: "edge_switchboard", surface: "dns.zone", tx: 31, ty: 43 },
    { label: "the status board", prop: "edge_fusebox", surface: "web.status", tx: 22, ty: 38 },
    { label: "the MCP server", prop: "edge_terminal", surface: "mcp.server", tx: 33, ty: 38 },
  ],
  id: "edge",
  props: {
    edge_fusebox: fusebox,
    edge_onion: onion,
    edge_switchboard: switchboard,
    edge_terminal: terminal,
  },
};

export default region;
