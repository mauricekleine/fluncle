import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdentityAnswer } from "./identity.$key";
import { type IdentityEnvelope, type IdentityRecording } from "@/lib/server/identity-envelope";
import { type IdentityPageData } from "./-identity-page-data";

// The identity answer page, rendered through a router (TanStack `<Link>` needs one) so the
// assertions run over the REAL server HTML a crawler and a JS-blind reader receive.
//
// Three contracts, and each of them is the point of the page rather than a detail of it:
//
//   1. THE REGISTER CARRIES THE TIER. A certified recording renders lit — its coordinate, and a
//      link home to its `/log` page. An uncertified one renders unlit and carries NEITHER, and
//      no noun anywhere names the tier it belongs to (DESIGN.md's Unlit Rule; the unnamed tier in
//      docs/album-entity.md). A page that let an uncertified row wear a coordinate would be the
//      failure, and it would be invisible to a type check.
//   2. THE HONEST NEGATIVE IS SAID OUT LOUD. Every state the envelope can carry reaches the page
//      as a sentence — looked and missed, will not look, nobody has looked, no such link served.
//      A blank is the one answer this surface exists not to give, so a state rendering as nothing
//      is a regression.
//   3. NEITHER DEGRADED STATE IS A FAULT. A key that matches nothing and a caller who has spent
//      the dials both render as a calm page with a way back, never an error boundary.

const ROUTE_PATHS = ["/", "/identity", "/identity/$key", "/log/$logId", "/docs/$"];

async function renderPage(data: IdentityPageData): Promise<string> {
  const rootRoute = createRootRoute({ component: () => <IdentityAnswer data={data} /> });
  const children = ROUTE_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren(children),
  });

  await router.load();

  return renderToString(<RouterProvider router={router} />);
}

/** A recording with every state parked at its quietest, for a case to override one at a time. */
function recording(overrides: Partial<IdentityRecording> = {}): IdentityRecording {
  return {
    artists: ["Calibre"],
    certified: false,
    identifiers: {
      isrc: { state: "unattempted" },
      mbRecordingId: { state: "unattempted" },
    },
    links: {
      appleMusic: { state: "unsupported" },
      deezer: { state: "unsupported" },
      discogs: { state: "unattempted" },
      spotify: { state: "unattempted" },
      tidal: { state: "unsupported" },
    },
    logId: null,
    relation: "canonical",
    title: "Mr Maverick",
    trackId: "track-1",
    ...overrides,
  };
}

function envelope(recordings: IdentityRecording[]): IdentityEnvelope {
  return {
    meta: {
      asOf: "2026-07-29T00:00:00.000Z",
      attribution: "Recording identifiers include data from MusicBrainz (musicbrainz.org).",
      contact: "hey@fluncle.com",
    },
    recordings,
  };
}

function found(recordings: IdentityRecording[]): IdentityPageData {
  return { envelope: envelope(recordings), key: "GBXXX0000000", kind: "isrc", status: "found" };
}

