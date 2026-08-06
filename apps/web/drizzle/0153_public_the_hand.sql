CREATE TABLE `hub_page_anchors` (
	`anchors_json` text NOT NULL,
	`clause_hash` text NOT NULL,
	`computed_at` text NOT NULL,
	`fingerprint` text NOT NULL,
	`hub` text NOT NULL,
	PRIMARY KEY(`hub`, `clause_hash`)
);
