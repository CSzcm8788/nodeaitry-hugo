CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_key TEXT NOT NULL UNIQUE,
  page_url TEXT NOT NULL,
  page_title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  parent_id INTEGER,
  root_id INTEGER,
  depth INTEGER NOT NULL DEFAULT 0,
  author_name TEXT NOT NULL,
  author_email_hash TEXT,
  author_link TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  is_admin INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web',
  avatar_url TEXT,
  ip TEXT,
  ip_country TEXT,
  ip_country_code TEXT,
  ip_asn TEXT,
  ip_as_org TEXT,
  browser TEXT,
  os TEXT,
  user_agent TEXT,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id),
  FOREIGN KEY (parent_id) REFERENCES comments(id),
  FOREIGN KEY (root_id) REFERENCES comments(id)
);

CREATE INDEX IF NOT EXISTS idx_pages_page_key ON pages(page_key);
CREATE INDEX IF NOT EXISTS idx_comments_page_status_created ON comments(page_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_root_id ON comments(root_id);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
CREATE INDEX IF NOT EXISTS idx_comments_telegram_message_id ON comments(telegram_message_id);