describe("the identity answer", () => {
  it("renders a certified recording lit: its coordinate, and the link home", async () => {
    const html = await renderPage(
      found([
        recording({
          certified: true,
          links: {
            appleMusic: { state: "unsupported" },
            deezer: { state: "unsupported" },
            discogs: { state: "unattempted" },
            spotify: {
              state: "verified",
              url: "https://www.fluncle.com/out/spotify/track-1",
              value: "abc",
              verification: {
                at: "2026-07-01T00:00:00.000Z",
                atMeaning: "verified",
                method: "publish",
                source: null,
              },
            },
            tidal: { state: "unsupported" },
          },
          logId: "004.7.2I",
        }),
      ]),
    );

    expect(html).toContain("Calibre — Mr Maverick");
    expect(html).toContain('href="/log/004.7.2I"');
    expect(html).toContain("fluncle://004.7.2I");
    expect(html).not.toContain("identity-title--unlit");
    // The Spotify link SERVES as the hop, never the raw platform URL (RFC ruling 7).
    expect(html).toContain('href="https://www.fluncle.com/out/spotify/track-1"');
    expect(html).toContain("Listen on Spotify");
    expect(html).toContain(
      "Fluncle brought this home with the find, straight from the platform&#x27;s own record",
    );
  });

  it("renders an uncertified recording unlit: no coordinate, no link home, no noun for the tier", async () => {
    const html = await renderPage(found([recording()]));

    expect(html).toContain("Calibre — Mr Maverick");
    expect(html).toContain("identity-title--unlit");
    // The two things a recording Fluncle has not certified never gets.
    expect(html).not.toContain("fluncle://");
    expect(html).not.toContain('href="/log/');
    // And no name for what it is. The internal word for this tier never reaches a public page.
    expect(html.toLowerCase()).not.toContain("catalogue");
    expect(html.toLowerCase()).not.toContain("uncertified");
  });

  it("says every negative out loud rather than leaving a gap", async () => {
    const html = await renderPage(
      found([
        recording({
          identifiers: {
            isrc: {
              cap: null,
              lastAttemptedAt: "2026-07-12T00:00:00.000Z",
              retry: "recheckable",
              state: "absent",
              terminal: null,
            },
            mbRecordingId: { state: "unattempted" },
          },
          links: {
            appleMusic: { state: "unsupported" },
            deezer: { state: "unsupported" },
            discogs: { state: "unattempted" },
            spotify: { reason: "attempt-cap-reached", state: "refused" },
            tidal: { state: "unsupported" },
          },
        }),
      ]),
    );

    expect(html).toContain("Fluncle looked, last on Jul 12, 2026, and came back empty-handed.");
    expect(html).toContain("He will keep looking. A miss today is not a miss forever.");
    expect(html).toContain("Fluncle is not looking.");
    expect(html).toContain("He has looked as many times as he allows himself.");
    expect(html).toContain("Nobody has gone looking yet.");
    // Each `unsupported` platform says its OWN reason rather than sharing a template: Deezer Fluncle
    // only ever looks WITH, and Tidal he has no way in to. (Apple's own sentence is carried too, for
    // the machine answer and for a re-ruled posture, but this PAGE reads the envelope first-party and
    // so never receives `unsupported` for Apple — see the Apple case below.)
    expect(html).toContain(
      "Fluncle uses Deezer to check a recording&#x27;s identity, never to send you there, so he keeps no Deezer link at all.",
    );
    expect(html).toContain(
      "Fluncle has no way in to Tidal, so he has nothing to tell you about it.",
    );
  });

  it("says an unrecorded provenance and an unsearchable credit without either going vague", async () => {
    // The two phrases most easily left as a shrug. `unknown-legacy` is the ISRC row's ONLY verified
    // method (isrcState hard-codes it) and the Discogs row's too, so it is the single most-rendered
    // sentence on this page; it must say what Fluncle did not write down WITHOUT implying anything
    // about the check itself. And `credit-not-an-identity` has to name the missing thing (a real
    // artist name) rather than gesture at "nothing to go on".
    const html = await renderPage(
      found([
        recording({
          identifiers: {
            isrc: {
              state: "verified",
              value: "GBXXX0000000",
              verification: {
                at: "2026-07-12T00:00:00.000Z",
                atMeaning: "attempted",
                method: "unknown-legacy",
                source: null,
              },
            },
            mbRecordingId: { state: "unattempted" },
          },
          links: {
            appleMusic: { state: "unattempted" },
            deezer: { state: "unsupported" },
            discogs: { state: "unattempted" },
            spotify: { reason: "credit-not-an-identity", state: "refused" },
            tidal: { state: "unsupported" },
          },
        }),
      ]),
    );

    // The date rides as its own clause, so the sentence has to stay readable with it attached: the
    // stamp is an ATTEMPT time even on a hit (the only ISRC timestamp Fluncle keeps), hence "last
    // checked" rather than "confirmed".
    expect(html).toContain(
      "Fluncle never wrote down how he came by this one, last checked Jul 12, 2026.",
    );
    expect(html).toContain("GBXXX0000000");
    expect(html).toContain("Fluncle is not looking. He has no real artist name to search on here.");
  });

  it("renders an Apple Music link the API withholds, under its ratified label", async () => {
    // The page reads the envelope FIRST-PARTY (-identity-page-data.ts), so an Apple link renders
    // here exactly as it does on the recording's `/log` page. The API's machine read still answers
    // `unsupported` for Apple — that half is pinned in identity-envelope.integration.test.ts.
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: {
              state: "verified",
              url: "https://music.apple.com/us/album/x/1?i=2",
              value: "https://music.apple.com/us/album/x/1?i=2",
              verification: {
                at: "2026-05-01T00:00:00.000Z",
                atMeaning: "verified",
                method: "isrc",
                source: null,
              },
            },
            deezer: { state: "unsupported" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://music.apple.com/us/album/x/1?i=2"');
    // One action, one label (VOICE.md's Chrome Rule) — the same string every other surface uses.
    expect(html).toContain("Listen on Apple Music");
    expect(html).toContain(
      "Fluncle matched this on the recording&#x27;s own ISRC, confirmed May 1, 2026.",
    );
    expect(html).not.toContain("hands none of them out here");
  });

  it("names the relation when one identifier answered with more than one recording", async () => {
    const html = await renderPage(
      found([
        recording({ relation: "ambiguous", trackId: "track-1" }),
        recording({ relation: "duplicate-of:track-1", title: "Mr Maverick (VIP)", trackId: "t2" }),
      ]),
    );

    // Ambiguity is a property of the ANSWER, so it is stated once in the opening line rather than
    // repeated over every block; only the duplicate verdict, which is about one row, renders below.
    expect(html).toContain(
      "2 recordings answer to this identifier, and Fluncle has not ruled between them.",
    );
    expect(html.match(/has not ruled between them/g)).toHaveLength(1);
    expect(html).toContain("down as a duplicate of");
    expect(html).toContain('href="/identity/track-1"');
  });

  it("answers an unknown identifier honestly instead of erroring", async () => {
    const html = await renderPage({ key: "GBXXX0000000", kind: "isrc", status: "missing" });

    expect(html).toContain("Fluncle has nothing that answers to this identifier.");
    expect(html).toContain("GBXXX0000000");
    // No invitation to send the recording in: a wrong guess must never seed the crew's triage
    // queue, which is why the op 404s a stray key without a submission affordance too.
    expect(html).not.toContain("Submit a track");
    // The lookup field is still there, so a mistyped key is one correction away.
    expect(html).toContain('action="/identity"');
  });

  it("renders a spent allowance as a calm page, not a fault", async () => {
    const html = await renderPage({ status: "limited" });

    expect(html).toContain("That is a lot of lookups from one place in one go.");
    expect(html).toContain('href="/"');
    // Nothing to look up with while the meter is spent — the form would only spend more.
    expect(html).not.toContain('action="/identity"');
  });
});
