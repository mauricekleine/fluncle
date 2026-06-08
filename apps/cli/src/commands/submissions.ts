import { createInterface } from "node:readline/promises";
import { adminApiGet, adminApiPost } from "../api";
import { addCommand } from "./add";

type Submission = {
  id: string;
  spotifyTrackId: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  note?: string;
  contact?: string;
  source: "web" | "cli";
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt?: string;
};

type SubmissionsResponse = {
  ok: true;
  submissions: Submission[];
};

type SubmissionResponse = {
  ok: true;
  submission: Submission;
};

export async function listSubmissionsCommand(): Promise<void> {
  const response = await adminApiGet<SubmissionsResponse>("/api/admin/submissions");

  if (response.submissions.length === 0) {
    console.log("No pending submissions.");
    return;
  }

  console.log(response.submissions.map(formatSubmissionSummary).join("\n\n"));
}

export async function reviewSubmissionCommand(submissionId: string): Promise<void> {
  const submission = await fetchSubmission(submissionId);

  console.log(formatSubmissionDetail(submission));
}

export async function rejectSubmissionCommand(submissionId: string): Promise<void> {
  const response = await adminApiPost<SubmissionResponse>(
    `/api/admin/submissions/${encodeURIComponent(submissionId)}/reject`,
  );

  console.log(`Rejected ${formatTrackLine(response.submission)}.`);
}

export async function approveSubmissionCommand(submissionId: string): Promise<void> {
  const submission = await fetchSubmission(submissionId);

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

  await addCommand(submission.spotifyUrl, {
    note: submission.note,
  });

  await adminApiPost<SubmissionResponse>(
    `/api/admin/submissions/${encodeURIComponent(submission.id)}/approve`,
  );

  console.log(`Approved ${formatTrackLine(submission)}.`);
}

async function fetchSubmission(submissionId: string): Promise<Submission> {
  const response = await adminApiGet<SubmissionResponse>(
    `/api/admin/submissions/${encodeURIComponent(submissionId)}`,
  );

  return response.submission;
}

async function confirm(label: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
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
