CREATE TABLE IF NOT EXISTS receipts (
  access_key TEXT PRIMARY KEY CHECK(length(access_key) = 44),
  expense_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
