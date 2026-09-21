require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { createServer } = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const {
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
} = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const ACCOUNTS = [
  { id: 'A', password: process.env.PASSWORD_A, name: process.env.NAME_A || 'A' },
  { id: 'B', password: process.env.PASSWORD_B, name: process.env.NAME_B || 'B' },
].filter((a) => !!a.password);

if (ACCOUNTS.length === 0) {
  console.error('No PASSWORD_A / PASSWORD_B set in the environment. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// --- push notifications (optional: app still runs fine without these set) ---
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.');
}

// Deliberately generic wording/title -- notifications never reveal who
// messaged or what was said, so a glance at a lock screen gives nothing away.
// Rotates through several so it doesn't always read as the same message.
const NOTIFICATION_TITLE = 'amazon';
const NOTIFICATION_BODIES = [
  "Today's deal: don't miss out.",
  'New deals just dropped for you.',
  'Your daily deal is here.',
  'Flash sale: limited-time offer inside.',
  "Check out today's top picks.",
  'A deal you might like just went live.',
];

// Tracks which sockets currently have the chat genuinely in front of the
// user (visible + unlocked), reported by the client itself via a "presence"
// event. This deliberately is NOT the same as "socket connected" -- a
// background tab/locked phone can keep its socket alive for a while after
// you've stopped looking at it, which used to make the server think you
// were still "online" and skip the push you actually wanted.
const activeSockets = new Map(); // userId -> Set of socket.id currently active

function isActive(userId) {
  const set = activeSockets.get(userId);
  return !!set && set.size > 0;
}

function setActive(userId, socketId, active) {
  let set = activeSockets.get(userId);
  if (!set) {
    if (!active) return;
    set = new Set();
    activeSockets.set(userId, set);
  }
  if (active) set.add(socketId);
  else set.delete(socketId);
  if (set.size === 0) activeSockets.delete(userId);
}

// Lets a client on a flaky connection safely re-send a message after
// reconnecting without creating a duplicate: if it already got this tempId
// through, we just re-confirm the existing saved message instead of saving
// it again. Bounded so it can't grow forever over a long-running process.
const recentTempIds = new Map(); // tempId -> saved message
const MAX_TEMP_ID_CACHE = 1000;

function rememberTempId(tempId, message) {
  if (!tempId) return;
  recentTempIds.set(tempId, message);
  if (recentTempIds.size > MAX_TEMP_ID_CACHE) {
    recentTempIds.delete(recentTempIds.keys().next().value);
  }
}

// Separate from activeSockets above: this just tracks "is the app open at
// all" (any connected socket), regardless of whether the chat is locked or
// visible. Calls should be able to ring even if the recipient's chat is
// currently locked -- like a phone ringing with the screen off -- so this
// deliberately uses a looser bar than the notification gating does.
const connectedSockets = new Map(); // userId -> Set of socket.id

function isConnected(userId) {
  const set = connectedSockets.get(userId);
  return !!set && set.size > 0;
}

function setConnected(userId, socketId, connected) {
  let set = connectedSockets.get(userId);
  if (!set) {
    if (!connected) return;
    set = new Set();
    connectedSockets.set(userId, set);
  }
  if (connected) set.add(socketId);
  else set.delete(socketId);
  if (set.size === 0) connectedSockets.delete(userId);
}

function notifyOthers(senderId) {
  if (!PUSH_ENABLED) return;
  const otherId = getOtherAccountId(senderId);
  if (otherId && isActive(otherId)) return; // they're actively looking at the chat -- no push needed
  const targets = getPushSubscriptionsForOthers(senderId);
  const body = NOTIFICATION_BODIES[Math.floor(Math.random() * NOTIFICATION_BODIES.length)];
  const payload = JSON.stringify({ title: NOTIFICATION_TITLE, body });

  targets.forEach(({ endpoint, subscription }) => {
    webpush.sendNotification(subscription, payload).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        deletePushSubscriptionByEndpoint(endpoint);
      } else {
        console.error('Push send error:', err.statusCode, err.body);
      }
    });
  });
}

