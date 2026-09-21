// Tiny SQLite wrapper for storing chat history.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'chat.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- "Clear chat" is per-person only: it never deletes a message, it just
  -- records the last message id a given user has chosen to hide, so their
  -- own future history queries skip everything up to that point while the
  -- other person's history is completely unaffected.
  CREATE TABLE IF NOT EXISTS clears (
    user_id TEXT PRIMARY KEY,
    cleared_upto_id INTEGER NOT NULL DEFAULT 0
  );

  -- Read receipts: records the highest message id each user has actually
  -- seen (chat open, unlocked, visible). To show a "seen" tick on a message
  -- you sent, the server checks the *other* account's read_upto_id.
  CREATE TABLE IF NOT EXISTS reads (
    user_id TEXT PRIMARY KEY,
    read_upto_id INTEGER NOT NULL DEFAULT 0
  );

  -- "Delete for me": per-user, per-message -- like "clear chat" but for a
  -- single message instead of everything up to a point. Never touches the
  -- message itself, so the other person's copy is completely unaffected.
  CREATE TABLE IF NOT EXISTS deleted_for_me (
    user_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  );
`);

// Migration for image/video support -- ALTER TABLE ADD COLUMN so this also
// upgrades a database created before this feature existed, not just fresh ones.
const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
if (!messageColumns.includes('type')) db.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
if (!messageColumns.includes('media_path')) db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT');
if (!messageColumns.includes('media_mime')) db.exec('ALTER TABLE messages ADD COLUMN media_mime TEXT');
if (!messageColumns.includes('reply_to_id')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER');
if (!messageColumns.includes('reply_to_sender')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_sender TEXT');
if (!messageColumns.includes('reply_to_text')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_text TEXT');
if (!messageColumns.includes('reply_to_type')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_type TEXT');

const insertStmt = db.prepare(`
  INSERT INTO messages (sender, text, ts, type, media_path, media_mime, reply_to_id, reply_to_sender, reply_to_text, reply_to_type)
  VALUES (@sender, @text, @ts, @type, @media_path, @media_mime, @reply_to_id, @reply_to_sender, @reply_to_text, @reply_to_type)
`);
const recentStmt = db.prepare(`
  SELECT id, sender, text, ts, type, media_path, media_mime, reply_to_id, reply_to_sender, reply_to_text, reply_to_type
  FROM messages
  WHERE id > ? AND id NOT IN (SELECT message_id FROM deleted_for_me WHERE user_id = ?)
  ORDER BY id DESC LIMIT ?
`);
const getMessageByIdStmt = db.prepare(`
  SELECT id, sender, text, ts, type, media_path, media_mime, reply_to_id, reply_to_sender, reply_to_text, reply_to_type
  FROM messages WHERE id = ?
`);
const deleteForEveryoneStmt = db.prepare(
  "UPDATE messages SET text = '', type = 'deleted', media_path = NULL, media_mime = NULL WHERE id = ?"
);
const deleteForMeStmt = db.prepare('INSERT OR IGNORE INTO deleted_for_me (user_id, message_id) VALUES (?, ?)');
const maxIdStmt = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM messages');
const getClearStmt = db.prepare('SELECT cleared_upto_id FROM clears WHERE user_id = ?');
const upsertClearStmt = db.prepare(`
  INSERT INTO clears (user_id, cleared_upto_id) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET cleared_upto_id = excluded.cleared_upto_id
