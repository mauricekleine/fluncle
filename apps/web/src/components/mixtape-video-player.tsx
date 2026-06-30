import { Video } from "@/components/video";
import { mixtapeSetVideoUrl } from "@/lib/media";
import { mixtapeCoverUrl } from "@/lib/mixtapes";

// The mixtape `/log` set player: a branded, canon-styled `<video>` with a real SEEK
// scrubber — the finding footage player is play/pause-only (fine for a 30s loop,
// useless for a ~72-min set). The set video is the bare R2 master
// (`<log-id>/set.mp4`, range-streamed + faststart) — NOT a Cloudflare Media
// Transformation: the file is well past MT's 100MB source ceiling, so the player
// fetches the master directly and the browser range-seeks it.
//
// Composed from the shared `<Video>` compound: `Video.Root` owns the "one clock"
// state machine + stall recovery; the transport rides as an AUTO-HIDING overlay over
// the set frame (the /log polish) — visible on hover/focus/scrub and while paused,
// fading away during playback.

export function MixtapeVideoPlayer({ logId, title }: { logId: string; title: string }) {
  const src = mixtapeSetVideoUrl(logId);
  const poster = mixtapeCoverUrl(logId, "card");

  return (
    <figure className="mixtape-player">
      <Video.Root src={src}>
        <Video.Surface
          className="mixtape-stage"
          mediaClassName="mixtape-player-media"
          poster={poster}
        >
          <Video.Controls overlay>
            <Video.PlayButton className="mixtape-player-toggle" label={title} />
            <Video.Scrubber label={`Seek through ${title}`} />
            <Video.Time className="mixtape-player-time" />
          </Video.Controls>
        </Video.Surface>
      </Video.Root>
    </figure>
  );
}
