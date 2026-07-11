import {
  ArrowCounterClockwiseIcon,
  ChatTeardropTextIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  PackageIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { PromptDiff } from "@/components/admin/prompt-diff";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fluncle/ui/components/alert-dialog";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fluncle/ui/components/tabs";
import { Textarea } from "@fluncle/ui/components/textarea";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  type PromptDetail,
  type PromptVersionRow,
  listPrompts,
  type PromptSurface,
} from "@/lib/server/prompts";

// The `/admin/prompts` station — every prompt Fluncle feeds a model, editable with no deploy
// (lib/server/prompts.ts, docs/agents/prompt-registry.md).
//
// ── WHAT THE OPERATOR CAME HERE TO DO ───────────────────────────────────────────
// See what a prompt says, change it, and be able to put it back. That is the whole page.
// A live edit is not a settings tweak: it silently rewrites every note, script, entry, and
// verdict the pipeline authors from the next tick on, and nobody gets an error when the
// wording goes bad. So the three things that make an edit SAFE are the feature, not polish:
//
//   1. The DIFF. Nothing is ever saved blind. The editor shows, line by line, what moves
//      against the body running right now, and every historical version can be diffed
//      against it too.
//   2. The HISTORY. Every version, newest first, with its note (the "why"). The note field
//      is what makes this list readable a month later, so the copy pushes for it.
//   3. The ROLLBACK. One action, on any version, and it is append-only: rolling back MINTS a
//      new version carrying the old body rather than rewinding, so the rollback is itself
//      undoable. It still changes what every future artifact is authored under, so it sits
//      behind a confirm that names exactly that.
//
// Reset-to-the-repo-default is the same one write with a different source of body, and it is
// rare, so it lives off the resting surface behind the ⋮ (the disclosure law).

const PROMPTS_KEY = ["admin", "prompts"] as const;

/** The operator's "why", capped by the contract (`update_prompt`). */
const NOTE_MAX_LENGTH = 280;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// One read feeds the whole station: every prompt, its baked default, the body running now, and
// its full history. The table is a handful of rows, so a per-prompt fetch would buy nothing.
const fetchPrompts = createServerFn({ method: "GET" }).handler(
  async (): Promise<PromptDetail[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listPrompts();
  },
);

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/prompts")({
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchPrompts(),
  component: AdminPromptsPage,
});

