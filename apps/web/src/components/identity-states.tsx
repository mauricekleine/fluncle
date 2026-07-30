// The identity answer, rendered — one recording's identifiers and its links out, with the honest
// negative said in words rather than left as a gap.
//
// THE WHOLE POINT OF THIS FILE is the states that are not "here it is". A link resolver that only
// prints what it holds leaves a reader unable to tell "we never looked" from "we looked and it is
// genuinely not there", and those are opposite facts. Every line below is computed from a real
// column in the envelope (lib/server/identity-envelope.ts holds the discipline); where no column
// backs a claim, the line says nothing rather than inventing one.
//
// ── THE REGISTER: A RECEIPT ───────────────────────────────────────────────────────────────────
// The page is a receipt from a person who checked, and a receipt is legitimately AGENTLESS. The
// reader is a stranger holding an ISRC asking two things: where does this recording live, and can I
// trust the answer. Trust comes from precision and brevity, not personality. So the content of a row
// is a method, a date, and a status, and it renders as exactly that: status-vocabulary fragments
// joined by middots, with no subject, no sentences, and no idioms. Voice lives in the page's one
// intro line (identity.$key.tsx) and nowhere else here. (Operator ruling, 2026-07-30. It supersedes
// the two earlier rounds on this surface, which rendered the same provenance metadata as prose and
// read as dead passive and then as narrated folksiness.)
//
// ── THE COVERAGE SET ──────────────────────────────────────────────────────────────────────────
// The page renders rows ONLY for what the archive covers: ISRC, MusicBrainz, Spotify, Apple Music,
// Discogs. Deezer and Tidal are absent by design — a "not covered" row is the API contract leaking
// into a human surface, and it reads as a roadmap promise. The API still answers all five platforms
// explicitly, `unsupported` included, because a machine needs the field to exist; the SCOPE of what
// Fluncle covers is stated once in `/docs/identity` rather than once per recording.
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
  type IdentityState,
} from "@/lib/server/identity-envelope";
import { type AnchorRefusalReason } from "@/lib/server/track-work";

/** The rows of one recording's answer, in reading order: what it IS, then where it goes. */
const IDENTIFIER_ROWS = [
  { key: "isrc", label: "ISRC" },
  { key: "mbRecordingId", label: "MusicBrainz" },
] as const;

/** The covered platforms, and only those — see the coverage-set note in the file header. */
const LINK_ROWS = [
  { key: "spotify", label: "Spotify" },
  { key: "appleMusic", label: "Apple Music" },
  { key: "discogs", label: "Discogs" },
] as const;

/** The literal label on the link a `verified` state carries. "Listen on Spotify" is the ratified
 *  string for that action across the app (VOICE.md's Chrome Rule: one action, one label). */
const OPEN_LABEL: Record<string, string> = {
  "Apple Music": "Listen on Apple Music",
  Discogs: "Open on Discogs",
  MusicBrainz: "Open on MusicBrainz",
  Spotify: "Listen on Spotify",
};

