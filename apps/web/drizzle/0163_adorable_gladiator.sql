CREATE TABLE `artifact_change_checkpoints` (
	`completed_at` text,
	`consumer_digest` text,
	`consumer_id` text NOT NULL,
	`consumer_item_count` integer NOT NULL,
	`cursor` text,
	`generation` text NOT NULL,
	`phase` text NOT NULL,
	`snapshot_seq` integer NOT NULL,
	`source_digest` text,
	`source_item_count` integer NOT NULL,
	`started_at` text NOT NULL,
	`state` text NOT NULL,
	`stream` text NOT NULL,
	`stream_version` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`consumer_id`, `stream`, `stream_version`, `phase`),
	FOREIGN KEY (`consumer_id`) REFERENCES `artifact_change_consumers`(`consumer_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifact_change_checkpoints_phase_check" CHECK("artifact_change_checkpoints"."phase" in ('rebuild', 'audit')),
	CONSTRAINT "artifact_change_checkpoints_state_check" CHECK("artifact_change_checkpoints"."state" in ('running', 'complete')),
	CONSTRAINT "artifact_change_checkpoints_value_check" CHECK("artifact_change_checkpoints"."stream_version" >= 1 and "artifact_change_checkpoints"."snapshot_seq" >= 0 and "artifact_change_checkpoints"."source_item_count" >= 0 and "artifact_change_checkpoints"."consumer_item_count" >= 0),
	CONSTRAINT "artifact_change_checkpoints_lifecycle_check" CHECK(("artifact_change_checkpoints"."state" = 'running' and "artifact_change_checkpoints"."completed_at" is null)
        or ("artifact_change_checkpoints"."state" = 'complete' and "artifact_change_checkpoints"."completed_at" is not null and "artifact_change_checkpoints"."source_digest" is not null and "artifact_change_checkpoints"."consumer_digest" is not null))
);
--> statement-breakpoint
CREATE INDEX `artifact_change_checkpoints_running_idx` ON `artifact_change_checkpoints` (`state`,`updated_at`,`consumer_id`,`stream`,`stream_version`) WHERE "artifact_change_checkpoints"."state" = 'running';--> statement-breakpoint
CREATE TABLE `artifact_change_consumer_contracts` (
	`consumer_id` text NOT NULL,
	`declared_at` text NOT NULL,
	`format_version` integer NOT NULL,
	`stream` text NOT NULL,
	`stream_version` integer NOT NULL,
	PRIMARY KEY(`consumer_id`, `stream`, `stream_version`, `format_version`),
	FOREIGN KEY (`consumer_id`) REFERENCES `artifact_change_consumers`(`consumer_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifact_change_consumer_contracts_version_check" CHECK("artifact_change_consumer_contracts"."stream_version" >= 1 and "artifact_change_consumer_contracts"."format_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE `artifact_change_consumers` (
	`applied_through_seq` integer,
	`checkpointed_at` text,
	`consumer_id` text PRIMARY KEY NOT NULL,
	`registered_at` text NOT NULL,
	`snapshot_seq` integer,
	`state` text NOT NULL,
	`state_changed_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "artifact_change_consumers_state_check" CHECK("artifact_change_consumers"."state" in ('rebuilding', 'active', 'inactive')),
	CONSTRAINT "artifact_change_consumers_checkpoint_check" CHECK(("artifact_change_consumers"."state" = 'rebuilding' and "artifact_change_consumers"."snapshot_seq" is not null and "artifact_change_consumers"."snapshot_seq" >= 0 and "artifact_change_consumers"."applied_through_seq" is null and "artifact_change_consumers"."checkpointed_at" is null)
        or ("artifact_change_consumers"."state" = 'active' and "artifact_change_consumers"."snapshot_seq" is not null and "artifact_change_consumers"."snapshot_seq" >= 0 and "artifact_change_consumers"."applied_through_seq" is not null and "artifact_change_consumers"."applied_through_seq" >= "artifact_change_consumers"."snapshot_seq" and "artifact_change_consumers"."checkpointed_at" is not null)
        or ("artifact_change_consumers"."state" = 'inactive' and "artifact_change_consumers"."snapshot_seq" is null and "artifact_change_consumers"."applied_through_seq" is null and "artifact_change_consumers"."checkpointed_at" is null))
);
--> statement-breakpoint
CREATE INDEX `artifact_change_consumers_compaction_idx` ON `artifact_change_consumers` (`state`,`applied_through_seq`,`consumer_id`) WHERE "artifact_change_consumers"."state" = 'active';--> statement-breakpoint
CREATE TABLE `artifact_changes` (
	`created_at` text NOT NULL,
	`format_version` integer NOT NULL,
	`operation` text NOT NULL,
	`payload_blob` F32_BLOB(1024),
	`payload_json` text NOT NULL,
	`producer` text NOT NULL,
	`revision` integer NOT NULL,
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stream` text NOT NULL,
	`stream_version` integer NOT NULL,
	`subject_id` text NOT NULL,
	`subject_type` text NOT NULL,
	CONSTRAINT "artifact_changes_operation_check" CHECK("artifact_changes"."operation" in ('upsert', 'delete')),
	CONSTRAINT "artifact_changes_version_check" CHECK("artifact_changes"."format_version" >= 1 and "artifact_changes"."stream_version" >= 1 and "artifact_changes"."revision" >= 1),
	CONSTRAINT "artifact_changes_tombstone_check" CHECK("artifact_changes"."operation" <> 'delete' or "artifact_changes"."payload_blob" is null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_changes_revision_idx` ON `artifact_changes` (`stream`,`stream_version`,`subject_type`,`subject_id`,`revision`);--> statement-breakpoint
CREATE INDEX `artifact_changes_stream_seq_idx` ON `artifact_changes` (`stream`,`stream_version`,`seq`);--> statement-breakpoint
CREATE INDEX `artifact_changes_created_seq_idx` ON `artifact_changes` (`created_at`,`seq`);--> statement-breakpoint
CREATE TABLE `artist_qualification` (
	`artist_id` text PRIMARY KEY NOT NULL,
	`certified_finding_count` integer NOT NULL,
	`enabled_credit_half_units` integer NOT NULL,
	`generation` text NOT NULL,
	`is_qualified` integer NOT NULL,
	`source_version` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "artist_qualification_count_check" CHECK("artist_qualification"."certified_finding_count" >= 0 and "artist_qualification"."enabled_credit_half_units" >= 0),
	CONSTRAINT "artist_qualification_exact_check" CHECK(("artist_qualification"."is_qualified" = 1 and ("artist_qualification"."certified_finding_count" > 0 or "artist_qualification"."enabled_credit_half_units" >= 6))
        or ("artist_qualification"."is_qualified" = 0 and "artist_qualification"."certified_finding_count" = 0 and "artist_qualification"."enabled_credit_half_units" < 6))
);
--> statement-breakpoint
CREATE INDEX `artist_qualification_qualified_idx` ON `artist_qualification` (`is_qualified`,`artist_id`) WHERE "artist_qualification"."is_qualified" = 1;--> statement-breakpoint
CREATE TABLE `artist_qualification_state` (
	`audited_at` text,
	`completed_at` text,
	`cursor` text,
	`generation` text NOT NULL,
	`projected_digest` text,
	`projected_qualified_count` integer NOT NULL,
	`projection_epoch` integer NOT NULL,
	`rebuild_start_epoch` integer NOT NULL,
	`scanned_count` integer NOT NULL,
	`scope` text PRIMARY KEY NOT NULL,
	`source_digest` text,
	`source_epoch` integer NOT NULL,
	`source_qualified_count` integer NOT NULL,
	`started_at` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "artist_qualification_state_scope_check" CHECK("artist_qualification_state"."scope" = 'artists'),
	CONSTRAINT "artist_qualification_state_epoch_check" CHECK("artist_qualification_state"."source_epoch" >= 0 and "artist_qualification_state"."projection_epoch" >= 0 and "artist_qualification_state"."projection_epoch" <= "artist_qualification_state"."source_epoch" and "artist_qualification_state"."rebuild_start_epoch" >= 0 and "artist_qualification_state"."rebuild_start_epoch" <= "artist_qualification_state"."source_epoch"),
	CONSTRAINT "artist_qualification_state_count_check" CHECK("artist_qualification_state"."scanned_count" >= 0 and "artist_qualification_state"."source_qualified_count" >= 0 and "artist_qualification_state"."projected_qualified_count" >= 0),
	CONSTRAINT "artist_qualification_state_lifecycle_check" CHECK(("artist_qualification_state"."state" = 'running' and "artist_qualification_state"."completed_at" is null)
        or ("artist_qualification_state"."state" = 'complete' and "artist_qualification_state"."completed_at" is not null and "artist_qualification_state"."source_digest" is not null and "artist_qualification_state"."projected_digest" is not null))
);
--> statement-breakpoint
CREATE TABLE `crawl_due_work` (
	`claim_expires_at` text,
	`claim_position` integer,
	`claim_token` text,
	`claimed_by` text,
	`created_at` text NOT NULL,
	`demand_rank` integer NOT NULL,
	`generation` text NOT NULL,
	`hop` integer NOT NULL,
	`next_due_at` text,
	`node_id` text PRIMARY KEY NOT NULL,
	`node_kind` text NOT NULL,
	`source_version` text NOT NULL,
	`state` text NOT NULL,
	`storable_rank` integer,
	`updated_at` text NOT NULL,
	CONSTRAINT "crawl_due_work_node_kind_check" CHECK("crawl_due_work"."node_kind" in ('artist', 'label', 'release')),
	CONSTRAINT "crawl_due_work_state_check" CHECK("crawl_due_work"."state" in ('ready', 'scheduled', 'leased', 'repair')),
	CONSTRAINT "crawl_due_work_hop_check" CHECK("crawl_due_work"."hop" >= 0),
	CONSTRAINT "crawl_due_work_demand_rank_check" CHECK("crawl_due_work"."demand_rank" in (0, 1)),
	CONSTRAINT "crawl_due_work_storable_rank_check" CHECK(("crawl_due_work"."node_kind" = 'release' and "crawl_due_work"."storable_rank" in (0, 1)) or ("crawl_due_work"."node_kind" <> 'release' and "crawl_due_work"."storable_rank" is null)),
	CONSTRAINT "crawl_due_work_lifecycle_check" CHECK(("crawl_due_work"."state" = 'ready' and "crawl_due_work"."next_due_at" is null and "crawl_due_work"."claim_expires_at" is null and "crawl_due_work"."claim_position" is null and "crawl_due_work"."claim_token" is null and "crawl_due_work"."claimed_by" is null)
        or ("crawl_due_work"."state" = 'scheduled' and "crawl_due_work"."next_due_at" is not null and "crawl_due_work"."claim_expires_at" is null and "crawl_due_work"."claim_position" is null and "crawl_due_work"."claim_token" is null and "crawl_due_work"."claimed_by" is null)
        or ("crawl_due_work"."state" = 'leased' and "crawl_due_work"."next_due_at" is null and "crawl_due_work"."claim_expires_at" is not null and "crawl_due_work"."claim_position" is not null and "crawl_due_work"."claim_position" >= 0 and "crawl_due_work"."claim_token" is not null and "crawl_due_work"."claimed_by" is not null)
        or ("crawl_due_work"."state" = 'repair' and "crawl_due_work"."next_due_at" is null and "crawl_due_work"."claim_expires_at" is null and "crawl_due_work"."claim_position" is null and "crawl_due_work"."claim_token" is null and "crawl_due_work"."claimed_by" is null))
);
--> statement-breakpoint
CREATE INDEX `crawl_due_work_release_ready_idx` ON `crawl_due_work` (`state`,`storable_rank`,`hop`,`demand_rank`,`created_at`,`node_id`) WHERE "crawl_due_work"."state" = 'ready' and "crawl_due_work"."node_kind" = 'release';--> statement-breakpoint
CREATE INDEX `crawl_due_work_ready_idx` ON `crawl_due_work` (`state`,`hop`,`demand_rank`,`created_at`,`node_id`) WHERE "crawl_due_work"."state" = 'ready';--> statement-breakpoint
CREATE INDEX `crawl_due_work_scheduled_idx` ON `crawl_due_work` (`state`,`next_due_at`,`node_id`) WHERE "crawl_due_work"."state" = 'scheduled';--> statement-breakpoint
CREATE INDEX `crawl_due_work_repair_idx` ON `crawl_due_work` (`state`,`node_id`) WHERE "crawl_due_work"."state" = 'repair';--> statement-breakpoint
CREATE INDEX `crawl_due_work_lease_idx` ON `crawl_due_work` (`state`,`claim_expires_at`,`node_id`) WHERE "crawl_due_work"."state" = 'leased';--> statement-breakpoint
CREATE UNIQUE INDEX `crawl_due_work_claim_position_idx` ON `crawl_due_work` (`claimed_by`,`claim_token`,`claim_position`) WHERE "crawl_due_work"."state" = 'leased';--> statement-breakpoint
CREATE TABLE `crawl_due_work_rebuilds` (
	`completed_at` text,
	`cursor` text,
	`generation` text NOT NULL,
	`projected_count` integer NOT NULL,
	`projected_digest` text,
	`scanned_count` integer NOT NULL,
	`scope` text PRIMARY KEY NOT NULL,
	`source_digest` text,
	`started_at` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "crawl_due_work_rebuilds_scope_check" CHECK("crawl_due_work_rebuilds"."scope" = 'frontier'),
	CONSTRAINT "crawl_due_work_rebuilds_count_check" CHECK("crawl_due_work_rebuilds"."projected_count" >= 0 and "crawl_due_work_rebuilds"."scanned_count" >= 0),
	CONSTRAINT "crawl_due_work_rebuilds_state_check" CHECK(("crawl_due_work_rebuilds"."state" = 'running' and "crawl_due_work_rebuilds"."completed_at" is null)
        or ("crawl_due_work_rebuilds"."state" = 'complete' and "crawl_due_work_rebuilds"."completed_at" is not null and "crawl_due_work_rebuilds"."source_digest" is not null and "crawl_due_work_rebuilds"."projected_digest" is not null))
);
--> statement-breakpoint
CREATE TABLE `hub_page_anchor_validity` (
	`anchor_format_version` integer NOT NULL,
	`clause_hash` text NOT NULL,
	`generation` text NOT NULL,
	`hub` text NOT NULL,
	`order_epoch` integer NOT NULL,
	`published_at` text NOT NULL,
	PRIMARY KEY(`hub`, `clause_hash`),
	CONSTRAINT "hub_page_anchor_validity_version_check" CHECK("hub_page_anchor_validity"."anchor_format_version" >= 1 and "hub_page_anchor_validity"."order_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE `projection_repairs` (
	`created_at` text NOT NULL,
	`projection` text NOT NULL,
	`source_epoch` integer NOT NULL,
	`source_version` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`projection`, `subject_type`, `subject_id`),
	CONSTRAINT "projection_repairs_projection_check" CHECK("projection_repairs"."projection" in ('artist_qualification', 'public_aggregates')),
	CONSTRAINT "projection_repairs_subject_check" CHECK(("projection_repairs"."projection" = 'artist_qualification' and "projection_repairs"."subject_type" in ('artist', 'label', 'track'))
        or ("projection_repairs"."projection" = 'public_aggregates' and "projection_repairs"."subject_type" = 'track')),
	CONSTRAINT "projection_repairs_epoch_check" CHECK("projection_repairs"."source_epoch" >= 0)
);
--> statement-breakpoint
CREATE INDEX `projection_repairs_order_idx` ON `projection_repairs` (`projection`,`source_epoch`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `public_aggregate_counts` (
	`aggregate_kind` text NOT NULL,
	`bucket` text NOT NULL,
	`generation` text NOT NULL,
	`source_version` text NOT NULL,
	`track_count` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`aggregate_kind`, `bucket`),
	CONSTRAINT "public_aggregate_counts_kind_check" CHECK("public_aggregate_counts"."aggregate_kind" in ('key', 'release_date_bucket')),
	CONSTRAINT "public_aggregate_counts_count_check" CHECK("public_aggregate_counts"."track_count" >= 0),
	CONSTRAINT "public_aggregate_counts_bucket_check" CHECK("public_aggregate_counts"."aggregate_kind" <> 'release_date_bucket' or length("public_aggregate_counts"."bucket") <= 4)
);
--> statement-breakpoint
CREATE TABLE `public_aggregate_state` (
	`aggregate_epoch` integer NOT NULL,
	`audited_at` text,
	`completed_at` text,
	`cursor` text,
	`default_track_total` integer NOT NULL,
	`generation` text NOT NULL,
	`projected_digest` text,
	`projected_entry_count` integer NOT NULL,
	`rebuild_start_epoch` integer NOT NULL,
	`release_hub_order_epoch` integer NOT NULL,
	`scanned_count` integer NOT NULL,
	`scope` text PRIMARY KEY NOT NULL,
	`source_digest` text,
	`source_entry_count` integer NOT NULL,
	`source_epoch` integer NOT NULL,
	`started_at` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "public_aggregate_state_scope_check" CHECK("public_aggregate_state"."scope" = 'tracks'),
	CONSTRAINT "public_aggregate_state_epoch_check" CHECK("public_aggregate_state"."source_epoch" >= 0 and "public_aggregate_state"."aggregate_epoch" >= 0 and "public_aggregate_state"."aggregate_epoch" <= "public_aggregate_state"."source_epoch" and "public_aggregate_state"."rebuild_start_epoch" >= 0 and "public_aggregate_state"."rebuild_start_epoch" <= "public_aggregate_state"."source_epoch" and "public_aggregate_state"."release_hub_order_epoch" >= 0),
	CONSTRAINT "public_aggregate_state_count_check" CHECK("public_aggregate_state"."default_track_total" >= 0 and "public_aggregate_state"."scanned_count" >= 0 and "public_aggregate_state"."source_entry_count" >= 0 and "public_aggregate_state"."projected_entry_count" >= 0),
	CONSTRAINT "public_aggregate_state_lifecycle_check" CHECK(("public_aggregate_state"."state" = 'running' and "public_aggregate_state"."completed_at" is null)
        or ("public_aggregate_state"."state" = 'complete' and "public_aggregate_state"."completed_at" is not null and "public_aggregate_state"."source_digest" is not null and "public_aggregate_state"."projected_digest" is not null))
);
