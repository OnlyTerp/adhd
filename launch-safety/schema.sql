CREATE TABLE launch_requests (
 session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 configuration TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','claimed','started','unknown','completed','rejected')),
 delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','sending','sent','unknown')),
 dispatch_id TEXT,
 claim_id TEXT,
 receipt TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
