export const DUE_WORK_COLUMN_NAMES = [
  "claim_expires_at",
  "claim_token",
  "claimed_by",
  "generation",
  "next_due_at",
  "sort_key",
  "source_version",
  "state",
  "subject_id",
  "subject_type",
  "updated_at",
  "work_kind",
] as const;

export const DUE_WORK_COLUMNS = `claim_expires_at, claim_token, claimed_by, generation, next_due_at,
  sort_key, source_version, state, subject_id, subject_type, updated_at, work_kind`;
