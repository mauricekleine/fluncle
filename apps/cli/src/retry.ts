// `formatError` is the byte-shared error-stringifier — one definition in
// `@fluncle/contracts/util` (the web Worker reads the same). Re-exported so
// `./retry` importers keep their entrypoint.
export { formatError } from "@fluncle/contracts/util";
