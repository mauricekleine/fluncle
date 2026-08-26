import { DATABASE_CLIENT_BOUNDS } from "./client-bounds";
import { simulateMixedLoad } from "./mixed-load";
import { PerformanceRegistry, sqlContract } from "./registry";

export const performanceRegistry = new PerformanceRegistry();

performanceRegistry.register(
  sqlContract({
    description: "A bounded pending-frontier claim uses the synthetic eligibility index",
    id: "fixture.frontier-pending-claim",
    iterations: 20,
    plan: {
      policy: {
        forbidTempSort: true,
        growingTables: ["perf_crawl_frontier"],
        requiredDetails: [/perf_crawl_frontier_state_id_idx/i],
      },
      statement: {
        args: ["pending", 25],
        sql: "select id from perf_crawl_frontier where state = ? order by id limit ?",
      },
    },
    statement: {
      args: ["pending", 25],
      sql: "select id from perf_crawl_frontier where state = ? order by id limit ?",
    },
    validate(execution) {
      if (execution.resultRowCount < 1 || execution.resultRowCount > 25) {
        return [`bounded claim returned ${execution.resultRowCount} rows`];
      }

      return [];
    },
    warmupIterations: 2,
    workClass: "queue",
  }),
);

performanceRegistry.register({
  description: "Held heavy reader, public reads, and serialized batches honor per-client bounds",
  async execute() {
    const report = simulateMixedLoad();
    const writes = report.events.filter((event) => event.workClass === "write-batch");

    return {
      batchCount: writes.reduce((sum, event) => sum + (event.batchCount ?? 0), 0),
      durationMs: report.latencyMs["public-read"].p95,
      metadata: {
        heavyReaderLatencyP50Ms: report.latencyMs["heavy-reader"].p50,
        heavyReaderLatencyP95Ms: report.latencyMs["heavy-reader"].p95,
        heavyReaderLatencyP99Ms: report.latencyMs["heavy-reader"].p99,
        heavyReaderQueueP50Ms: report.queueMs["heavy-reader"].p50,
        heavyReaderQueueP95Ms: report.queueMs["heavy-reader"].p95,
        heavyReaderQueueP99Ms: report.queueMs["heavy-reader"].p99,
        maxPrimaryConcurrency: report.maxConcurrentByClient.primary,
        primaryBound: report.bounds.primary,
        publicReadLatencyP50Ms: report.latencyMs["public-read"].p50,
        publicReadLatencyP95Ms: report.latencyMs["public-read"].p95,
        publicReadLatencyP99Ms: report.latencyMs["public-read"].p99,
        publicReadQueueP50Ms: report.queueMs["public-read"].p50,
        publicReadQueueP95Ms: report.queueMs["public-read"].p95,
        publicReadQueueP99Ms: report.queueMs["public-read"].p99,
        scope: report.scope,
        telemetryBound: report.bounds.telemetry,
        violations: report.violations.length,
        writeBatchLatencyP50Ms: report.latencyMs["write-batch"].p50,
        writeBatchLatencyP95Ms: report.latencyMs["write-batch"].p95,
        writeBatchLatencyP99Ms: report.latencyMs["write-batch"].p99,
        writeBatchQueueP50Ms: report.queueMs["write-batch"].p50,
        writeBatchQueueP95Ms: report.queueMs["write-batch"].p95,
        writeBatchQueueP99Ms: report.queueMs["write-batch"].p99,
      },
      queueMs: report.queueMs["public-read"].p95,
      resultRowCount: report.events.length,
    };
  },
  id: "client.mixed-load",
  iterations: 20,
  validate() {
    return simulateMixedLoad({ bounds: DATABASE_CLIENT_BOUNDS }).violations;
  },
  workClass: "route-db",
});

export function selectPerformanceContracts(ids: readonly string[]) {
  if (ids.length === 0) {
    return performanceRegistry.list();
  }

  return [...new Set(ids)].map((id) => performanceRegistry.get(id));
}
