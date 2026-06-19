import { CircleNotchIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatAlbumDuration, formatDurationField, parseDuration } from "@/lib/format";
import { hasExternalUrl, type MixtapeDTO } from "@/lib/mixtapes";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listMixtapes } from "@/lib/server/mixtapes";

const MIXTAPES_KEY = ["admin", "mixtapes"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchMixtapes = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listMixtapes({ hydrateMembers: true, includeDrafts: true });
});

export const Route = createFileRoute("/admin/mixtapes")({
  beforeLoad: () => ensureAdmin(),
  component: AdminMixtapesPage,
  loader: () => fetchMixtapes(),
});

function AdminMixtapesPage() {
  const initialMixtapes = Route.useLoaderData();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useAutoNotice();
  const [error, setError] = useAutoNotice();
  const [creating, setCreating] = useState(false);
  const { data: mixtapes } = useQuery({
    initialData: initialMixtapes,
    queryFn: () => fetchMixtapes(),
    queryKey: MIXTAPES_KEY,
    refetchOnWindowFocus: true,
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: MIXTAPES_KEY }),
    [queryClient],
  );

  const createDraft = async () => {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch("/api/admin/mixtapes", {
        body: JSON.stringify({ title: "Untitled mixtape" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await refresh();
      setNotice("Draft logged.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <AdminShell
      current="mixtapes"
      subtitle={`${mixtapes.length} checkpoint${mixtapes.length === 1 ? "" : "s"}`}
      title="Mixtapes"
    >
      <div className="p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button disabled={creating} onClick={() => void createDraft()}>
            {creating ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : undefined}
            {creating ? "Logging…" : "New mixtape draft"}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </div>

        {mixtapes.length === 0 ? (
          <EmptyState
            body="Log a draft to start a checkpoint — Fluncle dreaming, made from findings."
            title="No checkpoints yet"
          />
        ) : (
          <div className="plate-field overflow-hidden rounded-lg">
            {mixtapes.map((mixtape) => (
              <MixtapeEditor
                key={mixtape.id ?? mixtape.title}
                mixtape={mixtape}
                refresh={refresh}
              />
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function MixtapeEditor({
  mixtape,
  refresh,
}: {
  mixtape: MixtapeDTO;
  refresh: () => Promise<void>;
}) {
  const noteId = useId();
  const membersId = useId();
  const [title, setTitle] = useState(mixtape.title);
  const [note, setNote] = useState(mixtape.note ?? "");
  const [recordedAt, setRecordedAt] = useState(mixtape.recordedAt?.slice(0, 10) ?? "");
  const [durationField, setDurationField] = useState(formatDurationField(mixtape.durationMs));
  const [mixcloudUrl, setMixcloudUrl] = useState(mixtape.externalUrls.mixcloud ?? "");
  const [youtubeUrl, setYoutubeUrl] = useState(mixtape.externalUrls.youtube ?? "");
  const [soundcloudUrl, setSoundcloudUrl] = useState(mixtape.externalUrls.soundcloud ?? "");
  const [coverImageUrl, setCoverImageUrl] = useState(mixtape.coverImageUrl ?? "");
  const [members, setMembers] = useState(
    mixtape.members.map((member) => member.logId ?? member.trackId).join("\n"),
  );
  const [error, setError] = useAutoNotice();
  const [notice, setNotice] = useAutoNotice();
  const [busy, setBusy] = useState<"save" | "tracklist" | "publish" | "discard">();

  const stateRef = useRef({
    coverImageUrl,
    durationField,
    members,
    mixcloudUrl,
    note,
    recordedAt,
    soundcloudUrl,
    title,
    youtubeUrl,
  });
  useEffect(() => {
    stateRef.current = {
      coverImageUrl,
      durationField,
      members,
      mixcloudUrl,
      note,
      recordedAt,
      soundcloudUrl,
      title,
      youtubeUrl,
    };
  });

  const lastServer = useRef(mixtape);
  useEffect(() => {
    const local = stateRef.current;
    const prev = lastServer.current;
    if (local.title === prev.title) {
      setTitle(mixtape.title);
    }
    if (local.note === (prev.note ?? "")) {
      setNote(mixtape.note ?? "");
    }
    if (local.recordedAt === (prev.recordedAt?.slice(0, 10) ?? "")) {
      setRecordedAt(mixtape.recordedAt?.slice(0, 10) ?? "");
    }
    if (local.durationField === formatDurationField(prev.durationMs)) {
      setDurationField(formatDurationField(mixtape.durationMs));
    }
    if (local.mixcloudUrl === (prev.externalUrls.mixcloud ?? "")) {
      setMixcloudUrl(mixtape.externalUrls.mixcloud ?? "");
    }
    if (local.youtubeUrl === (prev.externalUrls.youtube ?? "")) {
      setYoutubeUrl(mixtape.externalUrls.youtube ?? "");
    }
    if (local.soundcloudUrl === (prev.externalUrls.soundcloud ?? "")) {
      setSoundcloudUrl(mixtape.externalUrls.soundcloud ?? "");
    }
    if (local.coverImageUrl === (prev.coverImageUrl ?? "")) {
      setCoverImageUrl(mixtape.coverImageUrl ?? "");
    }
    const prevMembers = prev.members.map((member) => member.logId ?? member.trackId).join("\n");
    if (local.members === prevMembers) {
      setMembers(mixtape.members.map((member) => member.logId ?? member.trackId).join("\n"));
    }
    lastServer.current = mixtape;
  }, [mixtape]);

  const parsedDurationMs = parseDuration(durationField);
  const durationInvalid = durationField.trim().length > 0 && parsedDurationMs === null;
  const previewMemberCount = (members.match(/\S+/g) ?? []).length;
  const hasLink = hasExternalUrl({
    mixcloud: mixcloudUrl.trim() || undefined,
    soundcloud: soundcloudUrl.trim() || undefined,
    youtube: youtubeUrl.trim() || undefined,
  });
  const published = mixtape.status === "published";
  const publishDisabled = !hasLink || published;

  const run = async (
    which: "save" | "tracklist" | "publish" | "discard",
    action: () => Promise<void>,
    success: string,
  ) => {
    setBusy(which);
    setError(undefined);
    try {
      await action();
      setNotice(success);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const save = () => {
    if (durationInvalid) {
      setError("Duration must be mm:ss or h:mm:ss, or a millisecond count.");
      return;
    }
    void run(
      "save",
      async () => {
        await saveMixtape(mixtape.id as string, {
          coverImageUrl,
          durationMs: parsedDurationMs,
          mixcloudUrl,
          note,
          recordedAt,
          soundcloudUrl,
          title,
          youtubeUrl,
        });
      },
      "Mixtape saved.",
    );
  };

  const saveTracklist = () => {
    void run(
      "tracklist",
      async () => {
        await replaceMembers(mixtape.id as string, members);
      },
      "Tracklist saved.",
    );
  };

  const publish = () => {
    void run(
      "publish",
      async () => {
        await publishMixtape(mixtape.id as string);
      },
      "Mixtape published.",
    );
  };

  const discard = () => {
    void run(
      "discard",
      async () => {
        await deleteMixtape(mixtape.id as string);
      },
      "Draft discarded.",
    );
  };

  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0 sm:px-5">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-mono text-xs tracking-tight text-muted-foreground tabular-nums">
            {mixtape.logId ?? "draft"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {mixtape.memberCount} findings
            {mixtape.durationMs ? ` · ${formatAlbumDuration(mixtape.durationMs)}` : ""}
          </p>
        </div>
        <Badge variant={published ? "default" : "outline"}>{mixtape.status ?? "draft"}</Badge>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Title" value={title} onChange={setTitle} />
        <Field label="Recorded" type="date" value={recordedAt} onChange={setRecordedAt} />
        <Field
          hint={
            durationInvalid
              ? "Must be mm:ss or h:mm:ss, or a millisecond count."
              : parsedDurationMs !== null && durationField
                ? formatAlbumDuration(parsedDurationMs)
                : undefined
          }
          label="Duration"
          placeholder="mm:ss or h:mm:ss"
          value={durationField}
          onChange={setDurationField}
        />
        <Field label="Cover image URL" value={coverImageUrl} onChange={setCoverImageUrl} />
        <Field label="Mixcloud URL" value={mixcloudUrl} onChange={setMixcloudUrl} />
        <Field label="YouTube URL" value={youtubeUrl} onChange={setYoutubeUrl} />
        <Field label="SoundCloud URL" value={soundcloudUrl} onChange={setSoundcloudUrl} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={noteId}>Note</Label>
          <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={membersId}>Members</Label>
          <Textarea
            id={membersId}
            placeholder="One Log ID or track ID per line"
            value={members}
            onChange={(event) => setMembers(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={busy !== undefined} onClick={save}>
          {busy === "save" ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : undefined}
          {busy === "save" ? "Saving…" : "Save mixtape"}
        </Button>
        <Button disabled={busy !== undefined} onClick={saveTracklist} variant="outline">
          {busy === "tracklist" ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : undefined}
          {busy === "tracklist" ? "Saving…" : "Save tracklist"}
        </Button>
        <Button
          disabled={busy !== undefined || publishDisabled}
          onClick={publish}
          variant="outline"
        >
          {busy === "publish" ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : undefined}
          {busy === "publish" ? "Publishing…" : "Publish mixtape"}
        </Button>
        {published ? null : (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button disabled={busy !== undefined} variant="destructive">
                  <TrashIcon aria-hidden="true" />
                  Discard draft
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
                <AlertDialogDescription>
                  The draft and its tracklist will be permanently removed. This can't be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy !== undefined}>Keep draft</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy !== undefined}
                  onClick={discard}
                  variant="destructive"
                >
                  {busy === "discard" ? (
                    <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                  ) : undefined}
                  {busy === "discard" ? "Discarding…" : "Discard draft"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      {publishDisabled ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {!hasLink
            ? "Add a Mixcloud, YouTube, or SoundCloud link to enable publish."
            : "Already published."}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p aria-live="polite" className="mt-2 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}

      <div className="plate-field mt-4 rounded-lg p-3">
        <p className="text-xs font-bold text-muted-foreground">Preview</p>
        <div className="mt-2 flex gap-3">
          {coverImageUrl ? (
            <img
              alt=""
              className="size-16 shrink-0 rounded-md border border-border object-cover"
              src={coverImageUrl}
            />
          ) : (
            <div className="track-artwork-fallback size-16 shrink-0 rounded-md border border-border" />
          )}
          <div className="min-w-0">
            {mixtape.logId ? (
              <p className="font-mono text-xs tracking-tight text-muted-foreground tabular-nums">
                {mixtape.logId}
              </p>
            ) : null}
            <h3 className="truncate text-sm font-bold">{title || "Untitled mixtape"}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {previewMemberCount} findings
              {parsedDurationMs ? ` · ${formatAlbumDuration(parsedDurationMs)}` : ""}
            </p>
          </div>
        </div>
        {note.trim() ? <p className="mt-2 text-sm text-muted-foreground">{note}</p> : null}
        {hasLink ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {[
              mixcloudUrl.trim() && "Mixcloud",
              youtubeUrl.trim() && "YouTube",
              soundcloudUrl.trim() && "SoundCloud",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Field({
  hint,
  label,
  onChange,
  placeholder,
  type,
  value,
}: {
  hint?: ReactNode;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  value: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function EmptyState({ body, title }: { body: string; title: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
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

async function saveMixtape(id: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function replaceMembers(id: string, members: string) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}/members`, {
    body: JSON.stringify({
      members: members
        .split(/\s+/)
        .map((member) => member.trim())
        .filter(Boolean),
    }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function publishMixtape(id: string) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}/publish`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function deleteMixtape(id: string) {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}