/** The fragment separator, matching the middot the rest of the site already joins facts with. */
function fragmentLine(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

/**
 * HOW the row was decided, as a status fragment rather than a claim about anybody. Two families:
 * `matched by …` where Fluncle ran a comparison, `from …` where the identifier is the record's own.
 *
 * `unknown-legacy` returns nothing at all. No column records how that row came to be trusted, so the
 * receipt makes no method claim and carries only its date — an absent fragment, never a vague one.
 *
 * `confirmed` and `checked` are RESERVED for the date fragment beside this one, where they carry the
 * verified-vs-attempted distinction. No method fragment spends either word, or a line reads
 * "confirmed by hand · confirmed Jul 1, 2026" and the distinction stops being legible.
 */
function methodFragment(method: IdentityMethod, label: string): string | undefined {
  switch (method) {
    case "isrc":
      return "matched by ISRC";

    case "operator":
      return "set by hand";

    // The identifier IS this row's origin rather than a lookup result, which is the one thing the
    // row cannot say by naming its own platform again.
    case "pk-derived":
      return "the id it arrived under";

    case "publish":
      return `from ${label}'s own record`;

    case "search":
      return "matched by artist, title, and length";

    case "search-subset":
      return "matched by title and length, with part of the artist name";

    default:
      return undefined;
  }
}

/**
 * WHEN, and honest about what the date marks. A verified stamp is the moment the link was written
 * ("confirmed"); an attempted stamp is the moment a look concluded ("checked"). Serving one as the
 * other is the easiest lie in this envelope to tell by accident, so the two words never swap.
 */
function whenFragment(
  at: null | string,
  atMeaning: "attempted" | "verified" | null,
): string | undefined {
  if (!at || !atMeaning) {
    return undefined;
  }

  return atMeaning === "verified"
    ? `confirmed ${formatDateLong(at)}`
    : `checked ${formatDateLong(at)}`;
}

type AbsentState = Extract<IdentityState, { state: "absent" }>;

/** Whether more looks are coming, off the two columns that decide it. Drives "checked" vs "last
 *  checked": a row that will be asked again has a LAST check, one that will not simply has one. */
function moreLooksComing(state: AbsentState): boolean {
  return state.terminal !== true && state.retry !== "single-shot";
}

/**
 * The count-and-date fragment of a miss. The tally is printed ONLY where a monotone counter backs it
 * (the envelope withholds Spotify's, which is a spend budget the requeue decrements), and a row with
 * neither a tally nor a stamp contributes nothing rather than a hedge.
 */
function checkedFragment(state: AbsentState): string | undefined {
  const when = state.lastAttemptedAt ? formatDateLong(state.lastAttemptedAt) : undefined;

  if (state.attempts !== undefined && state.attempts > 1) {
    return when
      ? `checked ${state.attempts} times, last ${when}`
      : `checked ${state.attempts} times`;
  }

  if (!when) {
    return undefined;
  }

  return moreLooksComing(state) ? `last checked ${when}` : `checked ${when}`;
}

/**
 * What happens after a miss, off the retry class the acquisition queue itself is built on.
 *
 * `terminal` is the only column that can say "never again", so it alone earns `retired`. A capped
 * row that is not terminal is still under its budget and says so with the ceiling attached. A
 * `single-shot` row with no terminal verdict on file gets NO fragment: that Fluncle holds no opinion
 * is itself the honest answer, and inventing one either way would be the guess this surface exists
 * to avoid.
 */
function outlookFragment(state: AbsentState): string | undefined {
  if (state.terminal === true) {
    return "retired";
  }

  if (state.retry === "recheckable") {
    return "will be checked again";
  }

  if (state.retry === "capped") {
    return state.cap
      ? `will be checked again, up to ${state.cap} times in all`
      : "will be checked again";
  }

  return undefined;
}

/** Which condition of this recording's own row stops Fluncle looking. A closed set. */
function refusalLine(reason: AnchorRefusalReason): string {
  switch (reason) {
    case "attempt-cap-reached":
      return fragmentLine("Not found", "checked as many times as allowed", "retired");

    case "credit-not-an-identity":
      return fragmentLine("Not eligible", "no artist credit to search on");

    case "dismissed":
      return "Set aside";

    case "duplicate":
      return "Held as a duplicate of another recording";

    default:
      return fragmentLine("Not eligible", "no length on file");
  }
}

/** Every state that gets a row. `unsupported` is the one that does not — {@link StateRow} drops it
 *  before this function is reached, so "not covered" can never render as a line. */
type RenderedState = Exclude<IdentityState, { state: "unsupported" }>;

/**
 * One row's answer: the status fragments, plus the link where there is one.
 *
 * The four rendered states, and what each of them is honestly claiming:
 *   · verified    — it is held, and here is how and when it came to be trusted.
 *   · absent      — a look ran to the end and came back empty, and here is whether another is coming.
 *   · refused     — no look will run, and here is which condition of the row stops it.
 *   · unattempted — nobody has gone looking.
 *
 * A `verified` line starts lowercase because it CAPTIONS the value or link above it; every other
 * state starts capitalized because the fragment IS the answer and has nothing above it to hang from.
 * Both are sentence case; the split is the grammar of the row, not an oversight.
 */
function StateLine({ label, state }: { label: string; state: RenderedState }) {
  if (state.state === "verified") {
    const line = fragmentLine(
      methodFragment(state.verification.method, label),
      whenFragment(state.verification.at, state.verification.atMeaning),
    );

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
        {line ? <span className="identity-provenance">{line}</span> : undefined}
      </>
    );
  }

  if (state.state === "absent") {
    return (
      <span className="identity-provenance">
        {fragmentLine("Not found", checkedFragment(state), outlookFragment(state))}
      </span>
    );
  }

  if (state.state === "refused") {
    return <span className="identity-provenance">{refusalLine(state.reason)}</span>;
  }

  return <span className="identity-provenance">Not checked yet</span>;
}

/**
 * One definition row: the platform or identifier, then its answer.
 *
 * `unsupported` gets NO ROW, and the guard lives here so that is true by construction rather than by
 * the coverage list happening to exclude the two platforms that answer it today. A row reading "not
 * covered" is the API's contract leaking onto a human surface, and to a reader it reads as a promise
 * to add the platform later. Scope belongs in `/docs/identity`, said once, not once per recording.
 */
function StateRow({ label, state }: { label: string; state: IdentityState }) {
  if (state.state === "unsupported") {
    return undefined;
  }

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
 *
 * Worded in the same status vocabulary the `duplicate` refusal carries, because it is the same fact
 * said at block scale rather than row scale.
 */
function RelationNote({ relation }: { relation: IdentityRecording["relation"] }) {
  if (relation === "canonical" || relation === "ambiguous") {
    return undefined;
  }

  const twin = relation.slice("duplicate-of:".length);

  return (
    <p className="identity-relation">
      Held as a duplicate of{" "}
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