function AdminPromptsPage() {
  const initial = Route.useLoaderData();
  const { data: prompts } = useQuery({
    initialData: initial,
    queryFn: () => fetchPrompts(),
    queryKey: PROMPTS_KEY,
    refetchOnWindowFocus: true,
  });

  const [openSlug, setOpenSlug] = useState<string | undefined>();
  const open = prompts.find((prompt) => prompt.slug === openSlug);

  const overridden = prompts.filter((prompt) => prompt.source === "override").length;
  const subtitle =
    overridden === 0
      ? `${prompts.length} prompts, all on the repo's wording`
      : `${prompts.length} prompts, ${overridden} on your wording`;

  return (
    <AdminShell subtitle={subtitle} title="Prompts">
      <div className="space-y-5 p-4 sm:p-5">
        {/* The one thing to know before touching a control here: what an edit reaches, and why
            it is safe to try. Plain words, above the rows. */}
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every prompt Fluncle feeds a model. Change one and it is live without a deploy. Nothing
          here is deleted: a save appends a version, so the old wording is always one action away,
          and a body the server cannot read falls back to the repo's default rather than stopping a
          sweep.
        </p>

        <ObjectList>
          {prompts.map((prompt) => (
            <PromptRow key={prompt.slug} onOpen={() => setOpenSlug(prompt.slug)} prompt={prompt} />
          ))}
        </ObjectList>
      </div>

      <Dialog
        onOpenChange={(next) => setOpenSlug(next ? openSlug : undefined)}
        open={Boolean(open)}
      >
        <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-3xl">
          {open ? <PromptEditor key={open.slug} prompt={open} /> : null}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** Where an edit lands, in human words rather than the raw enum. */
function surfaceLine(surface: PromptSurface): string {
  return surface === "box" ? "Live on the next sweep, no rebake" : "Live on the next request";
}

function PromptRow({ onOpen, prompt }: { onOpen: () => void; prompt: PromptDetail }) {
  return (
    <ObjectRow
      trailing={
        <>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {surfaceLine(prompt.surface)}
          </span>
          <SourceChip prompt={prompt} />
          <Button onClick={onOpen} size="sm">
            Open
          </Button>
        </>
      }
    >
      <ObjectLead
        coordinate={prompt.slug}
        leading={<ObjectGlyph icon={ChatTeardropTextIcon} />}
        subtitle={<span className="line-clamp-2">{prompt.description}</span>}
        title={prompt.title}
      />
    </ObjectRow>
  );
}

// Which of the two bodies is running, as quiet data (the labels "Seeding" chip precedent): an
// icon and a word, never an alarm — running the repo's default is the resting state, not a fault.
function SourceChip({ prompt }: { prompt: PromptDetail }) {
  const override = prompt.source === "override";
  const Glyph = override ? PencilSimpleIcon : PackageIcon;

  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
      <Glyph aria-hidden="true" className="size-3.5" weight={override ? "fill" : "regular"} />
      {override ? `Your wording, v${prompt.activeVersion}` : "Repo default"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

function PromptEditor({ prompt }: { prompt: PromptDetail }) {
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState(prompt.activeBody);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [rollback, setRollback] = useState<PromptVersionRow | undefined>();
  const [resetting, setResetting] = useState(false);

  const save = useMutation({
    mutationFn: (input: { body: string; note?: string }) =>
      updatePrompt(prompt.slug, input.body, input.note),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: (_result, input) => {
      setError(undefined);
      setNote("");
      setDraft(input.body);
      setRollback(undefined);
      setResetting(false);
      void queryClient.invalidateQueries({ queryKey: PROMPTS_KEY });
    },
  });

  const nextVersion = prompt.activeVersion + 1;
  const dirty = draft.trim() !== prompt.activeBody.trim();
  const empty = draft.trim().length === 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{prompt.title}</DialogTitle>
        <DialogDescription>{prompt.description}</DialogDescription>
      </DialogHeader>

      {/* The two facts that decide how careful to be: where this lands, and what is running. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-2.5">
        <span className="text-xs text-muted-foreground">{surfaceLine(prompt.surface)}</span>
        <SourceChip prompt={prompt} />
        <div className="ml-auto">
          {prompt.source === "override" ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="More actions"
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onClick={() => setResetting(true)}>
                  Reset to the repo's default
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <Variables variables={prompt.variables} />

      <Tabs defaultValue="edit">
        <TabsList className="w-full">
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="history">History ({prompt.versions.length})</TabsTrigger>
        </TabsList>

        <TabsContent className="space-y-4 pt-4" value="edit">
          <Textarea
            // field-sizing-fixed, against the shared Textarea's grow-to-content default: a
            // prompt body is a few thousand characters, and a field that tall would push the
            // diff and the Save button off the bottom of the dialog. Fixed frame, scrolls.
            className="h-72 field-sizing-fixed overflow-auto font-mono text-xs leading-5"
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            value={draft}
          />

          <PromptDiff
            after={draft}
            afterLabel="your edit"
            before={prompt.activeBody}
            beforeLabel="running now"
            emptyMessage="Nothing moves yet. Edit the body above and the change shows here before you save it."
          />

          <div className="space-y-1.5">
            <Label htmlFor="prompt-note">Why (optional, and worth ten seconds)</Label>
            <Input
              id="prompt-note"
              maxLength={NOTE_MAX_LENGTH}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Cut the neighbour block down, the notes were getting samey"
              value={note}
            />
            <p className="text-xs text-muted-foreground">
              This is what the history reads like in a month. Say what you changed and what you
              hoped it would do.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3">
            {error ? (
              <p className="mr-auto text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : undefined}
            <Button
              disabled={!dirty || empty || save.isPending}
              onClick={() => save.mutate({ body: draft, note: note.trim() || undefined })}
            >
              {save.isPending ? (
                <CircleNotchIcon
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                  weight="bold"
                />
              ) : undefined}
              {save.isPending ? "Saving…" : `Save as v${nextVersion}`}
            </Button>
          </div>
        </TabsContent>

        <TabsContent className="space-y-3 pt-4" value="history">
          <History onRollback={setRollback} prompt={prompt} />
        </TabsContent>
      </Tabs>

      <AlertDialog
        onOpenChange={(open) => (open ? undefined : setRollback(undefined))}
        open={rollback !== undefined}
      >
        <AlertDialogContent className="sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to v{rollback?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              This saves v{nextVersion} carrying v{rollback?.version}'s wording. From the next tick
              on, every artifact this prompt authors is written under it. Nothing is lost: v
              {prompt.activeVersion} stays in the history, so you can come back to it.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {rollback ? (
            <PromptDiff
              after={rollback.body}
              afterLabel={`v${rollback.version}`}
              before={prompt.activeBody}
              beforeLabel="running now"
              emptyMessage="Nothing moves. That version is word for word what is already running."
            />
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={() => {
                if (rollback) {
                  save.mutate({
                    body: rollback.body,
                    note: `rolled back to v${rollback.version}`,
                  });
                }
              }}
            >
              {save.isPending ? (
                <CircleNotchIcon
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                  weight="bold"
                />
              ) : undefined}
              {save.isPending ? "Rolling back…" : `Roll back to v${rollback?.version}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog onOpenChange={setResetting} open={resetting}>
        <AlertDialogContent className="sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to the repo's default?</AlertDialogTitle>
            <AlertDialogDescription>
              This saves v{nextVersion} carrying the wording baked into the repo. From the next tick
              on, every artifact this prompt authors is written under it. Your edits stay in the
              history, so you can bring one back.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <PromptDiff
            after={prompt.defaultBody}
            afterLabel="the repo's default"
            before={prompt.activeBody}
            beforeLabel="running now"
            emptyMessage="Nothing moves. The default is word for word what is already running."
          />

          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ body: prompt.defaultBody, note: "reset to the repo's default" })
              }
            >
              {save.isPending ? (
                <CircleNotchIcon
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                  weight="bold"
                />
              ) : undefined}
              {save.isPending ? "Resetting…" : "Reset to the default"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// The `{{variables}}` this body may interpolate. An operator editing blind is how this feature
// hurts someone, so the slots are on screen next to the editor, quoted verbatim in mono (the One
// Voice Rule — mono speaks for the machine).
function Variables({ variables }: { variables: string[] }) {
  if (variables.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This one takes no variables. What you write is what the model reads.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        The slots this body can reference. A slot you leave out is simply not filled, and one the
        caller has nothing for renders empty rather than breaking the sweep.
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {variables.map((variable) => (
          <li
            key={variable}
            className="rounded border border-border bg-card/60 px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground"
          >
            {`{{${variable}}}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------

// Pinned locale + UTC so a stamp never disagrees with itself between two machines.
const stamp = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function History({
  onRollback,
  prompt,
}: {
  onRollback: (version: PromptVersionRow) => void;
  prompt: PromptDetail;
}) {
  if (prompt.versions.length === 0) {
    return (
      <p className="rounded-md border border-border bg-card/60 px-3 py-6 text-center text-sm text-muted-foreground">
        No edits yet. This one still says what it said the day it shipped.
      </p>
    );
  }

  return (
    <ul className="m-0 list-none space-y-2 p-0">
      {prompt.versions.map((version) => (
        <HistoryEntry
          key={version.id}
          live={version.version === prompt.activeVersion}
          liveBody={prompt.activeBody}
          onRollback={() => onRollback(version)}
          version={version}
        />
      ))}
    </ul>
  );
}

function HistoryEntry({
  live,
  liveBody,
  onRollback,
  version,
}: {
  live: boolean;
  liveBody: string;
  onRollback: () => void;
  version: PromptVersionRow;
}) {
  const [showing, setShowing] = useState(false);

  return (
    <li className="rounded-md border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium tabular-nums">
            v{version.version}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {stamp.format(new Date(version.createdAt))} · {version.createdBy}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {version.note ?? "No note on this one."}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {live ? (
            <span className="text-xs text-muted-foreground">Running now</span>
          ) : (
            <>
              <Button onClick={() => setShowing((was) => !was)} size="sm" variant="ghost">
                {showing ? "Hide the diff" : "See the diff"}
              </Button>
              <Button onClick={onRollback} size="sm" variant="outline">
                <ArrowCounterClockwiseIcon aria-hidden="true" weight="bold" />
                Roll back
              </Button>
            </>
          )}
        </div>
      </div>

      {showing && !live ? (
        <div className="mt-3">
          <PromptDiff
            after={version.body}
            afterLabel={`v${version.version}`}
            before={liveBody}
            beforeLabel="running now"
            emptyMessage="Nothing moves. That version is word for word what is already running."
          />
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The one write
// ---------------------------------------------------------------------------

// The operator-tier `update_prompt` op (POST /admin/prompts/{slug}). Append-only: an edit, a
// rollback, and a reset are all this one call, differing only in where the body came from. The
// browser carries the admin grant cookie; the fetch mirrors the labels page's ruling call.
async function updatePrompt(slug: string, body: string, note?: string): Promise<void> {
  const response = await fetch(`/api/v1/admin/prompts/${encodeURIComponent(slug)}`, {
    body: JSON.stringify({ body, note }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as { message?: unknown };
    if (typeof data.message === "string" && data.message.trim()) {
      return data.message;
    }
  } catch {
    // Fall through to text/status below.
  }

  const text = await response.text().catch(() => "");

  return text.trim() || response.statusText || `Request failed (${response.status})`;
}
