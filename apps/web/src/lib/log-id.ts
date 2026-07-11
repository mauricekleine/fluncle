// The Log ID format guards, re-exported from the canonical grammar in
// @fluncle/contracts/log-id — the ONE place the coordinate shape is written down
// (the finding + mixtape patterns, the `fluncle://` scheme scanner, and the shared
// cross-surface test vectors). This module stays as the web-app import site the
// `/log/$logId` route guard and the admin backfill validation already use, so those
// importers don't move; only the definition did.
export { isLogId, isMixtapeLogId } from "@fluncle/contracts/log-id";
