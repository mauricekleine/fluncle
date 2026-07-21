import {
  type Submission,
  type SubmissionResponse,
  type SubmissionsResponse,
} from "@fluncle/contracts";
import { createInterface } from "node:readline/promises";
import { adminApiGet, adminApiPost } from "../api";
import { CliError, printJson } from "../output";
import { addCommand } from "./add";

export type { Submission };

type JsonOptions = { json?: boolean };

export async function listSubmissionsCommand(options: JsonOptions = {}): Promise<void> {
  const response = await adminApiGet<SubmissionsResponse>("/api/v1/admin/submissions");

  if (options.json) {
    printJson({ ok: true, submissions: response.submissions });
    return;
  }

  if (response.submissions.length === 0) {
    console.log("No pending submissions.");
    return;
  }

  console.log(response.submissions.map(formatSubmissionSummary).join("\n\n"));
}

export async function reviewSubmissionCommand(
  submissionId: string,
  options: JsonOptions = {},
): Promise<void> {
  const submission = await fetchSubmission(submissionId);

  if (options.json) {
    printJson({ ok: true, submission });
    return;
  }

  console.log(formatSubmissionDetail(submission));
}

export async function rejectSubmissionCommand(
  submissionId: string,
  options: JsonOptions = {},
): Promise<void> {
  const response = await adminApiPost<SubmissionResponse>(
    `/api/v1/admin/submissions/${encodeURIComponent(submissionId)}/reject`,
  );

  if (options.json) {
    printJson({ ok: true, submission: response.submission });
    return;
  }

  console.log(`Rejected ${formatTrackLine(response.submission)}.`);
}

export async function approveSubmissionCommand(
  submissionId: string,
  options: JsonOptions = {},
): Promise<void> {
  const submission = await fetchSubmission(submissionId);

  if (!options.json) {
    console.log(formatSubmissionDetail(submission));
    console.log("");

    await addCommand(submission.spotifyUrl, {
      dryRun: true,
    });

    const confirmed = await confirm("Publish this submission? (Y/n) ");

    if (!confirmed) {
      console.log("Approval cancelled.");
      return;
    }
  }

  await addCommand(submission.spotifyUrl, {
    json: options.json,
    note: submission.note,
  });

  const response = await adminApiPost<SubmissionResponse>(
    `/api/v1/admin/submissions/${encodeURIComponent(submission.id)}/approve`,
  );

  if (options.json) {
    printJson({ ok: true, submission: response.submission });
    return;
  }

  console.log(`Approved ${formatTrackLine(submission)}.`);
}

// `admin submissions triage <id> --verdict <text>` — write the pre-chew advisory
// verdict onto a PENDING submission (the `fluncle-triage` box sweep's delivery step).
// AGENT tier: it moves no approve/reject authority, so the box's agent token drives it.
export async function triageSubmissionCommand(
  submissionId: string,
  verdict: string,
  options: JsonOptions & { promptVersion?: number } = {},
): Promise<void> {
  const response = await adminApiPost<SubmissionResponse>(
    `/api/v1/admin/submissions/${encodeURIComponent(submissionId)}/triage`,
    {
      // PROVENANCE — omitted when the sweep fell back to its baked-in prompt, so the
      // column stays NULL (docs/agents/prompt-registry.md).
      ...(typeof options.promptVersion === "number"
        ? { promptVersion: options.promptVersion }
        : {}),
      verdict,
    },
  );

  if (options.json) {
    printJson({ ok: true, submission: response.submission });
    return;
  }

  console.log(
    `Triaged ${formatTrackLine(response.submission)}: ${response.submission.triageVerdict ?? ""}`,
  );
}

async function fetchSubmission(submissionId: string): Promise<Submission> {
  const response = await adminApiGet<SubmissionResponse>(
    `/api/v1/admin/submissions/${encodeURIComponent(submissionId)}`,
  );

  return response.submission;
}

// Approval is a publish; it needs an explicit yes. Off a TTY there's no way to
// ask, so error clearly (matching the other interactive prompts) instead of
// silently treating a scripted approve as a cancelled no-op. `--json` is the
// non-interactive path: it approves without prompting.
async function confirm(label: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "not_interactive",
      "Approving publishes a submission and needs a yes. Run this in a terminal, or pass --json to approve without the prompt.",
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await rl.question(label)).trim().toLowerCase();

    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function formatSubmissionSummary(submission: Submission): string {
  return [
    `${submission.id}`,
    `${formatTrackLine(submission)} (${submission.source})`,
    submission.contact ? `Contact: ${submission.contact}` : undefined,
    submission.note ? `Note: ${submission.note}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSubmissionDetail(submission: Submission): string {
  return [
    `${submission.id}`,
    formatTrackLine(submission),
    `Status: ${submission.status}`,
    `Source: ${submission.source}`,
    `Created: ${submission.createdAt}`,
    submission.contact ? `Contact: ${submission.contact}` : undefined,
    submission.note ? `Note: ${submission.note}` : undefined,
    `Spotify: ${submission.spotifyUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTrackLine(submission: Submission): string {
  return `${submission.artists.join(", ")} — ${submission.title}`;
}
