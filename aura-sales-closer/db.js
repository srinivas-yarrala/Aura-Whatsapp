/* Keep in sync with ../db.js (parent repo). */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createDb(dbPath) {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_processed_messages_at ON processed_messages(processed_at);

    CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      body TEXT,
      meta_message_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_wa ON conversation_log(wa_id);

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT NOT NULL,
      email TEXT,
      raw_snippet TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leads_wa ON leads(wa_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'model')),
      message_text TEXT,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_phone_time ON messages(phone_number, timestamp);

    CREATE TABLE IF NOT EXISTS media_cache (
      image_url TEXT PRIMARY KEY,
      media_id TEXT NOT NULL
    );
  `);

  const claimStmt = db.prepare(
    'INSERT OR IGNORE INTO processed_messages (id, processed_at) VALUES (?, ?)',
  );
  const logStmt = db.prepare(
    `INSERT INTO conversation_log (wa_id, direction, body, meta_message_id, created_at)
     VALUES (@wa_id, @direction, @body, @meta_message_id, @created_at)`,
  );
  const leadStmt = db.prepare(
    `INSERT INTO leads (wa_id, email, raw_snippet, created_at)
     VALUES (@wa_id, @email, @raw_snippet, @created_at)`,
  );
  const pruneStmt = db.prepare('DELETE FROM processed_messages WHERE processed_at < ?');

  const insertMessageStmt = db.prepare(
    `INSERT INTO messages (phone_number, role, message_text, timestamp)
     VALUES (@phone_number, @role, @message_text, @timestamp)`,
  );
  const fetchRecentStmt = db.prepare(
    `SELECT role, message_text, timestamp FROM messages
     WHERE phone_number = @phone_number
     ORDER BY timestamp DESC, id DESC
     LIMIT @limit`,
  );
  const lastUserTsStmt = db.prepare(
    `SELECT MAX(timestamp) AS ts FROM messages
     WHERE phone_number = ? AND role = 'user'`,
  );
  const getMediaStmt = db.prepare(
    'SELECT media_id FROM media_cache WHERE image_url = ?',
  );
  const upsertMediaStmt = db.prepare(
    `INSERT OR REPLACE INTO media_cache (image_url, media_id) VALUES (?, ?)`,
  );

  function tryClaimMessage(messageId) {
    if (!messageId) {
      return false;
    }
    const now = Date.now();
    const info = claimStmt.run(messageId, now);
    return info.changes > 0;
  }

  function logMessage({ waId, direction, body, metaMessageId }) {
    const createdAt = Date.now();
    const truncated =
      body && body.length > 8000 ? `${body.slice(0, 8000)}…[truncated]` : body ?? null;
    logStmt.run({
      wa_id: waId,
      direction,
      body: truncated,
      meta_message_id: metaMessageId || null,
      created_at: createdAt,
    });
  }

  function insertLead({ waId, email, rawSnippet }) {
    leadStmt.run({
      wa_id: waId,
      email,
      raw_snippet: rawSnippet && rawSnippet.length > 2000 ? rawSnippet.slice(0, 2000) : rawSnippet,
      created_at: Date.now(),
    });
  }

  function insertChatMessage(phoneNumber, role, messageText, timestampMs) {
    insertMessageStmt.run({
      phone_number: phoneNumber,
      role,
      message_text: messageText ?? null,
      timestamp: timestampMs,
    });
  }

  /** Most recent first (DESC). */
  function fetchRecentChatMessages(phoneNumber, limit) {
    const rows = fetchRecentStmt.all({ phone_number: phoneNumber, limit });
    return rows.reverse();
  }

  /** Latest inbound user message time (ms), or null if none. Call before inserting the current user row. */
  function getLastUserInboundTimestamp(phoneNumber) {
    const row = lastUserTsStmt.get(phoneNumber);
    return row?.ts != null ? row.ts : null;
  }

  function getCachedMediaId(imageUrl) {
    const row = getMediaStmt.get(imageUrl);
    return row?.media_id || null;
  }

  function upsertMediaCache(imageUrl, mediaId) {
    upsertMediaStmt.run(imageUrl, mediaId);
  }

  function pruneProcessed(maxAgeMs = DEFAULT_PRUNE_MS) {
    const cutoff = Date.now() - maxAgeMs;
    pruneStmt.run(cutoff);
  }

  function ping() {
    db.prepare('SELECT 1 AS ok').get();
  }

  function close() {
    db.close();
  }

  return {
    tryClaimMessage,
    logMessage,
    insertLead,
    insertChatMessage,
    fetchRecentChatMessages,
    getLastUserInboundTimestamp,
    getCachedMediaId,
    upsertMediaCache,
    pruneProcessed,
    ping,
    close,
  };
}

module.exports = { createDb, DEFAULT_PRUNE_MS };
