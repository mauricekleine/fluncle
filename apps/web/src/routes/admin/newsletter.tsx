import {
  CaretDownIcon,
  CaretRightIcon,
  CircleNotchIcon,
  PaperPlaneTiltIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Dispatch, type SetStateAction, useEffect, useId, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type EditionDTO, orderedGalaxies } from "@/lib/editions";
import { logPageUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listEditions } from "@/lib/server/editions";

// The operator's newsletter front-end (`/admin/newsletter`): the editions list
// (drafts inclusive), a preview of what each one renders to, and the Send control
// — the operator tap that the Friday agent can't make (send_edition is operator
// tier; the agent token 403s, the browser grant is operator). The send is a real
// Resend broadcast, gated behind an explicit confirm. Surfaced from the test that
// found the editions were CLI/API-only (docs/ROADMAP.md, Newsletter follow-ups).

const EDITIONS_KEY = ["admin", "editions"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchEditions = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  // Drafts inclusive — the operator is here to review and send the unsent ones.
  return listEditions({ includeDrafts: true });
});

export const Route = createFileRoute("/admin/newsletter")({
  beforeLoad: () => ensureAdmin(),
  component: AdminNewsletterPage,
  loader: () => fetchEditions(),
});

function AdminNewsletterPage() {
  const initialEditions = Route.useLoaderData();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { data: editions } = useQuery({
    initialData: initialEditions,
    queryFn: () => fetchEditions(),
    queryKey: EDITIONS_KEY,
    // Admin convention: focus-refetch ON, so a send made elsewhere lands here.
    refetchOnWindowFocus: true,
  });

  const draftCount = editions.filter((edition) => edition.status === "draft").length;
  const sentCount = editions.length - draftCount;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  return (
    <AdminShell
      current="newsletter"
      subtitle={
        editions.length === 0
          ? undefined
          : `${draftCount} draft${draftCount === 1 ? "" : "s"} · ${sentCount} sent`
      }
      title="Newsletter"
    >
      <div className="p-4 sm:p-5">
        {editions.length === 0 ? (
          <EmptyState
            body="The Friday agent drafts an edition here when the week has finds. Nothing yet. The mothership hasn't loaded a letter."
            title="No editions yet"
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {editions.map((edition) => (
              <EditionRow
                key={edition.id}
                edition={edition}
                expanded={expanded.has(edition.id)}
                onToggle={() => toggle(edition.id)}
                refresh={() => queryClient.invalidateQueries({ queryKey: EDITIONS_KEY })}
              />
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function EditionRow({
  edition,
  expanded,
  onToggle,
  refresh,
}: {
  edition: EditionDTO;
  expanded: boolean;
  onToggle: () => void;
  refresh: () => Promise<void>;
}) {
  const headerId = useId();
  const bodyId = useId();
  const isDraft = edition.status === "draft";

  return (
    <section className="border-b border-border last:border-b-0">
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring sm:px-5"
        id={headerId}
        onClick={onToggle}
        type="button"
      >
        {expanded ? (
          <CaretDownIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
        ) : (
          <CaretRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {edition.number ? `#${edition.number}` : "draft"}
        </span>
        <Badge className="shrink-0" variant={isDraft ? "outline" : "default"}>
          {edition.status}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-bold">
          {edition.subject ?? "Untitled edition"}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {edition.sentAt ? `Found ${formatDateLong(edition.sentAt)}` : "Not sent"}
        </span>
      </button>

      {expanded ? (
        <section
          aria-labelledby={headerId}
          className="space-y-4 px-4 pb-4 pt-2 sm:px-5"
          id={bodyId}
        >
          <EditionPreview content={edition.content} />

          {isDraft ? (
            <SendControl edition={edition} refresh={refresh} />
          ) : (
            <div className="flex items-center gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
              <span>
                Gone out{edition.sentAt ? ` ${formatDateLong(edition.sentAt)}` : ""}. A sent edition
                is a permanent back issue.
              </span>
              {edition.number ? (
                <a
                  className="underline-offset-2 hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-ring"
                  href={`/newsletter/${edition.number}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  View the public back issue ↗
                </a>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}

// A read-only render of the stored content payload — what the edition becomes on
// the page and (in spirit) in the email. The same view helpers the public archive
// uses, so the preview matches the back issue.
function EditionPreview({ content }: { content: EditionDTO["content"] }) {
  const galaxies = orderedGalaxies(content);
  const isEmpty = !content.intro?.trim() && galaxies.length === 0 && !content.mixtapeRef?.trim();

  if (isEmpty) {
    return (
      <p className="text-sm text-muted-foreground">
        This draft has no content yet. The agent fills it in before offering the send.
      </p>
    );
  }

  return (
    <div className="max-w-prose space-y-4 text-sm leading-relaxed">
      <p className="text-muted-foreground">Ahoy cosmonauts,</p>

      {content.intro?.trim() ? (
        <p className="whitespace-pre-line text-foreground">{content.intro}</p>
      ) : null}

      {galaxies.map((block) => (
        <div key={block.galaxy} className="space-y-1.5">
          <p className="text-xs font-bold text-muted-foreground">{block.galaxy}</p>
          <ul className="space-y-1">
            {block.findings.map((finding) => (
              <li key={finding.logId} className="flex flex-wrap items-baseline gap-x-2">
                <a
                  className="font-mono text-xs tabular-nums text-accent-foreground underline-offset-2 hover:underline"
                  href={logPageUrl(finding.logId)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {finding.logId}
                </a>
                {finding.why?.trim() ? (
                  <span className="text-muted-foreground">{finding.why}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {content.mixtapeRef?.trim() ? (
        <p className="text-foreground">
          And a new mixtape:{" "}
          <a
            className="font-mono text-xs tabular-nums text-accent-foreground underline-offset-2 hover:underline"
            href={logPageUrl(content.mixtapeRef)}
            rel="noreferrer"
            target="_blank"
          >
            {content.mixtapeRef}
          </a>
        </p>
      ) : null}

      {content.tidbits?.length ? (
        <div className="space-y-1.5">
          <p className="text-xs font-bold text-muted-foreground">From the wider cosmos</p>
          <ul className="space-y-1 text-muted-foreground">
            {content.tidbits.map((tidbit, index) => (
              <li key={`${index}-${tidbit.text.slice(0, 24)}`}>
                {tidbit.text}
                {tidbit.source?.trim() ? (
                  <>
                    {" "}
                    <a
                      className="text-accent-foreground underline-offset-2 hover:underline"
                      href={tidbit.source}
                      rel="noreferrer"
                      target="_blank"
                    >
                      (source)
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-muted-foreground">Happy raving, Fluncle</p>
    </div>
  );
}

// The Send control — the operator tap. A draft needs a subject before it can go
// (the server enforces the same); the send is a real broadcast to the whole list,
// so it sits behind an explicit confirm, never a single click.
function SendControl({ edition, refresh }: { edition: EditionDTO; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useAutoNotice();
  const [notice, setNotice] = useAutoNotice();
  const hasSubject = Boolean(edition.subject?.trim());

  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/v1/admin/newsletter/editions/${encodeURIComponent(edition.id)}/send`,
        {
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      setNotice("Sent. The mothership has departed.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button disabled={busy || !hasSubject} size="sm">
              {busy ? (
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
              ) : (
                <PaperPlaneTiltIcon aria-hidden="true" />
              )}
              {busy ? "Sending…" : "Send"}
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this edition to the crew?</AlertDialogTitle>
            <AlertDialogDescription>
              This mails "{edition.subject ?? "this edition"}" to the whole list and mints its
              number. There's no recall once the mothership departs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Hold</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void send()}>
              {busy ? (
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
              ) : undefined}
              {busy ? "Sending…" : "Send it"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {!hasSubject ? (
        <p className="text-xs text-muted-foreground">
          Needs a subject before it can go. Set it from the CLI:{" "}
          <code className="font-mono">fluncle admin newsletter update</code>.
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function EmptyState({ body, title }: { body: string; title: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center">
      <p className="font-medium">{title}</p>
      <p className="max-w-prose text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function useAutoNotice(): readonly [
  string | undefined,
  Dispatch<SetStateAction<string | undefined>>,
] {
  const [value, setValue] = useState<string>();
  useEffect(() => {
    if (!value) {
      return;
    }
    const timer = window.setTimeout(() => setValue(undefined), 5000);
    return () => window.clearTimeout(timer);
  }, [value]);
  return [value, setValue] as const;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Fall through to text/status below.
  }
  const text = await response.text().catch(() => "");
  return text.trim() || response.statusText || `Request failed (${response.status})`;
}
