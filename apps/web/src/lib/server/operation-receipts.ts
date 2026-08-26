import { startSpan } from "@sentry/core";
import { type Client, type Transaction } from "@libsql/client";
import { OPERATION_RECEIPT_KEY_MAX, OPERATION_RECEIPT_KEY_PATTERN } from "@fluncle/contracts/orpc";
import { isDatabaseOperationId } from "./database-observability";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OperationReceiptClient = Pick<Client, "execute" | "transaction">;

export type OperationReceiptEffectResult = {
  state: "committed" | "rejected";
  resultIdentity: string;
  result: JsonValue;
};

export type CommittedOperationOutcome = {
  outcome: "committed";
  state: "committed";
  resultIdentity: string;
  resultJson: string;
  result: JsonValue;
  replayed: boolean;
};

export type RejectedOperationOutcome = {
  outcome: "rejected";
  state: "rejected";
  resultIdentity: string;
  resultJson: string;
  result: JsonValue;
  replayed: boolean;
};

export type OperationConflictOutcome = {
  outcome: "conflict";
  replayed: false;
};

export type OperationInProgressOutcome = {
  outcome: "in-progress";
  state: "accepted";
  replayed: false;
};

export type OperationSafelyRetryableOutcome = {
  outcome: "safely-retryable";
  replayed: false;
};

export type OperationLookupFailedOutcome = {
  outcome: "lookup-failed";
  replayed: false;
};

export type TerminalOperationOutcome = CommittedOperationOutcome | RejectedOperationOutcome;

export type OperationReceiptOutcome =
  | TerminalOperationOutcome
  | OperationConflictOutcome
  | OperationInProgressOutcome
  | OperationSafelyRetryableOutcome
  | OperationLookupFailedOutcome;

export type ExecuteReceiptBackedOperationOptions = {
  client: OperationReceiptClient;
  operationKey: string;
  operationId: string;
  requestDigest: string;
  effect: (
    transaction: Transaction,
  ) => OperationReceiptEffectResult | Promise<OperationReceiptEffectResult>;
};

export type ReconcileOperationReceiptOptions = {
  client: OperationReceiptClient;
  operationKey: string;
  operationId: string;
  requestDigest: string;
};

export type RepairStaleOperationReceiptsOptions = {
  client: OperationReceiptClient;
  staleBefore: string;
  limit: number;
};

export type RepairStaleOperationReceiptsOutcome = {
  scanned: number;
  repaired: number;
};

export type OperationReceiptInspection =
  | { outcome: "not-found" }
  | { outcome: "lookup-failed" }
  | {
      outcome: "found";
      createdAt: string;
      operationId: string;
      resultIdentity: string | null;
      state: "accepted" | "committed" | "rejected";
      terminalAt: string | null;
      updatedAt: string;
    };

type ReceiptRow = {
  operation_id: unknown;
  request_digest: unknown;
  result_identity: unknown;
  result_json: unknown;
  state: unknown;
  terminal_at: unknown;
};

type ReceiptInspectionRow = {
  created_at: unknown;
  operation_id: unknown;
  result_identity: unknown;
  state: unknown;
  terminal_at: unknown;
  updated_at: unknown;
};

type ReceiptLookup = { kind: "absent" } | { kind: "found"; outcome: OperationReceiptOutcome };

const REQUEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STRICT_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_OPERATION_ID_LENGTH = 64;
const MAX_RESULT_IDENTITY_LENGTH = 512;
const MAX_RESULT_JSON_LENGTH = 16_384;
const MAX_TIMESTAMP_LENGTH = 64;

export function canonicalOperationJson(value: JsonValue): string {
  return serializeCanonicalJson(value, new WeakSet<object>());
}

export async function digestOperationRequest(request: JsonValue): Promise<string> {
  return digestText(canonicalOperationJson(request));
}

