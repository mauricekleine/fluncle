import { locateFragmentLiteral, resolveGlslBody } from "./scene";

export const STRUCTURE_FAMILIES = [
  "cellular",
  "flow",
  "caustic",
  "filament",
  "lattice",
  "radial",
  "metaball",
  "other",
] as const;

export type StructureFamily = (typeof STRUCTURE_FAMILIES)[number];

export type StructureSignal = {
  family: StructureFamily;
  score: number;
  evidence: string[];
};

export type StructureClassification = {
  dominant: StructureFamily;

  secondary?: StructureFamily;

  confidence: number;

  signals: StructureSignal[];
};

const FAMILY_FLOOR = 1.5;

const SECONDARY_RATIO = 0.35;

const GLSL_TYPE_KEYWORDS = new Set([
  "float",
  "vec2",
  "vec3",
  "vec4",
  "int",
  "uint",
  "mat2",
  "mat3",
  "mat4",
  "bool",
  "void",
]);

export function stripGlslComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function callCount(name: string, body: string): number {
  const re = new RegExp(`(\\w+)?\\s*\\b${name}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(body)) !== null) {
    if (!match[1] || !GLSL_TYPE_KEYWORDS.has(match[1])) {
      count += 1;
    }
  }
  return count;
}

function matchCount(re: RegExp, body: string): number {
  return (body.match(re) ?? []).length;
}

function detectRidge(body: string): { present: boolean; field: string | null } {
  const withPow = /pow\s*\(\s*1\.0\s*-\s*abs\s*\(\s*2\.0\s*\*\s*(\w+)/.exec(body);
  if (withPow) {
    return { field: withPow[1], present: true };
  }
  const bare = /1\.0\s*-\s*abs\s*\(\s*2\.0\s*\*\s*(\w+)/.exec(body);
  if (bare) {
    return { field: bare[1], present: true };
  }
  return { field: null, present: false };
}

function ridgeFieldIsSurface(body: string, field: string | null): boolean {
  if (!field) {
    return false;
  }

  const withoutRidge = body.replace(
    /(?:pow\s*\(\s*)?1\.0\s*-\s*abs\s*\(\s*2\.0\s*\*\s*\w+[^;]*;/g,
    ";",
  );
  const smooth = new RegExp(`smoothstep\\s*\\([^;]*\\b${field}\\b`);
  const ramp = new RegExp(`paletteRamp(?:Ok)?\\s*\\(\\s*${field}\\b`);
  return smooth.test(withoutRidge) || ramp.test(withoutRidge);
}

type Detector = {
  family: Exclude<StructureFamily, "other">;
  score: number;
  evidence: string[];
};

function addDetector(
  detectors: Detector[],
  family: Detector["family"],
  score: number,
  evidence: string[],
): void {
  if (score > 0) {
    detectors.push({ evidence, family, score });
  }
}

function detectOrganicFamilies(body: string): {
  detectors: Detector[];
  ridge: { present: boolean; field: string | null };
} {
  const detectors: Detector[] = [];

  const voronoiCalls = callCount("voronoi", body) + callCount("voronoi3", body);
  const minDistLoop = /d\s*<\s*f1/.test(body) && /f2\s*=\s*f1/.test(body);
  const edgeMath = /f2\s*-\s*f1|vor\.y\s*-\s*vor\.x|F2\s*-\s*F1/.test(body);
  const worley = /worley/i.test(body);
  const cellularAlgo = voronoiCalls > 0 || minDistLoop || edgeMath || worley;
  {
    let score = 0;
    const evidence: string[] = [];
    if (voronoiCalls > 0) {
      score += 5 * Math.min(voronoiCalls, 2);
      evidence.push(`${voronoiCalls}× voronoi()/voronoi3() call`);
    }
    if (minDistLoop) {
      score += 4;
      evidence.push("nearest-site min-distance loop (d<f1; f2=f1)");
    }
    if (edgeMath) {
      score += 2;
      evidence.push("F2−F1 cell-wall edge math");
    }
    if (worley) {
      score += 2;
      evidence.push("worley naming");
    }
    if (cellularAlgo) {
      const names = Math.min(matchCount(/\bcell(?:s|Id|Hash|Scale)?\b/gi, body), 6);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× cell* naming`);
      }
    }
    addDetector(detectors, "cellular", score, evidence);
  }

  const causticCalls = callCount("caustic", body);
  const neuroCalls = callCount("neuroWeb", body);
  const causticSig = /N\.x\s*\+\s*N\.y/.test(body) || /sine_acc\s*\+=\s*sin/.test(body);
  const causticAlgo = causticCalls > 0 || neuroCalls > 0 || causticSig;
  {
    let score = 0;
    const evidence: string[] = [];
    if (causticCalls > 0) {
      score += 5 * Math.min(causticCalls, 2);
      evidence.push(`${causticCalls}× caustic() call`);
    }
    if (neuroCalls > 0) {
      score += 4 * Math.min(neuroCalls, 2);
      evidence.push(`${neuroCalls}× neuroWeb() call`);
    }
    if (causticSig) {
      score += 2;
      evidence.push("sine-accumulator interference signature");
    }
    if (causticAlgo) {
      const names = Math.min(matchCount(/caustic|neuro/gi, body), 4);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× caustic/neuro naming`);
      }
    }
    addDetector(detectors, "caustic", score, evidence);
  }

  const ridge = detectRidge(body);
  const bareAbsInvert = /1\.0\s*-\s*abs\s*\(/.test(body) && !ridge.present;
  const filamentAlgo = ridge.present || bareAbsInvert;
  {
    let score = 0;
    const evidence: string[] = [];
    if (ridge.present) {
      score += 4;
      evidence.push("ridged inversion pow(1−abs(2n−1))");
    } else if (bareAbsInvert) {
      score += 1.5;
      evidence.push("abs()-inversion crease");
    }
    if (filamentAlgo) {
      const names = Math.min(matchCount(/ridge|filament|\bvein|thread|strand|fiber/gi, body), 6);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× ridge/filament/vein naming`);
      }
    }
    addDetector(detectors, "filament", score, evidence);
  }

  return { detectors, ridge };
}

