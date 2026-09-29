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
import {
  listSonarCentroidDigestsLive,
  listSonarCentroidsLive,
  listSonarTrackDigestsLive,
  listSonarTracksLive,
} from "../sonar-source-reads";
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

  const listSonarTrackDigestsHandler = os.list_sonar_track_digests
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return { ...(await listSonarTrackDigestsLive(input)), ok: true as const };
      } catch (error) {
        throw toFault(error);
      }
    });

  const listSonarTracksHandler = os.list_sonar_tracks.use(adminAuth).handler(async ({ input }) => {
    try {
      return { ...(await listSonarTracksLive(input)), ok: true as const };
    } catch (error) {
      throw toFault(error);
    }
  });

  const listSonarCentroidDigestsHandler = os.list_sonar_centroid_digests
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return { ...(await listSonarCentroidDigestsLive(input)), ok: true as const };
      } catch (error) {
        throw toFault(error);
      }
    });

  const listSonarCentroidsHandler = os.list_sonar_centroids
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return { ...(await listSonarCentroidsLive(input)), ok: true as const };
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
    list_sonar_centroid_digests: listSonarCentroidDigestsHandler,
    list_sonar_centroids: listSonarCentroidsHandler,
    list_sonar_track_digests: listSonarTrackDigestsHandler,
    list_sonar_tracks: listSonarTracksHandler,
    register_artifact_consumer: registerArtifactConsumerHandler,
  };
}
