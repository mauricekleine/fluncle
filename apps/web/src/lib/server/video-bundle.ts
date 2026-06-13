// The video bundle the ship pipeline produces under out/<log-id>/, shared by the
// legacy multipart route and the presigned direct-to-R2 flow so the artifact set
// + keys + vehicle-ledger parsing live in one place.
//
// footage.mp4 is the canonical web cut (its URL becomes video_url); the rest are
// stored alongside at <log-id>/<name>. footage-silent.mp4 is the audio-less cut
// for manual TikTok sound-attach. cover.jpg is the profile-grid cover, retrieved
// by convention with no dedicated column. composition.tsx + props.json +
// render.json make the generated source re-renderable.

export type VideoArtifact = { contentType: string; field: string; name: string };

export const VIDEO_ARTIFACTS: readonly VideoArtifact[] = [
  { contentType: "video/mp4", field: "footage", name: "footage.mp4" },
  { contentType: "video/mp4", field: "footage-silent", name: "footage-silent.mp4" },
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

// The travelling vehicle, read from render.json (ship writes it from `--vehicle`).
// Stored on the track as the diversity ledger the next agent reads via
// /api/tracks. A missing/unparseable vehicle just leaves the ledger empty.
export function vehicleFromRenderJson(raw: string): string | undefined {
  try {
    const manifest = JSON.parse(raw) as { vehicle?: unknown };

    if (typeof manifest.vehicle === "string" && manifest.vehicle.trim()) {
      return manifest.vehicle.trim().slice(0, 120);
    }
  } catch {
    // render.json is a loose manifest; never fail the upload on a bad vehicle.
  }

  return undefined;
}

// The authoring AI model, read from render.json (ship writes it from `--model`),
// in <provider>/<model> notation. Stored on the track alongside the vehicle.
// A missing/unparseable model just leaves the field empty (the caller defaults).
export function modelFromRenderJson(raw: string): string | undefined {
  try {
    const manifest = JSON.parse(raw) as { model?: unknown };

    if (typeof manifest.model === "string" && manifest.model.trim()) {
      return manifest.model.trim().slice(0, 120);
    }
  } catch {
    // render.json is a loose manifest; never fail the upload on a bad model.
  }

  return undefined;
}
