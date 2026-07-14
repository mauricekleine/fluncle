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
// re-renderable; intent.json + metrics.json carry the render-intent contract and
// the deterministic gate report beside it; scene.json is the fluncle.scene/1 replay
// manifest (the resolved shader body a live/offline host re-runs). The rest are
// stored alongside at <log-id>/<name>.
//
// plate.png + plate.background.png are the PLATE-LANE inputs (a Gemini-authored
// photographic plate + its subject-removed background for true parallax): uploaded
// FIRST, before the composition exists, so the composition can reference the
// durable https://found.fluncle.com/<log-id>/plate.png URL — renders, archival
// replay, and live all read the same key. A plate-less (abstract) bundle is fully
// valid, and a plate bundle without its background is fine; neither is ever part
// of the re-render contract.
//
// Everything past the two masters is OPTIONAL: the CLI only requests presigns
// for files the bundle actually contains, so a bundle without the extra
// variants (the notext/landscape escape hatches ship packages when present) or
// without intent/metrics/scene/plate uploads exactly as before.

export type VideoArtifact = { contentType: string; field: string; name: string };

export const VIDEO_ARTIFACTS: readonly VideoArtifact[] = [
  { contentType: "video/mp4", field: "footage", name: "footage.mp4" },
  { contentType: "video/mp4", field: "footage-social", name: "footage.social.mp4" },
  { contentType: "video/mp4", field: "footage-notext", name: "footage.notext.mp4" },
  { contentType: "video/mp4", field: "footage-landscape", name: "footage.landscape.mp4" },
  {
    contentType: "video/mp4",
    field: "footage-landscape-social",
    name: "footage.landscape.social.mp4",
  },
  { contentType: "image/jpeg", field: "poster", name: "poster.jpg" },
  { contentType: "image/jpeg", field: "cover", name: "cover.jpg" },
  { contentType: "image/png", field: "plate", name: "plate.png" },
  { contentType: "image/png", field: "plate-background", name: "plate.background.png" },
  { contentType: "text/plain; charset=utf-8", field: "note", name: "note.txt" },
  { contentType: "text/plain; charset=utf-8", field: "composition", name: "composition.tsx" },
  { contentType: "application/json; charset=utf-8", field: "props", name: "props.json" },
  { contentType: "application/json; charset=utf-8", field: "render", name: "render.json" },
  { contentType: "application/json; charset=utf-8", field: "intent", name: "intent.json" },
  { contentType: "application/json; charset=utf-8", field: "metrics", name: "metrics.json" },
  { contentType: "application/json; charset=utf-8", field: "scene", name: "scene.json" },
];

export function artifactByField(field: string): VideoArtifact | undefined {
  return VIDEO_ARTIFACTS.find((artifact) => artifact.field === field);
}

// The finalize-side stamp fields render.json carries: the diversity-ledger trio
// (vehicle/grain/register — docs/planning/homogenisation-evidence.md) plus the
// authoring model/reasoning provenance.
export type RenderManifestStamps = {
  grain?: string;
  model?: string;
  reasoning?: string;
  register?: string;
  vehicle?: string;
};

const MANIFEST_STAMP_KEYS = ["grain", "model", "reasoning", "register", "vehicle"] as const;

// THE TRANSPORT-PROOF STAMP FALLBACK (the 044.1.3L lesson, 2026-07-14): the render
// box's ship crashed mid-upload (a Bun segfault on the box runtime), the agent
// salvaged with a partial per-file upload, and finalize arrived WITHOUT the
// diversity-ledger trio — even though render.json was already sitting on R2 in the
// same bundle. The bundle's own manifest is the authority of record, so the finalize
// handler calls this to fill any stamp the request body left out. Best-effort by
// contract: a missing, corrupt, or unreadable manifest returns {} and NEVER fails
// the finalize — the ship must land regardless.
export async function readRenderManifestStamps(
  bucket: Pick<R2Bucket, "get">,
  logId: string,
): Promise<RenderManifestStamps> {
  try {
    const object = await bucket.get(`${logId}/render.json`);

    if (!object) {
      return {};
    }

    const manifest = (await object.json()) as Record<string, unknown>;
    const stamps: RenderManifestStamps = {};

    for (const key of MANIFEST_STAMP_KEYS) {
      const value = manifest[key];

      if (typeof value === "string" && value.trim()) {
        stamps[key] = value.trim().slice(0, 120);
      }
    }

    return stamps;
  } catch {
    return {};
  }
}
