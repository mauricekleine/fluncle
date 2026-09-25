export type ChatStatus = {
  headline?: string;
  ok?: boolean;
};

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
    <output className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <StatusDot ok={ok} />
      <span className="text-foreground">{headline}</span>
    </output>
  );
}
