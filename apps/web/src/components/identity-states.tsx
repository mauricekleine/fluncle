import { Link } from "@tanstack/react-router";
import { artistTitleLine } from "@/lib/log-prose";
import { formatDateLong } from "@/lib/format";
import {
  type IdentityMethod,
  type IdentityRecording,
  type IdentityState,
} from "@/lib/server/identity-envelope";
import { type AnchorRefusalReason } from "@/lib/server/track-work";

const IDENTIFIER_ROWS = [
  { key: "isrc", label: "ISRC" },
  { key: "mbRecordingId", label: "MusicBrainz" },
] as const;

const LINK_ROWS = [
  { key: "spotify", label: "Spotify" },
  { key: "appleMusic", label: "Apple Music" },
  { key: "deezer", label: "Deezer" },
  { key: "discogs", label: "Discogs" },
  { key: "beatport", label: "Beatport" },
  { key: "youtube", label: "YouTube" },
] as const;

const OPEN_LABEL: Record<string, string> = {
  "Apple Music": "Listen on Apple Music",
  Beatport: "Buy on Beatport",
  Deezer: "Listen on Deezer",
  Discogs: "Open on Discogs",
  MusicBrainz: "Open on MusicBrainz",
  Spotify: "Listen on Spotify",

  YouTube: "Watch on YouTube",
};

function fragmentLine(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function methodFragment(method: IdentityMethod, label: string): string | undefined {
  switch (method) {
    case "fingerprint":
      return "matched by audio fingerprint";

    case "isrc":
      return "matched by ISRC";

    case "operator":
      return "set by hand";

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

function moreLooksComing(state: AbsentState): boolean {
  return state.terminal !== true && state.retry !== "single-shot";
}

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

type RenderedState = Exclude<IdentityState, { state: "unsupported" }>;

function StateLine({ label, state }: { label: string; state: RenderedState }) {
  if (state.state === "verified") {
    const line = fragmentLine(
      methodFragment(state.verification.method, label),
      whenFragment(state.verification.at, state.verification.atMeaning),
    );

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

          <p className="log-coordinate-uri">{`fluncle://${logId}`}</p>
        </>
      ) : (
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
