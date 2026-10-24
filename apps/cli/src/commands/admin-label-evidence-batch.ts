import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createLabelEvidenceDeps,
  gatherLabelEvidence,
  labelEvidenceLines,
  EVIDENCE_SOURCES,
  type LabelEvidence,
  type LabelEvidenceDeps,
  type LabelEvidenceOptions,
} from "./admin-label-evidence";

type BatchOptions = LabelEvidenceOptions & {
  manifest?: string;
  out: string;
  refresh: boolean;
};

function atomicWrite(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function gatherLabelEvidenceBatch(
  inputs: string[],
  options: BatchOptions,
  deps: LabelEvidenceDeps,
): Promise<{ lines: string[]; ok: boolean }> {
  const out = resolve(options.out);
  const manifest = resolve(options.manifest ?? join(out, "manifest.jsonl"));
  mkdirSync(out, { recursive: true });
  mkdirSync(dirname(manifest), { recursive: true });
  const runId = basename(dirname(manifest));
  const slice = out;
  const attempt = randomUUID();
  const record = (event: Record<string, unknown>) =>
    appendFileSync(
      manifest,
      `${JSON.stringify({ at: new Date().toISOString(), attempt, runId, slice, ...event })}\n`,
      { mode: 0o600 },
    );
  const labels = [...new Set(inputs)];
  const lines: string[] = [];
  let ok = true;
  record({ labels, state: "started" });

  for (const input of labels) {
    record({ input, state: "pending" });
  }

  for (const input of labels) {
    let evidence: LabelEvidence;
    try {
      evidence = await gatherLabelEvidence(input, options, deps);
    } catch (error) {
      ok = false;
      const message = error instanceof Error ? error.message : String(error);
      const entry = {
        id: input,
        input,
        message,
        path: null,
        sources: Object.fromEntries(EVIDENCE_SOURCES.map((source) => [source, "skipped"])),
        state: "failed",
      };
      record(entry);
      lines.push(`manifest ${JSON.stringify(entry)}`);
      continue;
    }

    const key = encodeURIComponent(evidence.label.mbLabelId);
    const path = join(out, `${key}.json`);
    const summaryPath = join(out, `${key}.txt`);
    const summary = labelEvidenceLines(evidence);
    atomicWrite(path, `${JSON.stringify(evidence, null, 2)}\n`);
    atomicWrite(summaryPath, `${summary.join("\n")}\n`);
    const entry = {
      id: evidence.label.mbLabelId,
      input,
      path,
      sources: Object.fromEntries(
        Object.entries(evidence.sources).map(([name, source]) => [name, source.status]),
      ),
      state: evidence.ok ? "ready" : "failed",
      summaryPath,
    };
    record(entry);
    lines.push(...summary, `manifest ${JSON.stringify(entry)}`);
    ok &&= evidence.ok;
  }

  record({ labels, ok, state: "completed" });
  lines.push(`round manifest: ${manifest}`);
  return { lines, ok };
}

export async function labelEvidenceBatchCommand(inputs: string[], options: BatchOptions) {
  return gatherLabelEvidenceBatch(inputs, options, await createLabelEvidenceDeps(options.refresh));
}
