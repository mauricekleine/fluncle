CREATE TABLE `operation_receipts` (
	`created_at` text NOT NULL,
	`operation_id` text NOT NULL,
	`operation_key` text PRIMARY KEY NOT NULL,
	`request_digest` text NOT NULL,
	`result_identity` text,
	`result_json` text,
	`state` text NOT NULL,
	`terminal_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "operation_receipts_identity_bounds_check" CHECK(typeof("operation_receipts"."operation_key") = 'text' and length(cast("operation_receipts"."operation_key" as blob)) between 1 and 256
        and typeof("operation_receipts"."operation_id") = 'text' and length(cast("operation_receipts"."operation_id" as blob)) between 1 and 64
        and ("operation_receipts"."result_identity" is null or (typeof("operation_receipts"."result_identity") = 'text' and length(cast("operation_receipts"."result_identity" as blob)) between 1 and 512))),
	CONSTRAINT "operation_receipts_digest_check" CHECK(typeof("operation_receipts"."request_digest") = 'text' and length("operation_receipts"."request_digest") = 64 and length(cast("operation_receipts"."request_digest" as blob)) = 64 and "operation_receipts"."request_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "operation_receipts_result_json_check" CHECK("operation_receipts"."result_json" is null or (typeof("operation_receipts"."result_json") = 'text' and length(cast("operation_receipts"."result_json" as blob)) between 1 and 16384 and json_valid("operation_receipts"."result_json"))),
	CONSTRAINT "operation_receipts_timestamp_check" CHECK(typeof("operation_receipts"."created_at") = 'text' and length(cast("operation_receipts"."created_at" as blob)) between 1 and 64
        and typeof("operation_receipts"."updated_at") = 'text' and length(cast("operation_receipts"."updated_at" as blob)) between 1 and 64
        and "operation_receipts"."updated_at" >= "operation_receipts"."created_at"
        and ("operation_receipts"."terminal_at" is null or (typeof("operation_receipts"."terminal_at") = 'text' and length(cast("operation_receipts"."terminal_at" as blob)) between 1 and 64 and "operation_receipts"."terminal_at" >= "operation_receipts"."created_at" and "operation_receipts"."terminal_at" <= "operation_receipts"."updated_at"))),
	CONSTRAINT "operation_receipts_state_check" CHECK("operation_receipts"."state" in ('accepted', 'committed', 'rejected')),
	CONSTRAINT "operation_receipts_lifecycle_check" CHECK(("operation_receipts"."state" = 'accepted' and "operation_receipts"."result_identity" is null and "operation_receipts"."result_json" is null and "operation_receipts"."terminal_at" is null)
        or ("operation_receipts"."state" in ('committed', 'rejected') and "operation_receipts"."result_identity" is not null and "operation_receipts"."result_json" is not null and "operation_receipts"."terminal_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `operation_receipts_stale_accepted_idx` ON `operation_receipts` (`state`,`updated_at`,`operation_key`) WHERE "operation_receipts"."state" = 'accepted';--> statement-breakpoint
CREATE INDEX `operation_receipts_operation_audit_idx` ON `operation_receipts` (`operation_id`,`created_at`,`operation_key`);