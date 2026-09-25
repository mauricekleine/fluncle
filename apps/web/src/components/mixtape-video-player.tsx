import { Video } from "@/components/video";
import { mixtapeSetVideoUrl } from "@/lib/media";
import { mixtapeCoverUrl } from "@/lib/mixtapes";

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