function hasGridRepeat(
  body: string,
  minDistLoop: boolean,
  ridgePresent: boolean,
  causticCalls: number,
): boolean {
  return (
    /\bmod\s*\(/.test(body) &&
    /\bstep\s*\(/.test(body) &&
    !minDistLoop &&
    !ridgePresent &&
    causticCalls === 0
  );
}

function detectGeometricFamilies(
  body: string,
  ridge: { present: boolean; field: string | null },
): { detectors: Detector[]; ridgeSurface: boolean } {
  const detectors: Detector[] = [];
  const causticCalls = callCount("caustic", body);
  const minDistLoop = /d\s*<\s*f1/.test(body) && /f2\s*=\s*f1/.test(body);

  const flowCalls =
    callCount("domainWarp", body) +
    callCount("swirlWarp", body) +
    callCount("curlNoise", body) +
    callCount("curl3", body);
  const fbmCalls = callCount("fbm", body) + callCount("fbm3", body);
  const flowAlgo = flowCalls > 0 || fbmCalls >= 2;
  const ridgeSurface = ridgeFieldIsSurface(body, ridge.field);
  {
    let score = 0;
    const evidence: string[] = [];
    if (flowCalls > 0) {
      score += 2 * Math.min(flowCalls, 3);
      evidence.push(`${flowCalls}× domainWarp/swirlWarp/curl advection`);
    } else if (fbmCalls >= 2) {
      score += 1;
      evidence.push(`${fbmCalls}× fbm advection`);
    }
    if (flowAlgo) {
      const names = Math.min(
        matchCount(/marbl|liquid|\bflow|advect|\bwarp|smoke|\bfog|nebula/gi, body),
        6,
      );
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× flow/marble/warp naming`);
      }
      if (ridge.present && ridgeSurface) {
        score += 2;
        evidence.push("warp field rendered as a surface tone (body), not only ridged");
      }
    }
    addDetector(detectors, "flow", score, evidence);
  }

  const dotCalls = callCount("dotField", body);
  const gridRepeat = hasGridRepeat(body, minDistLoop, ridge.present, causticCalls);
  const latticeAlgo = dotCalls > 0 || gridRepeat;
  {
    let score = 0;
    const evidence: string[] = [];
    if (dotCalls > 0) {
      score += 3 * Math.min(dotCalls, 2);
      evidence.push(`${dotCalls}× dotField() stipple screen`);
    }
    if (gridRepeat) {
      score += 2;
      evidence.push("mod()+step() regular grid repeat");
    }
    if (latticeAlgo) {
      const names = Math.min(matchCount(/lattice|\bgrid|weave|halftone|\bmesh\b/gi, body), 4);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× lattice/grid/weave naming`);
      }
    }
    addDetector(detectors, "lattice", score, evidence);
  }

  const polarCalls = callCount("polarFold", body);
  const polarMap = /atan\s*\(/.test(body) && /length\s*\(\s*uv/.test(body);
  const radialAlgo = polarCalls > 0 || polarMap;
  {
    let score = 0;
    const evidence: string[] = [];
    if (polarCalls > 0) {
      score += 4;
      evidence.push("polarFold() kaleido wedge");
    }
    if (polarMap) {
      score += 2;
      evidence.push("atan()+length(uv) polar mapping");
    }
    if (radialAlgo) {
      const names = Math.min(
        matchCount(/radial|polar|kaleid|mandala|\biris|concentric/gi, body),
        4,
      );
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× radial/polar/kaleido naming`);
      }
    }
    addDetector(detectors, "radial", score, evidence);
  }

  const sminCalls = callCount("smin", body);
  const raymarchCalls = callCount("raymarch", body);
  const mapDef = /float\s+map\s*\(\s*vec3/.test(body);
  const sdfCalls =
    callCount("sdCircle", body) + callCount("sdSphere3", body) + callCount("sdBox3", body);
  const metaballAlgo = sminCalls > 0 || raymarchCalls > 0 || mapDef || sdfCalls > 0;
  {
    let score = 0;
    const evidence: string[] = [];
    if (sminCalls > 0) {
      score += 3;
      evidence.push("smin() smooth-union blend");
    }
    if (raymarchCalls > 0) {
      score += 3;
      evidence.push("raymarch() sphere-tracer");
    }
    if (mapDef) {
      score += 3;
      evidence.push("map(vec3) SDF scene");
    }
    if (sdfCalls > 0) {
      score += 2 * Math.min(sdfCalls, 2);
      evidence.push(`${sdfCalls}× SDF primitive`);
    }
    if (metaballAlgo) {
      const names = Math.min(matchCount(/metaball|\bsdf\b|raymarch|blob/gi, body), 4);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× sdf/metaball/raymarch naming`);
      }
    }
    addDetector(detectors, "metaball", score, evidence);
  }

  return { detectors, ridgeSurface };
}

