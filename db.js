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
      draft_product_id TEXT,
      draft_size TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fit_prefs_session (
      wa_id TEXT PRIMARY KEY,
      step TEXT NOT NULL CHECK(step IN ('await_size', 'await_color', 'await_fit')),
      category_row_id TEXT NOT NULL,
      category_label TEXT,
      draft_size TEXT,
      draft_color TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_fit_prefs (
      wa_id TEXT PRIMARY KEY,
      category_row_id TEXT,
      category_label TEXT,
      size TEXT,
      color TEXT,
      fit TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_session (
      wa_id TEXT PRIMARY KEY,
      category_row_id TEXT,
      category_label TEXT,
      size TEXT,
      color TEXT,
      fit TEXT,
      shop_flow_step TEXT,
      pending_color_options TEXT,
      selected_product_id TEXT,
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

  for (const { name, ddl } of [
    { name: 'shop_flow_step', ddl: 'ALTER TABLE user_session ADD COLUMN shop_flow_step TEXT' },
    {
      name: 'pending_color_options',
      ddl: 'ALTER TABLE user_session ADD COLUMN pending_color_options TEXT',
    },
    { name: 'selected_product_id', ddl: 'ALTER TABLE user_session ADD COLUMN selected_product_id TEXT' },
    { name: 'occasion', ddl: 'ALTER TABLE user_session ADD COLUMN occasion TEXT' },
    { name: 'style', ddl: 'ALTER TABLE user_session ADD COLUMN style TEXT' },
    { name: 'price_max_inr', ddl: 'ALTER TABLE user_session ADD COLUMN price_max_inr REAL' },
    { name: 'price_min_inr', ddl: 'ALTER TABLE user_session ADD COLUMN price_min_inr REAL' },
    { name: 'last_category_row_id', ddl: 'ALTER TABLE user_session ADD COLUMN last_category_row_id TEXT' },
    { name: 'last_category_label', ddl: 'ALTER TABLE user_session ADD COLUMN last_category_label TEXT' },
    { name: 'last_size', ddl: 'ALTER TABLE user_session ADD COLUMN last_size TEXT' },
    { name: 'last_style', ddl: 'ALTER TABLE user_session ADD COLUMN last_style TEXT' },
  ]) {
    const cols = db.prepare('PRAGMA table_info(user_session)').all();
    if (!cols.some((c) => c.name === name)) {
      db.exec(ddl);
    }
  }

  for (const { name, ddl } of [
    { name: 'draft_product_id', ddl: 'ALTER TABLE buy_now_flow ADD COLUMN draft_product_id TEXT' },
    { name: 'draft_size', ddl: 'ALTER TABLE buy_now_flow ADD COLUMN draft_size TEXT' },
  ]) {
    const cols = db.prepare('PRAGMA table_info(buy_now_flow)').all();
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
    `INSERT INTO buy_now_flow (wa_id, step, draft_name, draft_phone, draft_product_id, draft_size, updated_at)
     VALUES (@wa_id, @step, @draft_name, @draft_phone, @draft_product_id, @draft_size, @updated_at)
     ON CONFLICT(wa_id) DO UPDATE SET
       step = excluded.step,
       draft_name = excluded.draft_name,
       draft_phone = excluded.draft_phone,
       draft_product_id = excluded.draft_product_id,
       draft_size = excluded.draft_size,
       updated_at = excluded.updated_at`,
  );
  const getBuyNowFlowStmt = db.prepare('SELECT * FROM buy_now_flow WHERE wa_id = ?');
  const clearBuyNowFlowStmt = db.prepare('DELETE FROM buy_now_flow WHERE wa_id = ?');

  const upsertFitPrefsSessionStmt = db.prepare(
    `INSERT INTO fit_prefs_session (wa_id, step, category_row_id, category_label, draft_size, draft_color, updated_at)
     VALUES (@wa_id, @step, @category_row_id, @category_label, @draft_size, @draft_color, @updated_at)
     ON CONFLICT(wa_id) DO UPDATE SET
       step = excluded.step,
       category_row_id = excluded.category_row_id,
       category_label = excluded.category_label,
       draft_size = excluded.draft_size,
       draft_color = excluded.draft_color,
       updated_at = excluded.updated_at`,
  );
  const getFitPrefsSessionStmt = db.prepare('SELECT * FROM fit_prefs_session WHERE wa_id = ?');
  const clearFitPrefsSessionStmt = db.prepare('DELETE FROM fit_prefs_session WHERE wa_id = ?');

  const upsertCustomerFitPrefsStmt = db.prepare(
    `INSERT INTO customer_fit_prefs (wa_id, category_row_id, category_label, size, color, fit, updated_at)
     VALUES (@wa_id, @category_row_id, @category_label, @size, @color, @fit, @updated_at)
     ON CONFLICT(wa_id) DO UPDATE SET
       category_row_id = excluded.category_row_id,
       category_label = excluded.category_label,
       size = excluded.size,
       color = excluded.color,
       fit = excluded.fit,
       updated_at = excluded.updated_at`,
  );
  const getCustomerFitPrefsStmt = db.prepare('SELECT * FROM customer_fit_prefs WHERE wa_id = ?');

  const getUserSessionStmt = db.prepare('SELECT * FROM user_session WHERE wa_id = ?');
  const upsertUserSessionStmt = db.prepare(
    `INSERT INTO user_session (wa_id, category_row_id, category_label, size, color, fit, occasion, style, price_max_inr, price_min_inr, shop_flow_step, pending_color_options, selected_product_id, last_category_row_id, last_category_label, last_size, last_style, updated_at)
     VALUES (@wa_id, @category_row_id, @category_label, @size, @color, @fit, @occasion, @style, @price_max_inr, @price_min_inr, @shop_flow_step, @pending_color_options, @selected_product_id, @last_category_row_id, @last_category_label, @last_size, @last_style, @updated_at)
     ON CONFLICT(wa_id) DO UPDATE SET
       category_row_id = excluded.category_row_id,
       category_label = excluded.category_label,
       size = excluded.size,
       color = excluded.color,
       fit = excluded.fit,
       occasion = excluded.occasion,
       style = excluded.style,
       price_max_inr = excluded.price_max_inr,
       price_min_inr = excluded.price_min_inr,
       shop_flow_step = excluded.shop_flow_step,
       pending_color_options = excluded.pending_color_options,
       selected_product_id = excluded.selected_product_id,
       last_category_row_id = excluded.last_category_row_id,
       last_category_label = excluded.last_category_label,
       last_size = excluded.last_size,
       last_style = excluded.last_style,
       updated_at = excluded.updated_at`,
  );
  const wipeUserSessionStmt = db.prepare('DELETE FROM user_session WHERE wa_id = ?');

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

  function upsertBuyNowFlow(waId, patch) {
    if (!patch || typeof patch !== 'object') {
      return;
    }
    const row = getBuyNowFlowStmt.get(waId);
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    upsertBuyNowFlowStmt.run({
      wa_id: waId,
      step: has('step') ? patch.step : row?.step ?? 'await_name',
      draft_name: has('draftName') ? patch.draftName : row?.draft_name ?? null,
      draft_phone: has('draftPhone') ? patch.draftPhone : row?.draft_phone ?? null,
      draft_product_id: has('draftProductId') ? patch.draftProductId : row?.draft_product_id ?? null,
      draft_size: has('draftSize') ? patch.draftSize : row?.draft_size ?? null,
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
      draftProductId: row.draft_product_id || null,
      draftSize: row.draft_size || null,
    };
  }

  function clearBuyNowFlow(waId) {
    clearBuyNowFlowStmt.run(waId);
  }

  function upsertFitPrefsSession(
    waId,
    { step, categoryRowId, categoryLabel = null, draftSize = null, draftColor = null },
  ) {
    upsertFitPrefsSessionStmt.run({
      wa_id: waId,
      step,
      category_row_id: String(categoryRowId || ''),
      category_label: categoryLabel ?? null,
      draft_size: draftSize ?? null,
      draft_color: draftColor ?? null,
      updated_at: Date.now(),
    });
  }

  function getFitPrefsSession(waId) {
    const row = getFitPrefsSessionStmt.get(waId);
    if (!row) {
      return null;
    }
    return {
      step: row.step,
      categoryRowId: row.category_row_id || null,
      categoryLabel: row.category_label || null,
      draftSize: row.draft_size || null,
      draftColor: row.draft_color || null,
    };
  }

  function clearFitPrefsSession(waId) {
    clearFitPrefsSessionStmt.run(waId);
  }

  function upsertCustomerFitPrefs(waId, { categoryRowId, categoryLabel, size, color, fit }) {
    upsertCustomerFitPrefsStmt.run({
      wa_id: waId,
      category_row_id: categoryRowId ?? null,
      category_label: categoryLabel ?? null,
      size: size ?? null,
      color: color ?? null,
      fit: fit ?? null,
      updated_at: Date.now(),
    });
  }

  function getCustomerFitPrefs(waId) {
    const row = getCustomerFitPrefsStmt.get(waId);
    if (!row) {
      return null;
    }
    return {
      categoryRowId: row.category_row_id || null,
      categoryLabel: row.category_label || null,
      size: row.size || null,
      color: row.color || null,
      fit: row.fit || null,
    };
  }

  function parsePendingColorOptions(raw) {
    if (raw == null || raw === '') {
      return null;
    }
    try {
      const p = JSON.parse(String(raw));
      return Array.isArray(p) ? p.map((x) => String(x)) : null;
    } catch {
      return null;
    }
  }

  function patchUserSession(waId, patch) {
    if (!patch || typeof patch !== 'object') {
      return;
    }
    const row = getUserSessionStmt.get(waId);
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    upsertUserSessionStmt.run({
      wa_id: waId,
      category_row_id: has('category_row_id') ? patch.category_row_id : row?.category_row_id ?? null,
      category_label: has('category_label') ? patch.category_label : row?.category_label ?? null,
      size: has('size') ? patch.size : row?.size ?? null,
      color: has('color') ? patch.color : row?.color ?? null,
      fit: has('fit') ? patch.fit : row?.fit ?? null,
      occasion: has('occasion') ? patch.occasion : row?.occasion ?? null,
      style: has('style') ? patch.style : row?.style ?? null,
      price_max_inr: has('price_max_inr') ? patch.price_max_inr : row?.price_max_inr ?? null,
      price_min_inr: has('price_min_inr') ? patch.price_min_inr : row?.price_min_inr ?? null,
      shop_flow_step: has('shop_flow_step') ? patch.shop_flow_step : row?.shop_flow_step ?? null,
      pending_color_options: has('pending_color_options')
        ? patch.pending_color_options
        : row?.pending_color_options ?? null,
      selected_product_id: has('selected_product_id')
        ? patch.selected_product_id
        : row?.selected_product_id ?? null,
      last_category_row_id: has('last_category_row_id')
        ? patch.last_category_row_id
        : row?.last_category_row_id ?? null,
      last_category_label: has('last_category_label')
        ? patch.last_category_label
        : row?.last_category_label ?? null,
      last_size: has('last_size') ? patch.last_size : row?.last_size ?? null,
      last_style: has('last_style') ? patch.last_style : row?.last_style ?? null,
      updated_at: Date.now(),
    });
  }

  /**
   * @returns {{ category: string|null, category_label: string|null, size: string|null, color: string|null, fit: string|null, occasion: string|null, style: string|null, priceMaxInr: number|null, priceMinInr: number|null, shop_flow_step: string|null, pending_color_options: string[]|null, selectedProductId: string|null, lastCategoryRowId: string|null, lastCategoryLabel: string|null, lastSize: string|null, lastStyle: string|null } | null}
   */
  function getUserSession(waId) {
    const row = getUserSessionStmt.get(waId);
    if (!row) {
      return null;
    }
    return {
      category: row.category_row_id || null,
      category_label: row.category_label || null,
      size: row.size || null,
      color: row.color || null,
      fit: row.fit || null,
      occasion: row.occasion || null,
      style: row.style || null,
      priceMaxInr:
        row.price_max_inr != null && Number.isFinite(Number(row.price_max_inr))
          ? Number(row.price_max_inr)
          : null,
      priceMinInr:
        row.price_min_inr != null && Number.isFinite(Number(row.price_min_inr))
          ? Number(row.price_min_inr)
          : null,
      shop_flow_step: row.shop_flow_step || null,
      pending_color_options: parsePendingColorOptions(row.pending_color_options),
      selectedProductId: row.selected_product_id || null,
      lastCategoryRowId: row.last_category_row_id || null,
      lastCategoryLabel: row.last_category_label || null,
      lastSize: row.last_size || null,
      lastStyle: row.last_style || null,
    };
  }

  /** Clears active shop/checkout fields but keeps soft personalization (last_*). */
  function clearUserSession(waId) {
    const row = getUserSessionStmt.get(waId);
    if (!row) {
      return;
    }
    upsertUserSessionStmt.run({
      wa_id: waId,
      category_row_id: null,
      category_label: null,
      size: null,
      color: null,
      fit: null,
      occasion: null,
      style: null,
      price_max_inr: null,
      price_min_inr: null,
      shop_flow_step: null,
      pending_color_options: null,
      selected_product_id: null,
      last_category_row_id: row.last_category_row_id ?? null,
      last_category_label: row.last_category_label ?? null,
      last_size: row.last_size ?? null,
      last_style: row.last_style ?? null,
      updated_at: Date.now(),
    });
  }

  /** Deletes the session row entirely (including last_*). */
  function wipeUserSession(waId) {
    wipeUserSessionStmt.run(waId);
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
    upsertFitPrefsSession,
    getFitPrefsSession,
    clearFitPrefsSession,
    upsertCustomerFitPrefs,
    getCustomerFitPrefs,
    patchUserSession,
    getUserSession,
    clearUserSession,
    wipeUserSession,
    pruneProcessed,
    ping,
    close,
  };
}

module.exports = { createDb, DEFAULT_PRUNE_MS };
