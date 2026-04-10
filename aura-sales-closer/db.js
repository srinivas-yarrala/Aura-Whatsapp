/* Keep in sync with ../db.js (parent repo). */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ensures the parent directory of the DB file exists (same directory as
 * path.dirname(process.env.DATABASE_PATH) when server passes that value into createDb).
 * Does not throw on mkdir failure — logs a warning so the app can surface a clearer SQLite error next.
 */
function ensureDir(dbFilePath) {
  if (!dbFilePath || dbFilePath === ':memory:') {
    return;
  }
  const dir = path.dirname(path.resolve(dbFilePath));
  if (fs.existsSync(dir)) {
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(
      `[aura-db] Could not create database directory "${dir}": ${err.message}. ` +
        'Use a writable DATABASE_PATH (e.g. ./data/aura.db under the app, or a mounted persistent disk).',
    );
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
      full_name TEXT,
      phone TEXT,
      address TEXT,
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

    CREATE TABLE IF NOT EXISTS browse_state (
      wa_id TEXT PRIMARY KEY,
      ordered_product_ids TEXT NOT NULL DEFAULT '[]',
      next_index INTEGER NOT NULL DEFAULT 0,
      last_window_start INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS buy_now_flow (
      wa_id TEXT PRIMARY KEY,
      step TEXT NOT NULL,
      draft_name TEXT,
      draft_phone TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  for (const { name, ddl } of [
    { name: 'full_name', ddl: 'ALTER TABLE leads ADD COLUMN full_name TEXT' },
    { name: 'phone', ddl: 'ALTER TABLE leads ADD COLUMN phone TEXT' },
    { name: 'address', ddl: 'ALTER TABLE leads ADD COLUMN address TEXT' },
  ]) {
    const cols = db.prepare('PRAGMA table_info(leads)').all();
    if (!cols.some((c) => c.name === name)) {
      db.exec(ddl);
    }
  }

  const claimStmt = db.prepare(
    'INSERT OR IGNORE INTO processed_messages (id, processed_at) VALUES (?, ?)',
  );
  const logStmt = db.prepare(
    `INSERT INTO conversation_log (wa_id, direction, body, meta_message_id, created_at)
     VALUES (@wa_id, @direction, @body, @meta_message_id, @created_at)`,
  );
  const leadStmt = db.prepare(
    `INSERT INTO leads (wa_id, email, full_name, phone, address, raw_snippet, created_at)
     VALUES (@wa_id, @email, @full_name, @phone, @address, @raw_snippet, @created_at)`,
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
  const upsertBrowseStmt = db.prepare(
    `INSERT INTO browse_state (wa_id, ordered_product_ids, next_index, last_window_start, updated_at)
     VALUES (@wa_id, @ordered_product_ids, @next_index, @last_window_start, @updated_at)
     ON CONFLICT(wa_id) DO UPDATE SET
       ordered_product_ids = excluded.ordered_product_ids,
       next_index = excluded.next_index,
       last_window_start = excluded.last_window_start,
       updated_at = excluded.updated_at`,
  );
  const getBrowseStmt = db.prepare('SELECT * FROM browse_state WHERE wa_id = ?');
  const upsertBuyNowFlowStmt = db.prepare(
    `INSERT INTO buy_now_flow (wa_id, step, draft_name, draft_phone, updated_at)
     VALUES (@wa_id, @step, @draft_name, @draft_phone, @updated_at)
     ON CONFLICT(wa_id) DO UPDATE SET
       step = excluded.step,
       draft_name = excluded.draft_name,
       draft_phone = excluded.draft_phone,
       updated_at = excluded.updated_at`,
  );
  const getBuyNowFlowStmt = db.prepare('SELECT * FROM buy_now_flow WHERE wa_id = ?');
  const clearBuyNowFlowStmt = db.prepare('DELETE FROM buy_now_flow WHERE wa_id = ?');

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

  function insertLead({ waId, email, fullName, phone, address, rawSnippet }) {
    leadStmt.run({
      wa_id: waId,
      email: email ?? null,
      full_name: fullName ?? null,
      phone: phone ?? null,
      address: address ?? null,
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

  function upsertBrowseState(waId, { orderedProductIds, nextIndex, lastWindowStart }) {
    const now = Date.now();
    upsertBrowseStmt.run({
      wa_id: waId,
      ordered_product_ids: JSON.stringify(Array.isArray(orderedProductIds) ? orderedProductIds : []),
      next_index: Number(nextIndex) || 0,
      last_window_start: Number(lastWindowStart) || 0,
      updated_at: now,
    });
  }

  function getBrowseState(waId) {
    const row = getBrowseStmt.get(waId);
    if (!row) {
      return null;
    }
    let orderedProductIds = [];
    try {
      const parsed = JSON.parse(row.ordered_product_ids || '[]');
      if (Array.isArray(parsed)) {
        orderedProductIds = parsed.map((x) => String(x));
      }
    } catch {
      /* ignore */
    }
    return {
      orderedProductIds,
      nextIndex: row.next_index ?? 0,
      lastWindowStart: row.last_window_start ?? 0,
    };
  }

  function upsertBuyNowFlow(waId, { step, draftName = null, draftPhone = null }) {
    upsertBuyNowFlowStmt.run({
      wa_id: waId,
      step,
      draft_name: draftName,
      draft_phone: draftPhone,
      updated_at: Date.now(),
    });
  }

  function getBuyNowFlow(waId) {
    const row = getBuyNowFlowStmt.get(waId);
    if (!row) {
      return null;
    }
    return {
      step: row.step,
      draftName: row.draft_name || null,
      draftPhone: row.draft_phone || null,
    };
  }

  function clearBuyNowFlow(waId) {
    clearBuyNowFlowStmt.run(waId);
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
    upsertBrowseState,
    getBrowseState,
    upsertBuyNowFlow,
    getBuyNowFlow,
    clearBuyNowFlow,
    pruneProcessed,
    ping,
    close,
  };
}

module.exports = { createDb, DEFAULT_PRUNE_MS };
