import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  pausePreview,
  playQueueWhenLoaded,
  type QueueTrack,
  togglePlayback,
  usePlayerQueue,
  usePreviewStatus,
} from "@/lib/preview-player";
import { toQueueTrack } from "@/lib/player-tracks";

export type HubTileKind = "album" | "artist" | "label";

type EntityQueueOutcome =
  | { outcome: "failed" }
  | { outcome: "found"; tracks: QueueTrack[] }
  | { outcome: "gone" };

const fetchEntityQueue = createServerFn({ method: "GET" })
  .validator((data: { kind: HubTileKind; slug: string }) => data)
  .handler(async ({ data }): Promise<EntityQueueOutcome> => {
    const { listEntityQueue } = await import("@/lib/server/entity-queue");
    const tracks = await listEntityQueue(data.kind, data.slug);

    return tracks === undefined
      ? { outcome: "gone" }
      : { outcome: "found", tracks: tracks.map(toQueueTrack) };
  });

const queues = new Map<string, Promise<EntityQueueOutcome>>();

function queueKey(tracks: QueueTrack[]): string {
  return tracks.map((track) => track.id).join("\n");
}

function loadQueue(kind: HubTileKind, slug: string): Promise<EntityQueueOutcome> {
  const key = `${kind}:${slug}`;
  const cached = queues.get(key);

  if (cached) {
    return cached;
  }

  const pending = fetchEntityQueue({ data: { kind, slug } }).catch((): EntityQueueOutcome => {
    queues.delete(key);

    return { outcome: "failed" };
  });

  queues.set(key, pending);

  return pending;
}

export function HubTilePlay({
  kind,
  lit,
  name,
  slug,
}: {
  kind: HubTileKind;
  lit: boolean;
  name: string;
  slug: string;
}): ReactNode {
  const queue = usePlayerQueue();
  const mounted = useRef(true);
  const [handed, setHanded] = useState<string | undefined>();
  const [state, setState] = useState<"empty" | "failed" | "idle" | "loading">("idle");
  const owns = queue !== undefined && handed !== undefined && queueKey(queue.tracks) === handed;
  const status = usePreviewStatus(owns ? queue.tracks[queue.index]?.id : undefined);
  const active = owns && (status === "playing" || status === "loading");
  const paused = owns && status === "paused";

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const onClick = async () => {
    if (active) {
      pausePreview();

      return;
    }

    if (paused) {
      togglePlayback();

      return;
    }

    setState("loading");

    let failed = false;
    let loaded: QueueTrack[] = [];
    const outcome = await playQueueWhenLoaded(
      async () => {
        const answer = await loadQueue(kind, slug);

        failed = answer.outcome === "failed";
        loaded = answer.outcome === "found" ? answer.tracks : [];

        return loaded;
      },
      { stillWanted: () => mounted.current },
    );

    if (!mounted.current) {
      return;
    }

    if (outcome === "played") {
      setHanded(queueKey(loaded));
      setState("idle");

      return;
    }

    setState(failed ? "failed" : outcome === "empty" ? "empty" : "idle");
  };

  return (
    <button
      aria-busy={state === "loading" ? true : undefined}
      aria-label={
        active ? `Pause ${name}` : state === "empty" ? `No previews for ${name}` : `Play ${name}`
      }
      className="hub-tile-play"
      data-discovery-play=""
      data-lit={lit ? "" : undefined}
      data-missing={state === "empty" ? "" : undefined}
      data-status={active ? "playing" : paused ? "paused" : state}
      onClick={() => void onClick()}
      type="button"
    >
      <span aria-hidden="true" className="hub-tile-play-glyph">
        {active ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
      </span>
    </button>
  );
}
