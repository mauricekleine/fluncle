// The identity answer, rendered — one recording's identifiers and its links out, with the honest
// negative said in words rather than left as a gap.
//
// THE WHOLE POINT OF THIS FILE is the four states that are not "here it is". A link resolver that
// only prints what it holds leaves a reader unable to tell "we never looked" from "we looked and it
// is genuinely not there", and those are opposite facts. Every line below is computed from a real
// column in the envelope (lib/server/identity-envelope.ts holds the discipline); where no column
// backs a claim, the copy says Fluncle keeps no record rather than inventing one.
//
// ── THE REGISTER ──────────────────────────────────────────────────────────────────────────────
// A catalogue page (VOICE.md §5, the Three Areas): the page states what the thing is, plainly.
// Fluncle appears in the third person as the one who did the looking, never as narrator, and there
// is no nameplate and no first-person intro.
//
// ── THE UNLIT RULE (DESIGN.md) ────────────────────────────────────────────────────────────────
// A recording Fluncle has certified reads LIT: cream ink and its coordinate, linking home to its
// `/log` page. One he has not reads UNLIT: stardust ink, no coordinate, no gold at rest or on
// hover, and its only way onward is the link OUT that its own state carries. The tier itself is
// never named, headed, or counted — the distinction is carried by the register, not by a noun.

import { Link } from "@tanstack/react-router";
import { artistTitleLine } from "@/lib/log-prose";
import { formatDateLong } from "@/lib/format";
import {
  type IdentityMethod,
  type IdentityRecording,
  type IdentityRetry,
  type IdentityState,
} from "@/lib/server/identity-envelope";
import { type AnchorRefusalReason } from "@/lib/server/track-work";

/** The rows of one recording's answer, in reading order: what it IS, then where it goes. */
const IDENTIFIER_ROWS = [
  { key: "isrc", label: "ISRC" },
  { key: "mbRecordingId", label: "MusicBrainz" },
] as const;

const LINK_ROWS = [
  { key: "spotify", label: "Spotify" },
  { key: "appleMusic", label: "Apple Music" },
  { key: "deezer", label: "Deezer" },
  { key: "discogs", label: "Discogs" },
  { key: "tidal", label: "Tidal" },
] as const;

/** The literal label on the link a `verified` state carries. "Listen on Spotify" is the ratified
 *  string for that action across the app (VOICE.md's Chrome Rule: one action, one label). */
const OPEN_LABEL: Record<string, string> = {
  "Apple Music": "Listen on Apple Music",
  Discogs: "Open on Discogs",
  MusicBrainz: "Open on MusicBrainz",
  Spotify: "Listen on Spotify",
};

/**
 * How a link or identifier came to be trusted, in words a reader already has. The enum values are
 * the machine's; these are the deeds behind them.
 */
function methodPhrase(method: IdentityMethod): string {
  switch (method) {
    case "isrc":
      return "Matched on the recording's own ISRC";

    case "operator":
      return "Checked by hand";

    case "pk-derived":
      return "This is the id the recording came into the archive under";

    case "publish":
      return "It came in with the find, read back from the platform itself";

    case "search":
      return "Matched on artist, title, and length";

    case "search-subset":
      return "Matched on title and length, with a partial artist match";

    default:
      return "Fluncle keeps no record of how";
  }
}

/** The timestamp clause, honest about what the date actually marks. */
function whenPhrase(at: null | string, atMeaning: "attempted" | "verified" | null): string {
  if (!at || !atMeaning) {
    return "";
  }

  return atMeaning === "verified"
    ? `, confirmed ${formatDateLong(at)}`
    : `, last checked ${formatDateLong(at)}`;
}

/** What happens after a miss, off the retry class the acquisition queue itself is built on. */
function retryPhrase(retry: IdentityRetry, cap: null | number): string {
  if (retry === "single-shot") {
    return "He asked once and will not ask again.";
  }

  if (retry === "capped") {
    return cap ? `He will look again, up to ${cap} times in all.` : "He will look again.";
  }

  return "He will look again.";
}

/** Which condition of this recording's own row stops Fluncle looking. A closed set. */
function refusalPhrase(reason: AnchorRefusalReason): string {
  switch (reason) {
    case "attempt-cap-reached":
      return "He has looked as many times as he allows himself.";

    case "credit-not-an-identity":
      return "The recording is billed to no real name, so a search has nothing to go on.";

    case "dismissed":
      return "He set this recording aside.";

    case "duplicate":
      return "He already has this recording down as a duplicate of another.";

    default:
      return "He holds no length for this recording, and the search needs one.";
  }
}

/**
 * One row's answer: the state in plain words, plus the link where there is one.
 *
 * The five states, and what each of them is honestly claiming:
 *   · verified    — Fluncle holds it, and here is how and when he came to trust it.
 *   · absent      — he looked, it was not there, and here is whether he will look again.
 *   · refused     — he will not look, and here is which condition of the row stops him.
 *   · unattempted — nobody has looked.
 *   · unsupported — he serves no link of that kind at all.
 */
