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
import { identityKeyFor, type IdentityPageData } from "./-identity-page-data";

// The identity answer page, rendered through a router (TanStack `<Link>` needs one) so the
// assertions run over the REAL server HTML a crawler and a JS-blind reader receive.
//
// Four contracts, and each of them is the point of the page rather than a detail of it:
//
//   1. THE REGISTER CARRIES THE TIER. A certified recording renders lit — its coordinate, and a
//      link home to its `/log` page. An uncertified one renders unlit and carries NEITHER, and
//      no noun anywhere names the tier it belongs to (DESIGN.md's Unlit Rule; the unnamed tier in
//      docs/album-entity.md). A page that let an uncertified row wear a coordinate would be the
//      failure, and it would be invisible to a type check.
//   2. THE HONEST NEGATIVE IS SAID OUT LOUD, AS A RECEIPT. Every state the envelope can carry
//      reaches the page as status fragments joined by middots — not found, not eligible, not
//      checked yet, retired. A blank is the one answer this surface exists not to give, so a state
//      rendering as nothing is a regression, and so is a fragment that upgrades an attempt stamp
//      ("checked") into a verification ("confirmed").
//   3. THE COVERAGE SET IS THE PAGE'S SCOPE. Tidal never renders here: a "not covered"
//      row is the API contract leaking into a human surface. The API still answers it
//      `unsupported` — that half is pinned in lib/server/identity-envelope.integration.test.ts.
//      Deezer joined the covered set on 2026-07-30 and now renders like any other link row.
//   4. NEITHER DEGRADED STATE IS A FAULT. A key that matches nothing and a caller who has spent
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

/**
 * A recording with every state parked at its quietest, for a case to override one at a time.
 *
 * Apple sits at `unattempted` rather than `unsupported` because the PAGE reads the envelope
 * first-party, and that read computes Apple's real state; `unsupported` for Apple is a machine-only
 * answer. Deezer sits at `unattempted` for the same kind of reason — it is a covered platform whose
 * quietest state is "nobody has looked". YouTube sits there too, and for it that state covers the
 * most ground: no id, an id whose officialness check was refused, and an id never checked all read
 * `unattempted`, because none of them is a look Fluncle ran on the reader's behalf. Tidal keeps the
 * `unsupported` the envelope really serves it, so the coverage-set assertions below run against the
 * true shape rather than a doctored one.
 */
