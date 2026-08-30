# Public projection maintenance timer

`fluncle-projection-maintenance` is the permanent five-minute convergence loop for the two public projection families after their shared cutover opens. Each firing enters database admission, reads projection status exactly once, and stays mutation-free unless `public_aggregates` or `artist_qualification` has marker debt, an epoch mismatch, or—in the aggregate family—an invalid anchor document.

The payload is fixed and bounded: each affected family receives only `fluncle admin projections advance --target <public_aggregates|artist_qualification> --action repair --limit 500 --max-steps 4 --json`. Both families may run in one tick, and each has its own error boundary. Spending the four-step budget is a healthy incomplete result; the next firing resumes the server-owned cursors. The summary reports inspected families, processed subjects, gate state, per-family completion, and errors. It deliberately omits `queue_depth` because status uses capped probes and cannot prove an exact remaining depth.

The timer is default-dark. A dark cutover performs one status read, reports `gateState: "disabled"`, and issues no advance. An open idle cutover also issues no advance. Installation cannot enable the cutover or change public read routing.

Rebuild, exact audit, and every cutover change remain attended operator operations. The agent token can read bounded status and invoke repair only for the two public families; it cannot rebuild, audit, repair track/crawl projections, or mutate any cutover.

The sweep is visible as `cron.projection-maintenance` on `/status` and as `projections.repair` in the run ledger/admission registry. Install or refresh it through the roster-derived [`../install-host-timers.sh`](../install-host-timers.sh). Rollout is image first, then timer installation, then an attended service start while the cutover is dark; verify a disabled ledger row before relying on the recurring schedule. Roll back by disabling the timer. If public reads must roll back too, the operator separately closes `public_projections`; never grant the recurring sweep that authority.