// --- image/video uploads ---
const uploadsDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const ALLOWED_MEDIA_TYPES = /^(image|video|audio)\//;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB -- generous for phone photos/short clips

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname || '').slice(0, 10)),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MEDIA_TYPES.test(file.mimetype)),
});

const app = express();
app.set('trust proxy', 1); // needed so secure cookies work behind Render's proxy
app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    // no maxAge on purpose: this makes it a browser-session cookie, cleared
    // when the browser is fully closed, which is what forces a fresh login.
  },
});
app.use(sessionMiddleware);

// --- brute-force protection for the login/unlock endpoints ---
const attempts = new Map(); // ip -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

function checkRateLimit(ip) {
  const record = attempts.get(ip);
  if (!record) return { locked: false };
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return { locked: true, retryAfterMs: record.lockedUntil - Date.now() };
  }
  return { locked: false };
}

function recordAttempt(ip, success) {
  if (success) {
    attempts.delete(ip);
    return;
  }
  const record = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_MS;
    record.count = 0;
  }
  attempts.set(ip, record);
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still run a comparison of equal length buffers to keep timing consistent
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function findAccountByPassword(password) {
  if (!password) return null;
  for (const account of ACCOUNTS) {
    if (timingSafeEqual(password, account.password)) return account;
  }
  return null;
}

// With exactly 2 accounts, "the other person" is just whichever account isn't you.
function getOtherAccountId(userId) {
  const other = ACCOUNTS.find((a) => a.id !== userId);
  return other ? other.id : null;
}

function handleAuth(req, res) {
  const ip = req.ip;
  const { locked, retryAfterMs } = checkRateLimit(ip);
  if (locked) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again shortly.', retryAfterMs });
  }

  const { password } = req.body || {};
  const account = findAccountByPassword(password);
  recordAttempt(ip, !!account);

  if (!account) {
    return res.status(401).json({ ok: false, error: 'There was a problem signing you in.' });
  }

  req.session.user = account.id;
  req.session.name = account.name;
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
    }
    res.json({ ok: true, name: account.name, id: account.id });
  });
}

// Username field is accepted but intentionally ignored server-side too.
app.post('/api/login', handleAuth);
app.post('/api/unlock', handleAuth);

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireSession(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }
  next();
}

// Lightweight target for an uptime pinger (see README) to hit every few
// minutes so Render's free tier never sees 15 minutes of inactivity and
// spins the service down -- which also wipes the database, since the free
// tier has no persistent disk. Deliberately does no session/DB work.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/api/vapid-public-key', (req, res) => {
  if (!PUSH_ENABLED) return res.status(404).json({ ok: false, error: 'Push notifications are not configured.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push-subscribe', requireSession, (req, res) => {
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ ok: false, error: 'Invalid subscription.' });
  }
  savePushSubscription(req.session.user, subscription);
  res.json({ ok: true });
});

app.post('/api/upload', requireSession, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (25MB max).' : 'Upload failed.';
      return res.status(400).json({ ok: false, error: msg });
    }
    if (err) return res.status(400).json({ ok: false, error: 'Upload failed.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Only images and videos are supported.' });
    res.json({ ok: true, url: '/uploads/' + req.file.filename, mime: req.file.mimetype });
  });
});

// Gated behind login like everything else here, rather than plain static
// serving -- so a stranger who somehow got a URL still can't view it
// without also knowing one of the passwords.
app.get('/uploads/:filename', requireSession, (req, res) => {
  const filename = path.basename(req.params.filename); // strip any path traversal attempt
  const filePath = path.join(uploadsDir, filename);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).end();
  });
});