export async function executeReceiptBackedOperation(
  options: ExecuteReceiptBackedOperationOptions,
): Promise<OperationReceiptOutcome> {
  validateOperationCoordinates(options.operationKey, options.operationId, options.requestDigest);

  return startSpan({ name: "operation receipt execute", op: "operation.receipt" }, async (span) => {
    const preflight = await lookupReceipt(
      options.client,
      options.operationKey,
      options.operationId,
      options.requestDigest,
    );

    if (preflight.kind === "found") {
      recordExecutionOutcome(span, options.operationId, preflight.outcome);
      return preflight.outcome;
    }

    let transaction: Transaction | undefined;

    try {
      transaction = await options.client.transaction("write");
      const timestamp = currentTimestamp();

      await transaction.execute({
        args: [
          options.operationKey,
          options.operationId,
          options.requestDigest,
          "accepted",
          timestamp,
          timestamp,
        ],
        sql: `insert into operation_receipts
            (operation_key, operation_id, request_digest, state, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)`,
      });

      const effectResult = await options.effect(transaction);
      const terminal = terminalOutcome(effectResult, false);
      const terminalTimestamp = currentTimestamp();
      const update = await transaction.execute({
        args: [
          terminal.state,
          terminal.resultIdentity,
          terminal.resultJson,
          terminalTimestamp,
          terminalTimestamp,
          options.operationKey,
          options.requestDigest,
        ],
        sql: `update operation_receipts
            set state = ?, result_identity = ?, result_json = ?, terminal_at = ?, updated_at = ?
            where operation_key = ? and request_digest = ? and state = 'accepted'`,
      });

      if (update.rowsAffected !== 1) {
        throw new Error("The accepted operation receipt was not terminalized");
      }

      await transaction.commit();
      recordExecutionOutcome(span, options.operationId, terminal);
      return terminal;
    } catch {
      await closeTransaction(transaction);
      const reconciled = await lookupReceipt(
        options.client,
        options.operationKey,
        options.operationId,
        options.requestDigest,
      );
      const outcome = reconciled.kind === "found" ? reconciled.outcome : safelyRetryableOutcome();
      recordExecutionOutcome(span, options.operationId, outcome);
      return outcome;
    }
  });
}

export async function reconcileOperationReceipt(
  options: ReconcileOperationReceiptOptions,
): Promise<OperationReceiptOutcome> {
  validateOperationCoordinates(options.operationKey, options.operationId, options.requestDigest);

  return startSpan(
    { name: "operation receipt reconcile", op: "operation.receipt" },
    async (span) => {
      const receipt = await lookupReceipt(
        options.client,
        options.operationKey,
        options.operationId,
        options.requestDigest,
      );
      const outcome = receipt.kind === "found" ? receipt.outcome : safelyRetryableOutcome();
      recordExecutionOutcome(span, options.operationId, outcome);
      return outcome;
    },
  );
}

/** Read one receipt's public-safe coordinates without exposing its digest or stored result. */
export async function inspectOperationReceipt(
  client: OperationReceiptClient,
  operationKey: string,
): Promise<OperationReceiptInspection> {
  validateOperationKey(operationKey);

  return inspectOperationReceiptFor(client, operationKey);
}

/** Read through the initialization-era key grammar until its Goal H contraction. */
export async function inspectOperationReceiptLegacy(
  client: OperationReceiptClient,
  operationKey: string,
): Promise<OperationReceiptInspection> {
  if (operationKey.length === 0 || operationKey.length > OPERATION_RECEIPT_KEY_MAX) {
    throw new RangeError(
      `operationKey must contain from 1 through ${OPERATION_RECEIPT_KEY_MAX} characters`,
    );
  }

  return inspectOperationReceiptFor(client, operationKey);
}

async function inspectOperationReceiptFor(
  client: OperationReceiptClient,
  operationKey: string,
): Promise<OperationReceiptInspection> {
  return startSpan({ name: "operation receipt inspect", op: "operation.receipt" }, async (span) => {
    try {
      const result = await client.execute({
        args: [operationKey],
        sql: `select operation_id, state, result_identity, created_at, updated_at, terminal_at
            from operation_receipts
            where operation_key = ?`,
      });
      const row = (result.rows as unknown as ReceiptInspectionRow[])[0];

      if (row === undefined) {
        span.setAttribute("outcome", "not-found");
        return { outcome: "not-found" };
      }

      if (
        !isDatabaseOperationId(row.operation_id) ||
        (row.state !== "accepted" && row.state !== "committed" && row.state !== "rejected") ||
        (row.result_identity !== null &&
          !isBoundedString(row.result_identity, MAX_RESULT_IDENTITY_LENGTH)) ||
        !isStrictIsoTimestamp(row.created_at) ||
        !isStrictIsoTimestamp(row.updated_at) ||
        (row.terminal_at !== null && !isStrictIsoTimestamp(row.terminal_at))
      ) {
        span.setAttribute("outcome", "lookup-failed");
        return { outcome: "lookup-failed" };
      }

      span.setAttribute("operation_id", row.operation_id);
      span.setAttribute("outcome", "found");
      span.setAttribute("state", row.state);
      return {
        createdAt: row.created_at,
        operationId: row.operation_id,
        outcome: "found",
        resultIdentity: row.result_identity,
        state: row.state,
        terminalAt: row.terminal_at,
        updatedAt: row.updated_at,
      };
    } catch {
      span.setAttribute("outcome", "lookup-failed");
      return { outcome: "lookup-failed" };
    }
  });
}

