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

export type RenderManifestStamps = {
  grain?: string;
  model?: string;

  palette?: string;

  plateSubject?: string;
  reasoning?: string;
  register?: string;

  structure?: string;
  vehicle?: string;
};

const MANIFEST_STAMP_KEYS = [
  "grain",
  "model",
  "palette",
  "plateSubject",
  "reasoning",
  "register",
  "vehicle",
] as const;

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

    const structure = manifest.structure;

    if (structure !== null && typeof structure === "object") {
      const dominant = (structure as Record<string, unknown>).dominant;

      if (typeof dominant === "string" && dominant.trim()) {
        stamps.structure = dominant.trim().slice(0, 120);
      }
    }

    return stamps;
  } catch {
    return {};
  }
}
