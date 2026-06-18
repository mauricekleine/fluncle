import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatAlbumDuration } from "@/lib/format";
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
  const [message, setMessage] = useState<string>();
  const { data: mixtapes } = useQuery({
    initialData: initialMixtapes,
    queryFn: () => fetchMixtapes(),
    queryKey: MIXTAPES_KEY,
  });

  const refresh = async (nextMessage: string) => {
    await queryClient.invalidateQueries({ queryKey: MIXTAPES_KEY });
    setMessage(nextMessage);
  };

  return (
    <AdminShell
      current="mixtapes"
      subtitle={`${mixtapes.length} checkpoint${mixtapes.length === 1 ? "" : "s"}`}
      title="Mixtapes"
    >
      <div className="space-y-4 p-4">
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        <Button
          onClick={async () => {
            const response = await fetch("/api/admin/mixtapes", {
              body: JSON.stringify({ title: "Untitled mixtape" }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            });

            if (!response.ok) {
              setMessage(await response.text());
              return;
            }

            await refresh("Draft logged.");
          }}
        >
          New draft
        </Button>

        <div className="grid gap-4">
          {mixtapes.map((mixtape) => (
            <MixtapeEditor key={mixtape.id} mixtape={mixtape} refresh={refresh} />
          ))}
        </div>
      </div>
    </AdminShell>
  );
}

function MixtapeEditor({
  mixtape,
  refresh,
}: {
  mixtape: MixtapeDTO;
  refresh: (message: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(mixtape.title);
  const [note, setNote] = useState(mixtape.note ?? "");
  const [recordedAt, setRecordedAt] = useState(mixtape.recordedAt?.slice(0, 10) ?? "");
  const [durationMs, setDurationMs] = useState(
    mixtape.durationMs ? String(mixtape.durationMs) : "",
  );
  const [mixcloudUrl, setMixcloudUrl] = useState(mixtape.externalUrls.mixcloud ?? "");
  const [youtubeUrl, setYoutubeUrl] = useState(mixtape.externalUrls.youtube ?? "");
  const [soundcloudUrl, setSoundcloudUrl] = useState(mixtape.externalUrls.soundcloud ?? "");
  const [coverImageUrl, setCoverImageUrl] = useState(mixtape.coverImageUrl ?? "");
  const [members, setMembers] = useState(
    mixtape.members.map((member) => member.logId ?? member.trackId).join("\n"),
  );

  const hasLink = hasExternalUrl({
    mixcloud: mixcloudUrl.trim() || undefined,
    soundcloud: soundcloudUrl.trim() || undefined,
    youtube: youtubeUrl.trim() || undefined,
  });

  return (
    <section className="rounded-lg border border-border bg-background/35 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold">{mixtape.logId ?? mixtape.title}</h2>
          <p className="text-xs text-muted-foreground">
            {mixtape.memberCount} findings
            {mixtape.durationMs ? ` · ${formatAlbumDuration(mixtape.durationMs)}` : ""}
          </p>
        </div>
        <Badge variant={mixtape.status === "published" ? "default" : "outline"}>
          {mixtape.status ?? "draft"}
        </Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Title" value={title} onChange={setTitle} />
        <Field label="Recorded" value={recordedAt} onChange={setRecordedAt} />
        <Field label="Duration ms" value={durationMs} onChange={setDurationMs} />
        <Field label="Cover image URL" value={coverImageUrl} onChange={setCoverImageUrl} />
        <Field label="Mixcloud URL" value={mixcloudUrl} onChange={setMixcloudUrl} />
        <Field label="YouTube URL" value={youtubeUrl} onChange={setYoutubeUrl} />
        <Field label="SoundCloud URL" value={soundcloudUrl} onChange={setSoundcloudUrl} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Note</Label>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Members</Label>
          <Textarea
            placeholder="One Log ID or track ID per line"
            value={members}
            onChange={(event) => setMembers(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={async () => {
            await saveMixtape(mixtape.id as string, {
              coverImageUrl,
              durationMs: durationMs ? Number(durationMs) : null,
              mixcloudUrl,
              note,
              recordedAt,
              soundcloudUrl,
              title,
              youtubeUrl,
            });
            await refresh("Mixtape saved.");
          }}
        >
          Save
        </Button>
        <Button
          onClick={async () => {
            await replaceMembers(mixtape.id as string, members);
            await refresh("Tracklist saved.");
          }}
          variant="outline"
        >
          Save tracklist
        </Button>
        <Button
          disabled={!hasLink || mixtape.status === "published"}
          onClick={async () => {
            await publishMixtape(mixtape.id as string);
            await refresh("Mixtape published.");
          }}
          variant="outline"
        >
          Publish
        </Button>
      </div>

      <div className="mt-4 rounded-md border border-border bg-background/30 p-3">
        <p className="text-xs font-bold text-muted-foreground">Preview</p>
        <h3 className="mt-1 text-sm font-bold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {note || "A checkpoint in the archive. The longer dream made from findings."}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {(members.match(/\S+/g) ?? []).length} findings
          {durationMs ? ` · ${formatAlbumDuration(Number(durationMs))}` : ""}
        </p>
      </div>
    </section>
  );
}

function Field({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
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
