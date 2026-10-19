PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 1,
  preferences TEXT NOT NULL,
  last_test_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  subscription TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE broadcasts (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ends_at INTEGER NOT NULL
);

CREATE TABLE deliveries (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (broadcast_id, revision, subscription_id)
);

CREATE TABLE poll_parts (
  cycle TEXT NOT NULL,
  part INTEGER NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (cycle, part)
);

CREATE TABLE source_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  checked_at INTEGER,
  last_success_at INTEGER,
  message TEXT NOT NULL
);

CREATE INDEX deliveries_pending ON deliveries(status, next_attempt);
CREATE INDEX broadcasts_expiry ON broadcasts(ends_at);
