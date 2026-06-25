import { type RegionModule } from "./_shared";

// The Workshop (west) — the machines. The seed region: it demonstrates the full
// region pattern (pure char-grid props + doors pointing at cards) AND carries
// the canon terminal showcase (the CRT door, recolored off green per RFC D1).
// Prop ids are globally unique; the matching cards live in ../cards/workshop.tsx.
//
// Tile box (world.ts REGION_BOXES.workshop): x 3..17, y 15..32.

const crt = [
  "oooooooooooooooo",
  "oddddddddddddddo",
  "odpPpPpPpPpPpPdo",
  "odPpPpccPpPpPpdo",
  "odpPpPpPpPpPpPdo",
  "odPppPpPccpPpPdo",
  "odpPpPpPpPpPpPdo",
  "odPpccPpPpPpPpdo",
  "odpPpPpPpPpPpPdo",
  "oddddddddddddydo",
  "oooooooooooooooo",
  ".....oddddo.....",
  ".....oddddo.....",
  "...oddddddddo...",
  "..oddddddddddo..",
  "..oooooooooooo..",
  "...kkkkkkkkkk...",
];

const boombox = [
  ".....okkkkkko.......",
  ".....o......o.......",
  "oooooooooooooooooooo",
  "omyYymddccccddmyYymo",
  "omyYymddcrrcddmyYymo",
  "omyYymddccccddmyYymo",
  "odmyymddddddddmyymdo",
  "oddddddddddddddddddo",
  "oddyydddYYYYdddyyddo",
  "oddddddddddddddddddo",
  "oooooooooooooooooooo",
  ".kkkkkkkkkkkkkkkkkk.",
];

// A 3.5" floppy disk — dark plastic body, cream label with a gold stripe, the
// metal shutter up top.
const floppy = [
  "oooooooooooooo",
  "okkkkkddddddko",
  "okkkkkddddddko",
  "okkkkkkkkkkkko",
  "okccccccccccko",
  "okcddddddddcko",
  "okcdyyyyyydcko",
  "okcddddddddcko",
  "okcddddddddcko",
  "okccccccccccko",
  "okkkkkkkkkkkko",
  "okkkkokkkkkkko",
  "okkkkkkkkkkkko",
  "oooooooooooooo",
  "..kkkkkkkkkk..",
];

// A turntable — dark deck, a cream platter with a center spindle, a gold tonearm
// reaching from the corner, two control knobs.
const turntable = [
  "oooooooooooooooooooo",
  "okkkkkkkkkkkkkkkkmmo",
  "okkdddddddddkkkkkmyo",
  "okddddddddddddkkkmyo",
  "okdddddccddddddkkmyo",
  "okddddcooocddddkmyko",
  "okdddddcccddddmykkko",
  "okddddddddddddkkkkko",
  "okkddddddddddkkkkkko",
  "okkkkkkkkkkkkkkkyyko",
  "okkyykkkkkkkkkkkkkko",
  "okkyykkkkkkkkkkyykko",
  "oooooooooooooooooooo",
  ".kkkkkkkkkkkkkkkkkk.",
];

// A vintage radio — wood box, a cream speaker grille, a gold tuning dial, a thin
// antenna up top.
const radio = [
  "........mm........",
  ".......mmm........",
  "oooooooooooooooooo",
  "occcccccddyyyyyddo",
  "ocdcdcdcddyDDDyddo",
  "ocdcdcdcddyDDDyddo",
  "ocdcdcdcddyyyyyddo",
  "occcccccdddddddddo",
  "oddyyddddddddyyddo",
  "oooooooooooooooooo",
  ".oo..........oo...",
  ".kk..........kk...",
];

const region: RegionModule = {
  doors: [
    { card: "terminal", label: "the rave terminal", prop: "crt", tx: 6, ty: 19 },
    { card: "spotify", label: "Fluncle's Findings on Spotify", prop: "boombox", tx: 13, ty: 19 },
    { card: "cli", label: "the fluncle CLI", prop: "floppy", tx: 5, ty: 24 },
    { label: "the mixtapes", prop: "turntable", surface: "web.mixtapes", tx: 12, ty: 25 },
    { label: "the radio", prop: "radio", surface: "web.radio", tx: 8, ty: 29 },
  ],
  id: "workshop",
  props: { boombox, crt, floppy, radio, turntable },
};

export default region;
