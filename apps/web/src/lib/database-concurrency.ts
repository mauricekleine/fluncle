/**
 * The primary Worker client preserves ordinary request fan-out while capping
 * libSQL's default of 20 concurrent requests. This is a per-client cap, not
 * aggregate admission control for the Worker.
 */
export const PRIMARY_DB_CONCURRENCY = 4;

/**
 * The telemetry client matches `readRunLedger`'s three-query fan-out while
 * keeping ledger diagnostics independent from the primary client.
 */
export const TELEMETRY_DB_CONCURRENCY = 3;

/**
 * The catalogue-public-entities count intentionally permits its three-count
 * read to fan out together.
 */
export const CATALOGUE_PUBLIC_ENTITY_COUNT_DB_CONCURRENCY = 3;

/**
 * Maintenance, benchmark, seed, and readiness remote clients use one slot:
 * these tools perform sequential or deliberately batched work.
 */
export const REMOTE_DB_CONCURRENCY = 1;

/**
 * Local, file, and test clients use one slot to document serial intent even
 * though the current sqlite3 transport ignores this option.
 */
export const LOCAL_DB_CONCURRENCY = 1;
