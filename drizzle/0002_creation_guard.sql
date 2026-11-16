ALTER TABLE sessions ADD COLUMN create_request_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX sessions_owner_create_request ON sessions(owner,create_request_id) WHERE create_request_id IS NOT NULL;
