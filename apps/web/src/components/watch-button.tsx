import { EyeIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { authClient } from "@/lib/auth-client";
import { authedJsonFetch } from "@/lib/authed-fetch";

type Face = "loading" | "not-watching" | "signed-out" | "watching";

type WatchRow = { entityId: string; id: string; kind: string };

export function WatchButton({
  entityId,
  kind,
  name,
}: {
  entityId: string;
  kind: "artist" | "label";
  name: string;
}) {
  const [face, setFace] = useState<Face>("loading");

  const [watchId, setWatchId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;

  useEffect(() => {
    let cancelled = false;

    if (!userId) {
      setFace("signed-out");
      setWatchId(undefined);

      return;
    }

    void fetch("/api/v1/me/watches")
      .then(async (res) => {
        if (res.status === 401) {
          if (!cancelled) {
            setFace("signed-out");
          }

          return;
        }

        const body = (await res.json()) as { watches?: WatchRow[] };
        const match = body.watches?.find(
          (watch) => watch.kind === kind && watch.entityId === entityId,
        );

        if (!cancelled) {
          setWatchId(match?.id);
          setFace(match ? "watching" : "not-watching");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFace("signed-out");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [entityId, kind, userId]);

  async function watch() {
    setBusy(true);

    try {
      const response = await authedJsonFetch("/api/v1/me/watches", {
        body: JSON.stringify({ entityId, kind }),
        method: "POST",
      });

      if (!response) {
        return;
      }

      if (response.ok) {
        const body = (await response.json()) as { watch?: { id?: string } };

        setWatchId(body.watch?.id);
        setFace("watching");
      }
    } finally {
      setBusy(false);
    }
  }

  async function unwatch() {
    if (!watchId) {
      return;
    }

    setBusy(true);

    try {
      const response = await authedJsonFetch(`/api/v1/me/watches/${watchId}`, {
        method: "DELETE",
      });

      if (!response) {
        return;
      }

      if (response.ok) {
        setWatchId(undefined);
        setFace("not-watching");
      }
    } finally {
      setBusy(false);
    }
  }

  if (face === "loading" || face === "signed-out") {
    return null;
  }

  const watching = face === "watching";

  return (
    <Button
      aria-label={watching ? `Watching ${name}` : `Watch ${name}`}
      aria-pressed={watching}

      className="mt-4 shrink-0"
      disabled={busy}
      onClick={() => void (watching ? unwatch() : watch())}
      size="sm"
      type="button"
      variant="outline"
    >
      <EyeIcon aria-hidden="true" className="size-4" weight={watching ? "fill" : "bold"} />
      {watching ? "Watching" : "Watch"}
    </Button>
  );
}
