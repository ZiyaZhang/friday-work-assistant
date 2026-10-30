-- Replies are encrypted. Tombstones prevent replay until the signed state expires.
CREATE TABLE IF NOT EXISTS pending (
  state TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pending_expiry ON pending (expires_at);

-- Desktop transport. Personal content is encrypted by the desktop/host, never by this relay.
CREATE TABLE IF NOT EXISTS desktop_pairs (
  state TEXT PRIMARY KEY, request_hash TEXT NOT NULL, request TEXT NOT NULL,
  result TEXT, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_requests (
  device_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  request TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, request_id)
);
CREATE INDEX IF NOT EXISTS desktop_requests_pending ON desktop_requests(expires_at, created_at);
