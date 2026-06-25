// The video bundle the ship pipeline produces under out/<log-id>/, shared by the
// legacy multipart route and the presigned direct-to-R2 flow so the artifact set
// + keys + vehicle-ledger parsing live in one place.
//
// footage.mp4 is the canonical web cut (its URL becomes video_url). Under the
// two-master layout (docs/video-variants.md) it is the CLEAN square 1920×1920
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

// render.json is a loose manifest the ship pipeline writes (vehicle, grain,
// model, reasoning). Each field is read independently: a missing/unparseable
// value just leaves that field empty (the caller defaults), never failing an upload.
type RenderManifestField = "grain" | "model" | "reasoning" | "vehicle";

function stringFromManifest(raw: string, key: RenderManifestField): string | undefined {
  try {
    const manifest = JSON.parse(raw) as Record<RenderManifestField, unknown>;
    const value = manifest[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 120);
    }
  } catch {
    // Loose manifest; never fail the upload on a bad field.
  }

  return undefined;
}

/** The travelling vehicle (ship writes it from `--vehicle`) — the diversity ledger. */
export function vehicleFromRenderJson(raw: string): string | undefined {
  return stringFromManifest(raw, "vehicle");
}

/** The grain FAMILY (ship writes it from `--grain`) — the grain diversity ledger. */
export function grainFromRenderJson(raw: string): string | undefined {
  return stringFromManifest(raw, "grain");
}

/** The authoring AI model (ship writes it from `--model`), in `<provider>/<model>` notation. */
export function modelFromRenderJson(raw: string): string | undefined {
  return stringFromManifest(raw, "model");
}

/** The reasoning/thinking effort the authoring model ran at (ship writes it from `--reasoning`). */
export function reasoningFromRenderJson(raw: string): string | undefined {
  return stringFromManifest(raw, "reasoning");
}
