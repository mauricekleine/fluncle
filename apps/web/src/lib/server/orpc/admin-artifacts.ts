// The artifact-log transport. Every lifecycle/read operation is agent tier so a filesystemful
// consumer can bootstrap and advance with its scoped token. Compaction alone is operator tier:
// it irreversibly removes the prefix that every live consumer has already fenced or acknowledged.

import {
  acknowledgeArtifactChangesLive,
  activateArtifactConsumerLive,
  checkpointArtifactRebuildLive,
  compactArtifactChangesLive,
  getArtifactConsumerStatusLive,
  inactivateArtifactConsumerLive,
  listArtifactChangesLive,
  listArtifactSnapshotLive,
  registerArtifactConsumerLive,
} from "../artifact-changes";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { type Implementer, toFault } from "./_shared";

export function adminArtifactsHandlers(os: Implementer) {
  const registerArtifactConsumerHandler = os.register_artifact_consumer
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          consumer: await registerArtifactConsumerLive(input),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const getArtifactConsumerHandler = os.get_artifact_consumer
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          consumer: await getArtifactConsumerStatusLive(input.consumerId),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const listArtifactSnapshotHandler = os.list_artifact_snapshot
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          ...(await listArtifactSnapshotLive(input)),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const checkpointArtifactRebuildHandler = os.checkpoint_artifact_rebuild
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          checkpoint: await checkpointArtifactRebuildLive(input),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const activateArtifactConsumerHandler = os.activate_artifact_consumer
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          consumer: await activateArtifactConsumerLive(input.consumerId),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const listArtifactChangesHandler = os.list_artifact_changes
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          ...(await listArtifactChangesLive(input)),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const acknowledgeArtifactChangesHandler = os.acknowledge_artifact_changes
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          consumer: await acknowledgeArtifactChangesLive(input),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const inactivateArtifactConsumerHandler = os.inactivate_artifact_consumer
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          consumer: await inactivateArtifactConsumerLive(input.consumerId),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const compactArtifactChangesHandler = os.compact_artifact_changes
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return {
          ...(await compactArtifactChangesLive(input)),
          ok: true as const,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  return {
    acknowledge_artifact_changes: acknowledgeArtifactChangesHandler,
    activate_artifact_consumer: activateArtifactConsumerHandler,
    checkpoint_artifact_rebuild: checkpointArtifactRebuildHandler,
    compact_artifact_changes: compactArtifactChangesHandler,
    get_artifact_consumer: getArtifactConsumerHandler,
    inactivate_artifact_consumer: inactivateArtifactConsumerHandler,
    list_artifact_changes: listArtifactChangesHandler,
    list_artifact_snapshot: listArtifactSnapshotHandler,
    register_artifact_consumer: registerArtifactConsumerHandler,
  };
}
