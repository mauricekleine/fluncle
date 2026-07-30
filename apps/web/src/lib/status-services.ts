// Self-posted automations that belong on /status but are not registry crons.
// Client-safe by design: both the shared server read (missing-row synthesis) and
// the page (grouping/order) consume this one explicit non-registry roster.
export const SELF_POSTED_AUTOMATION_ORDER = [
  "self-deploy",
  "self-deploy-ssh",
  "self-deploy-sonar",
] as const;
