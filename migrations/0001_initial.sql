-- Initial schema for the temporary email service.
-- Apply with:
--   npx wrangler d1 migrations apply submail-db --local
--   npx wrangler d1 migrations apply submail-db --remote

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mailboxes (
    id                TEXT PRIMARY KEY,
    local_part        TEXT NOT NULL,
    domain            TEXT NOT NULL,
    address           TEXT NOT NULL UNIQUE,
    token_hash        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    last_activity_at  INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL
);

-- The UNIQUE constraint on `address` above is the authoritative uniqueness
-- guarantee (see src/lib/username-generator.ts and src/db/mailboxes.ts for
-- why application-level pre-checks alone are not sufficient).
CREATE INDEX IF NOT EXISTS idx_mailboxes_expires_at ON mailboxes (expires_at);
CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes (address);

CREATE TABLE IF NOT EXISTS messages (
    id                  TEXT PRIMARY KEY,
    mailbox_id          TEXT NOT NULL,
    message_id          TEXT,
    sender_name         TEXT,
    sender_address      TEXT,
    recipient_address   TEXT,
    subject             TEXT,
    text_body           TEXT,
    html_body           TEXT,
    created_at          INTEGER NOT NULL,
    size_bytes          INTEGER NOT NULL,
    has_attachments     INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_id ON messages (mailbox_id);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_id_created_at ON messages (mailbox_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
    id            TEXT PRIMARY KEY,
    message_id    TEXT NOT NULL,
    filename      TEXT NOT NULL,
    content_type  TEXT,
    size_bytes    INTEGER NOT NULL,
    r2_key        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments (message_id);