// Diagnostic only -- lets you check (via curl, no Render dashboard needed)
// whether push is configured, whether a subscription was actually saved for
// each account, and whether the other person currently reads as "active".
app.get('/api/push-debug', requireSession, (req, res) => {
  const otherId = getOtherAccountId(req.session.user);
  res.json({
    pushEnabled: PUSH_ENABLED,
    myUserId: req.session.user,
    mySubscriptionCount: getSubscriptionCountForUser(req.session.user),
    myActive: isActive(req.session.user),
    otherUserId: otherId,
    otherSubscriptionCount: otherId ? getSubscriptionCountForUser(otherId) : 0,
    otherActive: otherId ? isActive(otherId) : null,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const httpServer = createServer(app);
const io = new Server(httpServer);

// Share the Express session with Socket.IO so sockets are only usable by
// someone who has already passed /api/login in this browser.
io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
  const req = socket.request;
  if (!req.session || !req.session.user) {
    socket.disconnect(true);
    return;
  }

  setConnected(req.session.user, socket.id, true);

  // Starts inactive -- the client reports itself active only once the chat
  // is actually shown, unlocked and visible (see the 'presence' handler).
  socket.on('disconnect', () => {
    setActive(req.session.user, socket.id, false);
    setConnected(req.session.user, socket.id, false);
    // If a call was in progress and this was the only connection, the other
    // side needs to know it just dropped rather than ringing/hanging forever.
    socket.broadcast.emit('call:ended');
  });

  socket.on('presence', (payload) => {
    if (!req.session || !req.session.user) return;
    setActive(req.session.user, socket.id, !!(payload && payload.active));
  });

  socket.emit('history', getRecentMessages(req.session.user));

  // Let this client know, right away, how far the other person has already
  // read -- so ticks render correctly on messages loaded from history too.
  const otherId = getOtherAccountId(req.session.user);
  if (otherId) {
    socket.emit('read_receipt', { userId: otherId, upToId: getReadUpToId(otherId) });
  }

  socket.on('typing', () => {
    if (!req.session || !req.session.user) return;
    socket.broadcast.emit('typing', { name: req.session.name });
  });

  socket.on('stop_typing', () => {
    if (!req.session || !req.session.user) return;
    socket.broadcast.emit('stop_typing', { name: req.session.name });
  });

  socket.on('mark_read', (payload) => {
    if (!req.session || !req.session.user) return;
    const upToId = Number(payload && payload.upToId);
    if (!Number.isFinite(upToId)) return;
    const newVal = markReadUpToId(req.session.user, upToId);
    io.emit('read_receipt', { userId: req.session.user, upToId: newVal });
  });

  socket.on('send_message', (payload) => {
    // A client on a flaky connection may re-send the same message (with the
    // same tempId) after reconnecting, if it never got the original
    // confirmation back. If we've already saved that tempId, just re-confirm
    // it to this socket instead of saving a second copy.
    const tempId = typeof payload?.tempId === 'string' ? payload.tempId.slice(0, 64) : null;
    if (tempId && recentTempIds.has(tempId)) {
      socket.emit('chat_message', recentTempIds.get(tempId));
      return;
    }

    const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 2000) : '';

    // Media messages: mediaUrl must point at something this server actually
    // generated via /api/upload (matches our own filename pattern) -- text
    // becomes an optional caption rather than being required.
    let type = 'text';
    let mediaPath = null;
    let mediaMime = null;
    if (typeof payload?.mediaUrl === 'string') {
      const m = payload.mediaUrl.match(/^\/uploads\/([a-f0-9-]{36}\.[A-Za-z0-9]{1,10})$/);
      if (m) {
        type = ['video', 'audio'].includes(payload.type) ? payload.type : 'image';
        mediaPath = m[1];
        mediaMime = typeof payload.mediaMime === 'string' ? payload.mediaMime.slice(0, 100) : null;
      }
    }

    if (!text && !mediaPath) return; // nothing to actually send

    // The quoted snippet is just a small trusted-client snapshot (same trust
    // level as the rest of this 2-person app) -- not re-validated against
    // the original message.
    let replyTo = null;
    if (payload?.replyTo && typeof payload.replyTo === 'object') {
      const rid = Number(payload.replyTo.id);
      if (Number.isFinite(rid)) {
        replyTo = {
          id: rid,
          sender: typeof payload.replyTo.sender === 'string' ? payload.replyTo.sender.slice(0, 100) : '',
          text: typeof payload.replyTo.text === 'string' ? payload.replyTo.text.slice(0, 200) : '',
          type: typeof payload.replyTo.type === 'string' ? payload.replyTo.type.slice(0, 20) : 'text',
        };
      }
    }

    // Re-check the session on every message in case it expired mid-connection.
    if (!req.session || !req.session.user) {
      socket.disconnect(true);
      return;
    }
    const message = saveMessage(req.session.name, text, Date.now(), { type, mediaPath, mediaMime }, replyTo);
    message.tempId = tempId; // only meaningful to the sender, harmless for the other side to receive
    rememberTempId(tempId, message);
    io.emit('chat_message', message);
    notifyOthers(req.session.user);
  });

  // --- video/audio call signaling -- the server only relays small setup
  // messages between the two peers; actual call audio/video flows directly
  // between the two browsers (WebRTC), never through this server. ---
  socket.on('call:invite', (payload) => {
    if (!req.session || !req.session.user) return;
    const callType = payload && payload.callType === 'audio' ? 'audio' : 'video';
    const otherId = getOtherAccountId(req.session.user);
    if (!otherId || !isConnected(otherId)) {
      socket.emit('call:unavailable');
      return;
    }
    socket.broadcast.emit('call:incoming', { from: req.session.name, callType });
  });

  socket.on('call:accept', () => {
    if (!req.session || !req.session.user) return;
    socket.broadcast.emit('call:accepted');
  });

  socket.on('call:decline', () => {
    if (!req.session || !req.session.user) return;
    socket.broadcast.emit('call:declined');
  });

  socket.on('call:end', () => {
    if (!req.session || !req.session.user) return;
    socket.broadcast.emit('call:ended');
  });

  // SDP offers/answers and ICE candidates -- passed through untouched.
  socket.on('call:signal', (payload) => {
    if (!req.session || !req.session.user) return;
    socket.broadcast.emit('call:signal', payload);
  });

  // Lets the other person's UI show "camera off" instead of a frozen frame.
  socket.on('call:camera', (payload) => {
    if (!req.session || !req.session.user) return;
    socket.broadcast.emit('call:camera', { on: !!(payload && payload.on) });
  });

  // "Clear chat" only affects the person who clicked it: it never deletes
  // messages, just moves this user's own cutoff forward. The other person's
  // history (and future logins of theirs) is completely untouched.
  socket.on('clear_chat', () => {
    if (!req.session || !req.session.user) {
      socket.disconnect(true);
      return;
    }
    clearChatForUser(req.session.user);
    socket.emit('history', []);
  });

  // "Delete for everyone" only works on a message you actually sent -- it
  // replaces the stored content with an empty "deleted" placeholder for
  // both of you. "Delete for me" never touches the message at all; it just
  // hides that one id from your own future history, like a single-message
  // version of "clear chat".
  socket.on('delete_message', (payload) => {
    if (!req.session || !req.session.user) {
      socket.disconnect(true);
      return;
    }
    const id = Number(payload && payload.id);
    if (!Number.isFinite(id)) return;
    const forEveryone = !!(payload && payload.forEveryone);

    if (forEveryone) {
      const existing = getMessageById(id);
      if (!existing || existing.sender !== req.session.name) return; // not yours -- ignore
      deleteMessageForEveryone(id);
      io.emit('message_deleted', { id, forEveryone: true });
    } else {
      deleteMessageForUser(req.session.user, id);
      socket.emit('message_deleted', { id, forEveryone: false });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
