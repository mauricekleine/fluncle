import { isToolUIPart } from "ai";
import { type FluncleUIMessage } from "@/lib/server/chat";
import { type ChatCatalogueTrack } from "./catalogue-card";
import { type ChatFinding } from "./finding-card";

export type ListOutputPlan = {
  anchor?: ChatFinding;
  catalogue: ChatCatalogueTrack[];
  catalogueHeading?: string;
  findings: ChatFinding[];
};

export function planListOutput(output: unknown): ListOutputPlan | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }

  const findings =
    "findings" in output && Array.isArray(output.findings)
      ? (output.findings as ChatFinding[])
      : [];
  const catalogue =
    "catalogue" in output && Array.isArray(output.catalogue)
      ? (output.catalogue as ChatCatalogueTrack[])
      : [];

  if (findings.length === 0 && catalogue.length === 0) {
    return undefined;
  }

  const anchor = "anchor" in output && output.anchor ? (output.anchor as ChatFinding) : undefined;

  return {
    anchor,
    catalogue,
    catalogueHeading: findings.length > 0 ? "Tracks" : undefined,
    findings,
  };
}

export function collectChatFindings(messages: FluncleUIMessage[]): Map<string, ChatFinding> {
  const byLogId = new Map<string, ChatFinding>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part) || part.state !== "output-available") {
        continue;
      }

      const output = part.output;

      if (typeof output !== "object" || output === null) {
        continue;
      }

      const findings: ChatFinding[] = [];

      if ("finding" in output && output.finding) {
        findings.push(output.finding as ChatFinding);
      }
      if ("anchor" in output && output.anchor) {
        findings.push(output.anchor as ChatFinding);
      }
      if ("findings" in output && Array.isArray(output.findings)) {
        findings.push(...(output.findings as ChatFinding[]));
      }

      if ("set" in output && output.set && typeof output.set === "object") {
        const set = output.set as { seed?: ChatFinding; steps?: ChatFinding[] };

        if (set.seed) {
          findings.push(set.seed);
        }
        if (Array.isArray(set.steps)) {
          findings.push(...set.steps);
        }
      }

      for (const entityKey of ["artist", "label"] as const) {
        const entity =
          entityKey in output
            ? (output as Record<string, { findings?: unknown }>)[entityKey]
            : undefined;

        if (entity && Array.isArray(entity.findings)) {
          findings.push(...(entity.findings as ChatFinding[]));
        }
      }

      for (const finding of findings) {
        if (finding.coordinate && !byLogId.has(finding.coordinate)) {
          byLogId.set(finding.coordinate, finding);
        }
      }
    }
  }

  return byLogId;
}