export async function repairStaleOperationReceipts(
  options: RepairStaleOperationReceiptsOptions,
): Promise<RepairStaleOperationReceiptsOutcome> {
  validateStrictIsoTimestamp(options.staleBefore, "staleBefore");

  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new RangeError("limit must be an integer from 1 through 100");
  }

  return startSpan({ name: "operation receipt repair", op: "operation.receipt" }, async (span) => {
    let scanned = 0;
    let repaired = 0;
    let transaction: Transaction | undefined;

    try {
      const page = await options.client.execute({
        args: [options.staleBefore, options.limit],
        sql: `select operation_key
            from operation_receipts
            where state = 'accepted' and updated_at < ?
            order by updated_at asc, operation_key asc
            limit ?`,
      });
      const keys = page.rows.flatMap((row) =>
        typeof row.operation_key === "string" ? [row.operation_key] : [],
      );
      scanned = keys.length;

      if (keys.length === 0) {
        span.setAttribute("outcome", "completed");
        span.setAttribute("scanned", scanned);
        span.setAttribute("repaired", repaired);
        return { repaired, scanned };
      }

      const repairs = await Promise.all(
        keys.map(async (operationKey) => ({
          operationKey,
          resultIdentity: `operation-receipt-repair:${await digestText(operationKey)}`,
        })),
      );
      const resultJson = canonicalOperationJson({ code: "stale_in_progress" });
      const terminalTimestamp = currentTimestamp();
      transaction = await options.client.transaction("write");

      for (const repair of repairs) {
        const update = await transaction.execute({
          args: [
            repair.resultIdentity,
            resultJson,
            terminalTimestamp,
            terminalTimestamp,
            repair.operationKey,
            options.staleBefore,
          ],
          sql: `update operation_receipts
              set state = 'rejected', result_identity = ?, result_json = ?, terminal_at = ?, updated_at = ?
              where operation_key = ? and state = 'accepted' and updated_at < ?`,
        });
        repaired += update.rowsAffected;
      }

      await transaction.commit();
      span.setAttribute("outcome", "completed");
      span.setAttribute("scanned", scanned);
      span.setAttribute("repaired", repaired);
      return { repaired, scanned };
    } catch (error) {
      await closeTransaction(transaction);
      span.setAttribute("outcome", "failed");
      span.setAttribute("scanned", scanned);
      span.setAttribute("repaired", repaired);
      throw error;
    }
  });
}

function serializeCanonicalJson(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Operation JSON numbers must be finite");
    }

    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError("Operation values must be finite JSON");
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Operation JSON objects must be plain objects");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Operation JSON must not contain cycles");
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Operation JSON arrays must not be sparse");
        }
        entries.push(serializeCanonicalJson(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError("Operation JSON object keys must be strings");
    }

    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeCanonicalJson(
            (value as Record<string, unknown>)[key],
            ancestors,
          )}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

async function digestText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function lookupReceipt(
  client: OperationReceiptClient,
  operationKey: string,
  operationId: string,
  requestDigest: string,
): Promise<ReceiptLookup> {
  try {
    const result = await client.execute({
      args: [operationKey],
      sql: `select operation_id, request_digest, state, result_identity, result_json, terminal_at
        from operation_receipts
        where operation_key = ?`,
    });
    const row = (result.rows as unknown as ReceiptRow[])[0];

    if (row === undefined) {
      return { kind: "absent" };
    }

    if (
      typeof row.operation_id !== "string" ||
      row.operation_id !== operationId ||
      typeof row.request_digest !== "string" ||
      row.request_digest !== requestDigest
    ) {
      return { kind: "found", outcome: conflictOutcome() };
    }

    if (row.state === "accepted") {
      return { kind: "found", outcome: inProgressOutcome() };
    }

    if (row.state !== "committed" && row.state !== "rejected") {
      return { kind: "found", outcome: lookupFailedOutcome() };
    }

    validateBoundedString(row.operation_id, "stored operation_id", MAX_OPERATION_ID_LENGTH);
    validateBoundedString(
      row.result_identity,
      "stored result_identity",
      MAX_RESULT_IDENTITY_LENGTH,
    );
    validateStrictIsoTimestamp(row.terminal_at, "stored terminal_at");

    if (
      typeof row.result_json !== "string" ||
      utf8Length(row.result_json) > MAX_RESULT_JSON_LENGTH
    ) {
      return { kind: "found", outcome: lookupFailedOutcome() };
    }

    const resultValue: unknown = JSON.parse(row.result_json);
    const canonicalResult = canonicalOperationJson(resultValue as JsonValue);
    if (canonicalResult !== row.result_json) {
      return { kind: "found", outcome: lookupFailedOutcome() };
    }

    const terminalFields = {
      replayed: true,
      result: resultValue as JsonValue,
      resultIdentity: row.result_identity,
      resultJson: row.result_json,
    };
    return {
      kind: "found",
      outcome:
        row.state === "committed"
          ? { ...terminalFields, outcome: "committed", state: "committed" }
          : { ...terminalFields, outcome: "rejected", state: "rejected" },
    };
  } catch {
    return { kind: "found", outcome: lookupFailedOutcome() };
  }
}

