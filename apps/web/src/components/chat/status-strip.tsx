// THE STATUS STRIP — is Fluncle's cosmos up, rendered (ChatDnB Phase 4).
//
// When get_status reports in, the workbench shows a compact one-line readout instead of a raw
// JSON marker: a status dot plus the headline the tool already phrased. Deliberately NOT a card —
// a status is an inline system readout, not a hero — so it stays a quiet strip in the transcript.
// The dot mirrors the /status page's own idiom: the gold heartbeat (the sanctioned status-dot use
// of Eclipse Gold, per The One Sun Rule) when everything is up, a static Re-entry Red dot when it
// is not. The dot is aria-hidden; the headline carries the meaning, and role="status" announces it.

/** The status shape get_status emits (summarizeStatus): a health boolean and the phrased line. */
export type ChatStatus = {
  headline?: string;
  ok?: boolean;
};

/**
 * The dot: the /status page's gold heartbeat (a steady gold dot under an expanding gold ping ring,
 * motion-safe so reduced-motion gets a calm static dot) when everything is up, a static destructive
 * dot when it is not. Aria-hidden — the headline beside it carries the state to a screen reader.
 */
function StatusDot({ ok }: { ok: boolean }) {
  if (!ok) {
    return <span aria-hidden="true" className="inline-flex size-1.5 rounded-full bg-destructive" />;
  }

  return (
    <span aria-hidden="true" className="relative flex size-1.5">
      <span className="absolute inline-flex size-full rounded-full bg-primary opacity-60 motion-safe:animate-ping" />
      <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
    </span>
  );
}

export function StatusStrip({ status }: { status: ChatStatus }) {
  const headline = status.headline ?? "";
  const ok = status.ok ?? false;

  return (
    <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground" role="status">
      <StatusDot ok={ok} />
      <span className="text-foreground">{headline}</span>
    </p>
  );
}
