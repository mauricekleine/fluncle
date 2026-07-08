# fluncle-audit-review — the 05:00 nightly-audit reviewer

The reviewer half of the nightly codebase audit. It reviews the PR the 1am `fluncle-audit`
auditor opened, fixes small residual nits, and **merges** when the required CI checks are green
and nothing high-impact remains — otherwise it comments and leaves the PR open for the operator.

The full doctrine for both timers (the rotation, the fix-vs-file contract, the secrets, the
one-time activation + pilot, and how to watch it) lives in the sibling
[`../audit-timer/README.md`](../audit-timer/README.md). This unit pair
(`fluncle-audit-review.service` + `.timer`) just triggers `/opt/hermes-scripts/audit-review-sweep.sh`
at 05:00 Amsterdam; `../install-host-timers.sh` installs it alongside the auditor.