function terminalOutcome(
  effectResult: OperationReceiptEffectResult,
  replayed: boolean,
): TerminalOperationOutcome {
  if (
    typeof effectResult !== "object" ||
    effectResult === null ||
    (effectResult.state !== "committed" && effectResult.state !== "rejected")
  ) {
    throw new TypeError("The operation effect must return a terminal state");
  }

  validateBoundedString(effectResult.resultIdentity, "resultIdentity", MAX_RESULT_IDENTITY_LENGTH);
  const resultJson = canonicalOperationJson(effectResult.result);
  if (utf8Length(resultJson) > MAX_RESULT_JSON_LENGTH) {
    throw new RangeError(`result JSON must be at most ${MAX_RESULT_JSON_LENGTH} bytes`);
  }

  const terminalFields = {
    replayed,
    result: JSON.parse(resultJson) as JsonValue,
    resultIdentity: effectResult.resultIdentity,
    resultJson,
  };
  return effectResult.state === "committed"
    ? { ...terminalFields, outcome: "committed", state: "committed" }
    : { ...terminalFields, outcome: "rejected", state: "rejected" };
}

function validateOperationCoordinates(
  operationKey: string,
  operationId: string,
  requestDigest: string,
): void {
  validateOperationKey(operationKey);

  if (!isDatabaseOperationId(operationId)) {
    throw new TypeError("operationId must be a valid database operation id");
  }

  if (!REQUEST_DIGEST_PATTERN.test(requestDigest)) {
    throw new TypeError("requestDigest must be 64 lowercase hexadecimal characters");
  }
}

function validateOperationKey(operationKey: unknown): asserts operationKey is string {
  validateBoundedString(operationKey, "operationKey", OPERATION_RECEIPT_KEY_MAX);

  if (!OPERATION_RECEIPT_KEY_PATTERN.test(operationKey)) {
    throw new TypeError("operationKey must contain printable operation-key characters only");
  }
}

function validateBoundedString(
  value: unknown,
  name: string,
  maximum?: number,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }

  if (maximum !== undefined && utf8Length(value) > maximum) {
    throw new RangeError(`${name} must be at most ${maximum} bytes`);
  }
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && utf8Length(value) <= maximum;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateStrictIsoTimestamp(value: unknown, name: string): asserts value is string {
  if (!isStrictIsoTimestamp(value)) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
}

function isStrictIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    utf8Length(value) <= MAX_TIMESTAMP_LENGTH &&
    STRICT_ISO_PATTERN.test(value) &&
    new Date(value).toISOString() === value
  );
}

function currentTimestamp(): string {
  const timestamp = new Date().toISOString();
  validateStrictIsoTimestamp(timestamp, "timestamp");
  return timestamp;
}

async function closeTransaction(transaction: Transaction | undefined): Promise<void> {
  if (transaction === undefined) {
    return;
  }

  try {
    transaction.close();
  } catch {
    // Reconciliation is authoritative even if a broken transport cannot confirm close.
  }
}

function recordExecutionOutcome(
  span: Parameters<Parameters<typeof startSpan>[1]>[0],
  operationId: string,
  outcome: OperationReceiptOutcome,
): void {
  span.setAttribute("operation_id", operationId);
  span.setAttribute("outcome", outcome.outcome);
  span.setAttribute("replayed", outcome.replayed);
}

function conflictOutcome(): OperationConflictOutcome {
  return { outcome: "conflict", replayed: false };
}

function inProgressOutcome(): OperationInProgressOutcome {
  return { outcome: "in-progress", replayed: false, state: "accepted" };
}

function safelyRetryableOutcome(): OperationSafelyRetryableOutcome {
  return { outcome: "safely-retryable", replayed: false };
}

function lookupFailedOutcome(): OperationLookupFailedOutcome {
  return { outcome: "lookup-failed", replayed: false };
}