function StateLine({ label, state }: { label: string; state: IdentityState }) {
  if (state.state === "verified") {
    const provenance = `${methodPhrase(state.verification.method)}${whenPhrase(
      state.verification.at,
      state.verification.atMeaning,
    )}.`;

    // An identifier is worth printing (a reader copies it); a platform link is worth following.
    const openLabel = OPEN_LABEL[label];

    return (
      <>
        {state.url ? (
          <a className="identity-out" href={state.url} rel="noreferrer" target="_blank">
            {openLabel ?? state.value ?? label}
          </a>
        ) : (
          <span className="identity-value">{state.value}</span>
        )}
        <span className="identity-provenance">{provenance}</span>
      </>
    );
  }

  if (state.state === "absent") {
    // One look is "on that day"; several is "last on that day". The count is present only where a
    // real monotone tally backs it — Spotify's stored number is a spend budget the requeue
    // decrements, so the envelope withholds it and the sentence honestly says only "looked".
    const once = state.attempts === 1;
    const looked =
      state.attempts !== undefined && !once
        ? `Fluncle looked ${state.attempts} times`
        : once
          ? "Fluncle looked once"
          : "Fluncle looked";
    const when = state.lastAttemptedAt
      ? `, ${once ? "on" : "last on"} ${formatDateLong(state.lastAttemptedAt)}`
      : "";

    return (
      <span className="identity-provenance">
        {`${looked}${when}, and it was not there. ${retryPhrase(state.retry, state.cap)}`}
      </span>
    );
  }

  if (state.state === "refused") {
    return (
      <span className="identity-provenance">
        {`Fluncle is not looking. ${refusalPhrase(state.reason)}`}
      </span>
    );
  }

  if (state.state === "unattempted") {
    return <span className="identity-provenance">Nobody has looked yet.</span>;
  }

  return <span className="identity-provenance">{`Fluncle serves no ${label} link here.`}</span>;
}

/** One definition row: the platform or identifier, then its answer. */
function StateRow({ label, state }: { label: string; state: IdentityState }) {
  return (
    <div className="log-about-definition">
      <dt>{label}</dt>
      <dd>
        <StateLine label={label} state={state} />
      </dd>
    </div>
  );
}

/**
 * How this recording stands to the others the same identifier returned — but only the part that is
 * about THIS one. `ambiguous` is a property of the whole answer, not of any block in it, so it is
 * said once in the page's opening line instead of repeated over every block (the Recap Tell: a
 * sentence that restates what the reader already has advances nothing). `canonical` says nothing at
 * all: over a lone block, "this is the only one" is noise.
 */
function RelationNote({ relation }: { relation: IdentityRecording["relation"] }) {
  if (relation === "canonical" || relation === "ambiguous") {
    return undefined;
  }

  const twin = relation.slice("duplicate-of:".length);

  return (
    <p className="identity-relation">
      Fluncle has this one down as a duplicate of{" "}
      <Link params={{ key: twin }} to="/identity/$key">
        another recording here
      </Link>
      .
    </p>
  );
}

/**
 * One recording, lit or unlit. The certified one carries its coordinate and links home; the
 * uncertified one carries neither, and leaves by whichever link its own state holds.
 */
export function IdentityRecordingBlock({ recording }: { recording: IdentityRecording }) {
  const line = artistTitleLine(recording);
  const logId = recording.logId;

  return (
    <section className="identity-recording">
      {recording.certified && logId ? (
        <>
          <h2 className="identity-title">
            <Link params={{ logId }} to="/log/$logId">
              {line}
            </Link>
          </h2>
          {/* ONE composed string: a `fluncle://{logId}` JSX pair SSRs as comment-split text
              nodes, which naive text extraction (and a crawler's) reads as a broken coordinate. */}
          <p className="log-coordinate-uri">{`fluncle://${logId}`}</p>
        </>
      ) : (
        // UNLIT: named so a reader can tell the returned rows apart, and no further. No
        // coordinate (it has none), no link home (there is no page here to send you to), and
        // no noun for what it is — the tier has no public name (docs/album-entity.md).
        <h2 className="identity-title identity-title--unlit">{line}</h2>
      )}

      <RelationNote relation={recording.relation} />

      <div className="log-about-definitions">
        <dl>
          {IDENTIFIER_ROWS.map((row) => (
            <StateRow key={row.key} label={row.label} state={recording.identifiers[row.key]} />
          ))}
          {LINK_ROWS.map((row) => (
            <StateRow key={row.key} label={row.label} state={recording.links[row.key]} />
          ))}
        </dl>
      </div>
    </section>
  );
}
