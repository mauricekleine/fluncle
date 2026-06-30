// The video bundle the ship pipeline produces under out/<log-id>/, shared by the
// legacy multipart route and the presigned direct-to-R2 flow so the artifact set
// + keys + vehicle-ledger parsing live in one place.
//
// footage.mp4 is the canonical web cut (its URL becomes video_url). Under the
// two-master layout it is the CLEAN square 1920×1920
// crop source, and footage.social.mp4 is the portrait baked-text social cut
// (Stories/YouTube as-is, TikTok via audio=false MT). The audio-less variant is
// retired: surfaces derive a silent cut on the fly via an `audio=false` Media
// Transformation, so the ship pipeline no longer writes footage-silent.mp4.
// cover.jpg is the profile-grid cover, retrieved by convention with no dedicated
// column. composition.tsx + props.json + render.json make the source
// re-renderable. The rest are stored alongside at <log-id>/<name>.

export type VideoArtifact = { contentType: string; field: string; name: string };

export const VIDEO_ARTIFACTS: readonly VideoArtifact[] = [
  { contentType: "video/mp4", field: "footage", name: "footage.mp4" },
  { contentType: "video/mp4", field: "footage-social", name: "footage.social.mp4" },
  { contentType: "image/jpeg", field: "poster", name: "poster.jpg" },
  { contentType: "image/jpeg", field: "cover", name: "cover.jpg" },
  { contentType: "text/plain; charset=utf-8", field: "note", name: "note.txt" },
  { contentType: "text/plain; charset=utf-8", field: "composition", name: "composition.tsx" },
  { contentType: "application/json; charset=utf-8", field: "props", name: "props.json" },
  { contentType: "application/json; charset=utf-8", field: "render", name: "render.json" },
];

export function artifactByField(field: string): VideoArtifact | undefined {
  return VIDEO_ARTIFACTS.find((artifact) => artifact.field === field);
}
