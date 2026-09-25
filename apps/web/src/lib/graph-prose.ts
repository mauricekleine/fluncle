import { findingsCount } from "./format";

export type GraphEntityKind = "album" | "artist" | "galaxy" | "label";

export type GraphPreview = {
  bio?: string;

  covers: string[];

  findingCount: number;
  kind: GraphEntityKind;

  line: string | undefined;
  name: string;
  slug: string;
};

export function galaxyIntroLine(findingCount: number): string | undefined {
  if (findingCount === 0) {
    return undefined;
  }

  if (findingCount === 1) {
    return "One finding out here so far, and everything near it in sound.";
  }

  return `${findingsCount(findingCount)} that hit the same way, core of the galaxy first.`;
}

export function graphSignatureLine(
  kind: GraphEntityKind,
  name: string,
  findingCount: number,
  _firstFoundAt: string | undefined,
): string | undefined {
  switch (kind) {
    case "galaxy": {
      return galaxyIntroLine(findingCount);
    }
    default: {
      return undefined;
    }
  }
}

export function firstFoundAt(findings: { addedAt?: string }[]): string | undefined {
  return findings
    .map((finding) => finding.addedAt)
    .filter((addedAt): addedAt is string => Boolean(addedAt))
    .sort()[0];
}