`);

// mediaPath, if given, is just the stored filename under data/uploads/ --
// never a full disk path -- so it can be turned straight into a /uploads/
// URL for clients without leaking anything about the server's filesystem.
// replyTo, if given, is a small snapshot {id, sender, text, type} of the
// message being replied to -- stored directly rather than looked up by join,
// so the quoted preview still renders even if the original later scrolls
// out of a trimmed history window.
function saveMessage(sender, text, ts, media, replyTo) {
  const row = {
    sender,
    text,
    ts,
    type: (media && media.type) || 'text',
    media_path: (media && media.mediaPath) || null,
    media_mime: (media && media.mediaMime) || null,
    reply_to_id: (replyTo && replyTo.id) || null,
    reply_to_sender: (replyTo && replyTo.sender) || null,
    reply_to_text: (replyTo && replyTo.text) || null,
    reply_to_type: (replyTo && replyTo.type) || null,
  };
  const info = insertStmt.run(row);
  return toMessage({ id: info.lastInsertRowid, ...row });
}

function toMessage(row) {
  return {
    id: row.id,
    sender: row.sender,
    text: row.text,
    ts: row.ts,
    type: row.type || 'text',
    mediaUrl: row.media_path ? '/uploads/' + row.media_path : null,
    mediaMime: row.media_mime || null,
    replyTo: row.reply_to_id
      ? { id: row.reply_to_id, sender: row.reply_to_sender, text: row.reply_to_text, type: row.reply_to_type }
      : null,
  };
}

function getClearedUptoId(userId) {
  const row = getClearStmt.get(userId);
  return row ? row.cleared_upto_id : 0;
}

function getRecentMessages(userId, limit = 200) {
  const clearedUptoId = getClearedUptoId(userId);
  const rows = recentStmt.all(clearedUptoId, userId, limit);
  return rows.reverse().map(toMessage); // oldest first
}

function getMessageById(id) {
  const row = getMessageByIdStmt.get(id);
  return row ? toMessage(row) : null;
}

// Only ever call this after confirming the requester actually owns the
// message (see server.js) -- this itself doesn't check who's asking.
function deleteMessageForEveryone(id) {
  deleteForEveryoneStmt.run(id);
}

function deleteMessageForUser(userId, id) {
  deleteForMeStmt.run(userId, id);
}

// Marks everything up to "right now" as cleared for this user only.
function clearChatForUser(userId) {
  const { maxId } = maxIdStmt.get();
  upsertClearStmt.run(userId, maxId);
}

const getReadStmt = db.prepare('SELECT read_upto_id FROM reads WHERE user_id = ?');
const upsertReadStmt = db.prepare(`
  INSERT INTO reads (user_id, read_upto_id) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET read_upto_id = excluded.read_upto_id
`);

function getReadUpToId(userId) {
  const row = getReadStmt.get(userId);
  return row ? row.read_upto_id : 0;
}

// Only ever moves forward -- an older/out-of-order mark_read can't un-read something.
function markReadUpToId(userId, upToId) {
  const current = getReadUpToId(userId);
  const next = Math.max(current, upToId);
  if (next !== current) upsertReadStmt.run(userId, next);
  return next;
}

const upsertSubStmt = db.prepare(`
  INSERT INTO push_subscriptions (user_id, endpoint, subscription, created_at)
  VALUES (@user_id, @endpoint, @subscription, @created_at)
  ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription
`);
const subsForOthersStmt = db.prepare('SELECT id, endpoint, subscription FROM push_subscriptions WHERE user_id != ?');
const subsCountForUserStmt = db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?');
const deleteSubByEndpointStmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');

function savePushSubscription(userId, subscription) {
  upsertSubStmt.run({
    user_id: userId,
    endpoint: subscription.endpoint,
    subscription: JSON.stringify(subscription),
    created_at: Date.now(),
  });
}

function getPushSubscriptionsForOthers(userId) {
  return subsForOthersStmt.all(userId).map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    subscription: JSON.parse(row.subscription),
  }));
}

function deletePushSubscriptionByEndpoint(endpoint) {
  deleteSubByEndpointStmt.run(endpoint);
}

function getSubscriptionCountForUser(userId) {
  return subsCountForUserStmt.get(userId).c;
}

module.exports = {
  saveMessage,
  getRecentMessages,
  getMessageById,
  deleteMessageForEveryone,
  deleteMessageForUser,
  clearChatForUser,
  getReadUpToId,
  markReadUpToId,
  savePushSubscription,
  getPushSubscriptionsForOthers,
  getSubscriptionCountForUser,
  deletePushSubscriptionByEndpoint,
};
