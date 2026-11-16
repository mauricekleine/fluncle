# Production Worker rollback

Use this runbook when a severe regression is confirmed to correlate with a deployment, a known-good published version is compatible with current production state, and a forward fix is blocked or slower. If the evidence points to a provider or data problem, or compatibility cannot be established, investigate a compatible forward fix or feature disable instead. **Maurice's explicit approval is required for a rollback and for holding or cancelling production builds.** A rollback is mitigation, not proof that the underlying database or service has recovered.

Run `cf` from the Fluncle worktree so the account wrapper selects the correct account. Obtain the Worker name and Workers Builds script tag from the operator's private configuration; the two identifiers are not interchangeable. Keep command output containing bindings, settings, URLs or identifiers out of public records. Cloudflare permits rollback to the 100 most recently published versions; propagation across its network takes time. See [Cloudflare's rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Identify and check the target

1. Record the incident symptoms, onset, current served SHA and deployment. List deployments; the first is the latest actively serving deployment. Inspect its versions and those of a candidate that served successfully before the regression:

   ```sh
   cf workers deployments list --worker '<worker-name>' --per-page 20
   cf workers deployments get '<deployment-id>' --worker '<worker-name>'
   cf workers versions get '<version-id>' --worker '<worker-name>'
   cf builds versions get --version-ids '<version-id>'
   ```

2. Match the candidate version to its Workers Build and `build_trigger_metadata.commit_hash`; check the build outcome, deployment time, Git commit and incident evidence together. A timestamp alone does not prove a SHA or that the version was healthy. If the association or known-good state cannot be established, stop. Record the candidate version, full SHA, deployment and build IDs and evidence in the incident receipt. `cf builds logs '<build-uuid>'` provides cursor-paginated build logs when further correlation is needed.
3. Compare the candidate and active version's bindings and settings, including secrets, resource existence, compatibility flags and external service contracts. Confirm the old code can use the current primary and telemetry schemas and data, including any post-deploy activations. Applied migrations stay forward: never down-migrate; restore required schema forward before rolling code back. See [production migrations](./local-database.md#production-deploy--migrations). A deleted bound resource or a Durable Object class lifecycle change can block rollback. Do not bypass Cloudflare deployment checks.
4. Check old assets against pages already loaded or cached from the newer version: those pages can request files the old version lacks. Assess the impact and confirm an acceptable mitigation before proceeding. Version metadata alone does not establish asset compatibility.

## Hold publication and roll back

An already queued or running Workers Build can publish after the rollback and replace it. List builds using the script tag, record their UUIDs and states, and coordinate a hold on new deploy-triggering merges and rebuilds. With Maurice's approval, cancel every queued or running production build that could publish, then recheck the list and deployment state. Cancellation is not a durable trigger disable: maintain the hold until the forward recovery is ready. If publication cannot be held or a build may already be deploying, stop and resolve that race before rolling back.

```sh
cf builds list --worker '<worker-script-tag>' --per-page 20
cf builds cancel '<build-uuid>'
```

After approval and compatibility checks, deploy the selected existing version to 100% of traffic. This creates a deployment without building or running the repository's migration chain. Do not pass `--bypass-deployment-checks`.

```sh
cf workers deployments create --worker '<worker-name>' --strategy percentage --versions '[{"version_id":"<known-good-version-id>","percentage":100}]'
```

Record the returned deployment ID and time, then list deployments again to confirm the intended version and traffic percentage. If Cloudflare rejects the deployment, preserve the error and resolve the incompatibility; do not force it.

## Verify and resume

Use a few spaced requests to `https://www.fluncle.com/api/v1/health` and check the JSON `sha` against the selected commit, including on HTTP 503. The endpoint also reports `database.status`, `latencyMs` and `queueWaitMs`; compare them with the incident baseline. Check error rates and database-admission queue or yield trends in the existing telemetry, and make only small representative read probes of the affected path. A served SHA confirms code identity, not database recovery; a 503 or persistent errors require continued incident response. Recheck the deployment and builds while propagation settles, and record the evidence and any remaining impact.

`bun run deploy:verify <sha>` is a forward-deploy check: it expects the target SHA or a descendant to be served. An intentional rollback behind the target cannot satisfy that correlation. Record the rollback deployment and health evidence separately; do not call the forward check green or trigger a rebuild merely to clear it while the hold is in effect.

Once a compatible fix is reviewed and ready, coordinate release of the hold and use the normal Workers Builds deploy path. Confirm the new build and deployment, run `bun run deploy:verify <merged-sha>` for the forward commit, and verify health and incident signals again. Follow [deploy completion and fallback](./quality-system.md#deploy-completion-and-fallback) for the verifier's outcome and any missing build.