function detectFamilies(body: string): {
  detectors: Detector[];
  ridge: { present: boolean; field: string | null };
  ridgeSurface: boolean;
} {
  const organic = detectOrganicFamilies(body);
  const geometric = detectGeometricFamilies(body, organic.ridge);

  return {
    detectors: [...organic.detectors, ...geometric.detectors],
    ridge: organic.ridge,
    ridgeSurface: geometric.ridgeSurface,
  };
}

export function classifyShaderStructure(resolvedBody: string): StructureClassification {
  const body = stripGlslComments(resolvedBody);
  const { detectors, ridge, ridgeSurface } = detectFamilies(body);

  const scores = new Map<Exclude<StructureFamily, "other">, Detector>();
  for (const d of detectors) {
    scores.set(d.family, d);
  }

  const flow = scores.get("flow");
  const filament = scores.get("filament");
  if (ridge.present && flow && filament) {
    if (ridgeSurface && flow.score <= filament.score) {
      flow.score = filament.score + 0.5;
      flow.evidence.push("flow-dominant: field is a rendered surface, ridges are veins on it");
    } else if (!ridgeSurface && filament.score <= flow.score) {
      filament.score = flow.score + 0.5;
      filament.evidence.push("filament-dominant: field feeds only the ridge (threads on a void)");
    }
  }

  const ranked: StructureSignal[] = [...scores.values()]
    .map((d) => ({ evidence: d.evidence, family: d.family as StructureFamily, score: d.score }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top || top.score < FAMILY_FLOOR) {
    return { confidence: 0, dominant: "other", signals: ranked };
  }

  const second = ranked[1];
  const secondary =
    second && second.score >= SECONDARY_RATIO * top.score ? second.family : undefined;

  const contender = secondary && second ? second.score : 0;
  const separation = top.score / (top.score + contender + 2);
  const confidence = Math.max(0, Math.min(1, separation));

  return {
    confidence: Number(confidence.toFixed(2)),
    dominant: top.family,
    signals: ranked,
    ...(secondary ? { secondary } : {}),
  };
}

export function classifyCompositionStructure(
  source: string,
  glsl: Record<string, string>,
): StructureClassification | null {
  const located = locateFragmentLiteral(source);
  if (!located.ok) {
    return null;
  }
  const resolved = resolveGlslBody(located.raw, glsl);
  if (!resolved.ok) {
    return null;
  }
  return classifyShaderStructure(resolved.body);
}

export type StructureManifest = {
  dominant: StructureFamily;
  secondary?: StructureFamily;
  confidence: number;
};

export function toStructureManifest(c: StructureClassification): StructureManifest {
  return {
    confidence: c.confidence,
    dominant: c.dominant,
    ...(c.secondary ? { secondary: c.secondary } : {}),
  };
}

export function labelWithStructure(
  vehicle: string | null | undefined,
  structure: StructureFamily | null | undefined,
): string {
  const v = vehicle && vehicle.trim() ? vehicle.trim() : "(no vehicle)";
  return structure ? `${v} (${structure})` : v;
}