function recording(overrides: Partial<IdentityRecording> = {}): IdentityRecording {
  return {
    artists: ["Calibre"],
    certified: false,
    identifiers: {
      isrc: { state: "unattempted" },
      mbRecordingId: { state: "unattempted" },
    },
    links: {
      appleMusic: { state: "unattempted" },
      beatport: { state: "unattempted" },
      deezer: { state: "unattempted" },
      discogs: { state: "unattempted" },
      spotify: { state: "unattempted" },
      tidal: { state: "unsupported" },
      youtube: { state: "unattempted" },
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
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
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
            youtube: { state: "unattempted" },
          },
          logId: "004.7.2I",
        }),
      ]),
    );

    expect(html).toContain("Calibre — Mr Maverick");
    expect(html).toContain('href="/log/004.7.2I"');
    expect(html).toContain("fluncle://004.7.2I");
    expect(html).not.toContain("identity-title--unlit");
    // A found answer carries NO intro line: one block is visibly one recording, and a sentence
    // restating the count is the Recap Tell. Words under the key are reserved for the miss, the
    // spent dials, and the unruled plural — the facts the layout cannot show.
    expect(html).not.toContain("log-index-intro");
    // The Spotify link SERVES as the hop, never the raw platform URL (RFC ruling 7).
    expect(html).toContain('href="https://www.fluncle.com/out/spotify/track-1"');
    expect(html).toContain("Listen on Spotify");
    // A method fragment and a date fragment, joined by the middot. The stamp is a VERIFICATION time
    // here, so it reads "confirmed" rather than "checked".
    expect(html).toContain("from Spotify&#x27;s own record · confirmed Jul 1, 2026");
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

  it("renders only the covered platforms, never a not-covered row", async () => {
    // Tidal is `unsupported` on the wire and ABSENT from the page: a row saying Fluncle does not
    // cover it is the API contract leaking into a human surface, and it reads as a promise to add
    // it. Scope is stated once in /docs/identity instead.
    const html = await renderPage(found([recording()]));

    expect(html).not.toContain("Tidal");
    expect(html).not.toContain("Not covered");
    // The eight rows that ARE the coverage set. Deezer, Beatport, and YouTube each earn a row off
    // a real column (`tracks.deezer_track_id`, `tracks.beatport_url`, `tracks.youtube_video_id`),
    // so they render their honest state like every other one.
    for (const label of [
      "ISRC",
      "MusicBrainz",
      "Spotify",
      "Apple Music",
      "Deezer",
      "Discogs",
      "Beatport",
      "YouTube",
    ]) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }
  });

  it("carries a held Beatport link out as a BUY, never a listen", async () => {
    // Beatport is a store. Labelling its link the way the players are labelled would promise a
    // reader a play and hand them a checkout — a small lie, on the one page whose entire job is not
    // telling them.
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: {
              state: "verified",
              url: "https://www.beatport.com/track/pluto/19385810",
              value: "https://www.beatport.com/track/pluto/19385810",
              verification: {
                at: "2026-07-30T00:00:00.000Z",
                atMeaning: "verified",
                method: "isrc",
                source: null,
              },
            },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://www.beatport.com/track/pluto/19385810"');
    expect(html).toContain("Buy on Beatport");
    expect(html).not.toContain("Listen on Beatport");
    // The only method this leg has, said plainly, with the write's own date beside it.
    expect(html).toContain("matched by ISRC · confirmed Jul 30, 2026");
  });

  it("carries a held YouTube link out as a WATCH, under the fingerprint that won it", async () => {
    // YouTube is a video surface, so the label names watching. The method fragment is the one in
    // this whole set whose evidence is the SOUND — Fluncle's own capture matched the audio — and it
    // spends neither `confirmed` nor `checked`, which the date fragment beside it owns.
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: {
              state: "verified",
              url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              value: "dQw4w9WgXcQ",
              verification: {
                at: "2026-07-31T00:00:00.000Z",
                atMeaning: "verified",
                method: "fingerprint",
                source: null,
              },
            },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(html).toContain("Watch on YouTube");
    expect(html).not.toContain("Listen on YouTube");
    expect(html).toContain("matched by audio fingerprint · confirmed Jul 31, 2026");
  });

  it("says nothing at all about a YouTube id it has not cleared", async () => {
    // THE PRODUCT RAIL. A fingerprint match proves the audio; it proves nothing about whether the
    // upload is legitimate, because a rip carries the same bytes as the master. So an id whose
    // officialness check came back refused or never concluded is INTERNAL provenance: the envelope
    // hands the page `unattempted`, and the page must render no link, no id, and no hint that
    // Fluncle is sitting on one.
    const html = await renderPage(found([recording()]));

    expect(html).toContain("<dt>YouTube</dt>");
    expect(html).not.toContain("youtube.com/watch");
    expect(html).not.toContain("Watch on YouTube");
  });

  it("says a Beatport miss without promising another look", async () => {
    // No re-check cadence is ruled for this leg, so the receipt states the attempt and stops. A
    // "will be checked again" here would be an invented promise.
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: {
              attempts: 1,
              cap: null,
              lastAttemptedAt: "2026-07-30T00:00:00.000Z",
              retry: "single-shot",
              state: "absent",
              terminal: null,
            },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain("Not found · checked Jul 30, 2026");
    expect(html).not.toContain("will be checked again");
    expect(html).not.toContain("retired");
  });

  it("carries a held Deezer link out, with the rung that won it", async () => {
    // The link is the whole point of keeping the id, and the fragment beside it must say which gate
    // cleared rather than flattening a full-triple match into the same word as a looser one.
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: {
              state: "verified",
              url: "https://www.deezer.com/track/3135556",
              value: "3135556",
              verification: {
                at: "2026-07-30T00:00:00.000Z",
                atMeaning: "verified",
                method: "search",
                source: null,
              },
            },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://www.deezer.com/track/3135556"');
    expect(html).toContain("Listen on Deezer");
    expect(html).toContain("matched by artist, title, and length · confirmed Jul 30, 2026");
  });

  it("says a Deezer miss was checked, never confirmed, and promises no second look", async () => {
    // The receipt's reserved-word rule decides this line. An ATTEMPT stamp is when a look concluded
    // and may only ever read "checked"; "confirmed" is reserved for the moment something was WRITTEN,
    // and spending it on a miss would tell the reader Fluncle had confirmed an absence he merely
    // failed to fill. No re-check cadence is ruled for this leg either, so a "will be checked again"
    // here would be an invented promise.
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: {
              attempts: 1,
              cap: null,
              lastAttemptedAt: "2026-07-30T00:00:00.000Z",
              retry: "single-shot",
              state: "absent",
              terminal: null,
            },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain("Not found · checked Jul 30, 2026");
    expect(html).not.toContain("confirmed Jul 30, 2026");
    expect(html).not.toContain("will be checked again");
    expect(html).not.toContain("retired");
    // The miss must not leave the row reading like nobody had ever looked — that lie is the reason
    // the ledger exists. Every other row on this fixture is `unattempted`, so the phrase is present;
    // what matters is that the Deezer row is no longer one of them.
    expect(html).not.toContain("Listen on Deezer");
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
            mbRecordingId: {
              cap: null,
              lastAttemptedAt: "2026-07-18T00:00:00.000Z",
              retry: "single-shot",
              state: "absent",
              terminal: true,
            },
          },
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: {
              attempts: 2,
              cap: null,
              lastAttemptedAt: "2026-07-18T00:00:00.000Z",
              retry: "single-shot",
              state: "absent",
              terminal: null,
            },
            spotify: { reason: "attempt-cap-reached", state: "refused" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    // A miss that will be asked again: the date is a LAST check, and the outlook says so.
    expect(html).toContain("Not found · last checked Jul 12, 2026 · will be checked again");
    // A miss with a terminal verdict on file earns the one word that claims "never again".
    expect(html).toContain("Not found · checked Jul 18, 2026 · retired");
    // A tally is printed only where a monotone counter backs it, and `single-shot` with no terminal
    // column says nothing about the future rather than guessing in either direction.
    expect(html).toContain("Not found · checked 2 times, last Jul 18, 2026");
    // The cap refusal is still a miss: looked, repeatedly, and stopped.
    expect(html).toContain("Not found · checked as many times as allowed · retired");
    expect(html).toContain("Not checked yet");
  });

  it("keeps a capped miss under its ceiling instead of retiring it early", async () => {
    // Spotify's absent state carries a cap and `terminal: false` — more looks ARE coming, so the
    // line must not borrow the "retired" word, and it must not print a tally either (the counter is
    // a spend budget the requeue decrements, so the envelope withholds it).
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: {
              cap: 6,
              lastAttemptedAt: "2026-07-12T00:00:00.000Z",
              retry: "capped",
              state: "absent",
              terminal: false,
            },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain(
      "Not found · last checked Jul 12, 2026 · will be checked again, up to 6 times in all",
    );
    expect(html).not.toContain("retired");
    expect(html).not.toContain("times, last");
  });

  it("keeps the method fragment off the two words the date fragment owns", async () => {
    // `confirmed` and `checked` carry the verified-vs-attempted distinction, so no method fragment
    // may spend either word. And `pk-derived` states the one thing its row cannot say by naming its
    // own platform back at the reader: the identifier IS where the recording came from.
    const html = await renderPage(
      found([
        recording({
          identifiers: {
            isrc: { state: "unattempted" },
            mbRecordingId: {
              state: "verified",
              url: "https://musicbrainz.org/recording/0f7d",
              value: "0f7d",
              verification: {
                at: "2026-07-12T00:00:00.000Z",
                atMeaning: "attempted",
                method: "pk-derived",
                source: null,
              },
            },
          },
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: {
              state: "verified",
              url: "https://www.fluncle.com/out/spotify/track-1",
              value: "abc",
              verification: {
                at: "2026-07-01T00:00:00.000Z",
                atMeaning: "verified",
                method: "operator",
                source: null,
              },
            },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain("the id it arrived under · checked Jul 12, 2026");
    expect(html).toContain("set by hand · confirmed Jul 1, 2026");
    expect(html).not.toContain("confirmed by hand");
    // The MusicBrainz row never restates its own label back at the reader.
    expect(html).not.toContain("from MusicBrainz");
  });

  it("says an unrecorded provenance and an unsearchable credit without either going vague", async () => {
    // `unknown-legacy` is the ISRC row's ONLY verified method (isrcState hard-codes it) and the
    // Discogs row's too, so it is the most-rendered state on this page. It makes NO method claim:
    // no column records how the row came to be trusted, so the receipt carries only its date. And
    // `credit-not-an-identity` names the missing thing rather than gesturing at "nothing to go on".
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
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { reason: "credit-not-an-identity", state: "refused" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    // The stamp is an ATTEMPT time even on a hit (the only ISRC timestamp Fluncle keeps), so it
    // reads "checked" and never "confirmed", and it stands alone with no method beside it.
    expect(html).toContain('<span class="identity-provenance">checked Jul 12, 2026</span>');
    expect(html).toContain("GBXXX0000000");
    expect(html).toContain("Not eligible · no artist credit to search on");
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
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://music.apple.com/us/album/x/1?i=2"');
    // One action, one label (VOICE.md's Chrome Rule) — the same string every other surface uses.
    expect(html).toContain("Listen on Apple Music");
    expect(html).toContain("matched by ISRC · confirmed May 1, 2026");
    expect(html).not.toContain("Not covered");
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
    // No count rides along: two blocks are visibly two blocks, and only the ruling needs words.
    expect(html).toContain("Fluncle has not ruled between these recordings.");
    expect(html.match(/has not ruled between these recordings/g)).toHaveLength(1);
    // The same status vocabulary the `duplicate` refusal carries, said at block scale.
    expect(html).toContain("Held as a duplicate of");
    expect(html).toContain('href="/identity/track-1"');
  });

  it("answers an unknown identifier honestly instead of erroring", async () => {
    const html = await renderPage({ key: "GBXXX0000000", kind: "isrc", status: "missing" });

    expect(html).toContain("Nothing on file under this identifier.");
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

// ── THE DOOR'S KEY ROUTING ─────────────────────────────────────────────────────────────────────
// One field takes every kind of key, so which kind was typed is worked out from the value. The
// grammar itself is unit-tested (lib/identity-key.test.ts); what is pinned here is the DISPATCH —
// that each shape reaches the read predicate meant for it, because a pasted link routed to the
// reference branch would answer "nothing on file" about a recording the archive plainly holds.
describe("the door's key routing", () => {
  it("routes each shape to its own read", () => {
    expect(identityKeyFor("gb-abc-12-34567")).toEqual({
      key: { isrcs: ["GBABC1234567"], kind: "isrc" },
      kind: "isrc",
    });
    expect(identityKeyFor("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toEqual({
      key: { kind: "mbid", mbid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      kind: "mbid",
    });
    expect(
      identityKeyFor("https://open.spotify.com/intl-nl/track/4cOdK2wGLETKBW3PvgPWqT?si=x"),
    ).toEqual({
      key: { kind: "spotify", spotifyId: "4cOdK2wGLETKBW3PvgPWqT" },
      kind: "platform",
    });
    expect(identityKeyFor("https://www.deezer.com/nl/track/3135556")).toEqual({
      key: { deezerId: "3135556", kind: "deezer" },
      kind: "platform",
    });
  });

  it("leaves a bare string a reference key, coordinate or track id alike", () => {
    expect(identityKeyFor("004.7.2I")).toEqual({
      key: { idOrLogId: "004.7.2I", kind: "idOrLogId" },
      kind: "reference",
    });
    // A bare Spotify id IS Fluncle's own track id for a published finding, so it stays a reference
    // key rather than being claimed by the platform branch.
    expect(identityKeyFor("4cOdK2wGLETKBW3PvgPWqT")).toEqual({
      key: { idOrLogId: "4cOdK2wGLETKBW3PvgPWqT", kind: "idOrLogId" },
      kind: "reference",
    });
  });
});
