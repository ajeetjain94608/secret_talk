(function () {
  'use strict';

  // ---------- decoy product grid (static filler content) ----------
  const PRODUCTS = [
    { emoji: '🎧', bg: '#fde2e2', title: 'Wireless Over-Ear Headphones', price: '₹1,299', stars: '★★★★☆' },
    { emoji: '☕', bg: '#fdf3e2', title: 'Insulated Travel Mug, 16oz', price: '₹399', stars: '★★★★★' },
    { emoji: '🧴', bg: '#e2f0fd', title: 'Everyday Moisturizer, 2-pack', price: '₹349', stars: '★★★★☆' },
    { emoji: '📓', bg: '#e6fde2', title: 'Hardcover Notebook, 3-pack', price: '₹249', stars: '★★★★☆' },
    { emoji: '🔌', bg: '#f0e2fd', title: 'Compact USB-C Charger', price: '₹599', stars: '★★★★☆' },
    { emoji: '🧦', bg: '#e2fdf7', title: 'Cotton Crew Socks, 6-pack', price: '₹399', stars: '★★★★★' },
    { emoji: '🎒', bg: '#fde2f0', title: 'Everyday Backpack, 20L', price: '₹899', stars: '★★★★☆' },
    { emoji: '💡', bg: '#eafde2', title: 'Dimmable LED Desk Lamp', price: '₹699', stars: '★★★★☆' },
  ];

  function renderProducts() {
    const grid = document.getElementById('product-grid');
    grid.innerHTML = PRODUCTS.map((p) => `
      <div class="product-card">
        <div class="product-thumb" style="background:${p.bg}">${p.emoji}</div>
        <p class="product-title">${p.title}</p>
        <div class="product-stars">${p.stars}</div>
        <div class="product-price">${p.price}</div>
        <button class="add-cart-btn" type="button">Add to Cart</button>
      </div>
    `).join('');
  }

  // ---------- view management ----------
  const views = {
    storefront: document.getElementById('view-storefront'),
    signin: document.getElementById('view-signin'),
    chat: document.getElementById('view-chat'),
  };

  function showView(name) {
    Object.keys(views).forEach((key) => {
      views[key].classList.toggle('hidden', key !== name);
    });
    state.currentView = name;
    document.body.classList.toggle('chat-active', name === 'chat');
  }

  const state = {
    currentView: 'storefront',
    everSignedIn: false, // becomes true after the first successful login
    locked: false, // true once we've re-shown sign-in on top of an open chat
    myName: null,
    myUserId: null,
    otherReadUpToId: 0, // highest message id the OTHER person has seen
    lastReadIdSent: 0, // dedupe so we don't spam mark_read
    socket: null,
    replyingTo: null, // {id, sender, text, type} snapshot of the message the next send will quote
  };

  // Messages/uploads that haven't been confirmed by the server yet, keyed by
  // a client-generated tempId. Nothing here is ever silently dropped on a
  // bad connection -- it stays visible (as a clock ⏱) and gets retried the
  // moment the connection comes back, same as WhatsApp.
  const pendingOutbox = new Map(); // tempId -> { text, mediaUrl, mediaMime, type }

  function makeTempId() {
    return 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  }

  document.querySelectorAll('[data-action="home"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (state.currentView !== 'chat') showView('storefront');
    });
  });
  document.querySelectorAll('[data-action="noop"]').forEach((el) => {
    el.addEventListener('click', (e) => e.preventDefault());
  });
  document.querySelectorAll('[data-action="signin"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openSignIn();
    });
  });

  function openSignIn() {
    hideSigninError();
    document.getElementById('signin-password').value = '';
    showView('signin');
    setTimeout(() => document.getElementById('signin-password').focus(), 0);
  }

  function showSigninError(message) {
    document.getElementById('signin-error-text').textContent = message || 'Enter your password again.';
    document.getElementById('signin-error').classList.remove('hidden');
  }
  function hideSigninError() {
    document.getElementById('signin-error').classList.add('hidden');
  }

  // ---------- sign-in / unlock submit ----------
  document.getElementById('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('signin-password').value;
    const endpoint = state.everSignedIn ? '/api/unlock' : '/api/login';

    let res, data;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      data = await res.json();
    } catch (err) {
      showSigninError('Something went wrong. Please try again.');
      return;
    }

    if (!res.ok || !data.ok) {
      showSigninError(data && data.error);
      document.getElementById('signin-password').value = '';
      document.getElementById('signin-password').focus();
      return;
    }

    hideSigninError();
    state.myName = data.name;
    state.myUserId = data.id;
    state.everSignedIn = true;
    state.locked = false;
    document.getElementById('signin-password').value = '';

    if (!state.socket) connectSocket();
    showView('chat');
    setTimeout(() => document.getElementById('chat-input').focus(), 0);
    setupPushNotifications();
    markReadIfVisible();
    if (state.socket) state.socket.emit('presence', { active: true });
  });

  // ---------- lock on minimize / tab switch ----------
  // Deliberately NOT using window "blur" here: native browser popups (the
  // "Save password?" prompt, the notification-permission prompt, autofill
  // dropdowns, etc.) steal window focus too, which fired blur and caused a
  // false lock right after signing in. visibilitychange only goes true when
  // the tab/window is actually hidden (minimized, switched away, screen
  // locked), so it doesn't trigger on those in-page popups.
  function lockIfNeeded() {
    if (state.currentView === 'chat' && !state.locked) {
      state.locked = true;
      stopTyping();
      openSignIn();
      // As soon as we're locked, we're no longer "active" -- the server
      // should push-notify us for anything that arrives from here on,
      // even though the socket itself may well stay connected in the
      // background for a while longer.
      if (state.socket) state.socket.emit('presence', { active: false });
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    lockIfNeeded();
    // A call must be cut the instant the tab/browser is hidden -- no
    // hanging floating window left running in the background. This is
    // deliberately unconditional on the chat-lock state above: an incoming
    // call can ring and connect even while you're still on the storefront
    // or sign-in screen (by design, so it isn't hidden by the disguise), so
    // gating this on "chat view is locked" would miss that case entirely.
    if (callState.status !== 'idle') endCall();
  });

  // "Clear chat" only wipes this device/person's own view -- it never
  // touches what the other person sees, and it's not reversible for you.
  document.getElementById('chat-clear-btn').addEventListener('click', () => {
    if (!state.socket) return;
    const confirmed = window.confirm(
      'Clear chat for you?\n\nThis only clears your own view — your friend will still see the full history.'
    );
    if (!confirmed) return;
    state.socket.emit('clear_chat');
  });

  // ---------- socket / chat ----------
  function connectSocket() {
    state.socket = io({
      // Keep retrying indefinitely on a bad connection instead of giving up
      // after a handful of attempts -- exactly the "very slow/flaky network"
      // case this is meant to survive.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    state.socket.on('connect', () => {
      setConnBanner('hidden');
      // Anything still sitting in the outbox never actually got confirmed --
      // safe to just re-send; the server recognizes the tempId and won't
      // create a duplicate even if the original secretly did get through.
      pendingOutbox.forEach((payload, tempId) => state.socket.emit('send_message', { ...payload, tempId }));
    });
    state.socket.on('disconnect', () => setConnBanner('offline'));
    state.socket.io.on('reconnect_attempt', () => setConnBanner('connecting'));

    state.socket.on('history', (messages) => {
      const container = document.getElementById('chat-messages');
      container.innerHTML = '';
      lastRenderedDateKey = null; // fresh render -- re-insert date separators from scratch
      messages.forEach((m) => appendMessage(m, { fromHistory: true }));
      scrollMessagesToEnd();
      updateJumpToLatestVisibility();
      markReadIfVisible();
    });
    state.socket.on('chat_message', (m) => {
      // If this is the server's confirmation of one of OUR OWN pending
      // sends, update that exact bubble in place instead of adding a new
      // one -- the clock becomes a real tick right where it already was.
      if (m.tempId && pendingOutbox.has(m.tempId)) {
        resolvePendingMessage(m.tempId, m);
        return;
      }
      const wasNearBottom = isNearBottom();
      appendMessage(m);
      if (wasNearBottom) {
        scrollMessagesToEnd();
      } else if (m.sender !== state.myName) {
        bumpUnreadBadge();
      }
      markReadIfVisible();
    });
    state.socket.on('read_receipt', ({ userId, upToId }) => {
      // Only the OTHER person's read position affects ticks on my messages.
      if (userId === state.myUserId) return;
      state.otherReadUpToId = Math.max(state.otherReadUpToId, upToId || 0);
      updateTicks();
    });
    state.socket.on('typing', ({ name }) => showTypingIndicator(name));
    state.socket.on('stop_typing', () => hideTypingIndicator());
    state.socket.on('message_deleted', handleMessageDeleted);
    wireCallSocketEvents();
  }

  // ---------- date separators ----------
  let lastRenderedDateKey = null;

  function getDateKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function formatDateLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (getDateKey(ts) === getDateKey(today.getTime())) return 'Today';
    if (getDateKey(ts) === getDateKey(yesterday.getTime())) return 'Yesterday';
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString([], sameYear ? { month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric', year: 'numeric' });
  }
  function maybeInsertDateSeparator(container, ts) {
    const key = getDateKey(ts);
    if (key === lastRenderedDateKey) return;
    lastRenderedDateKey = key;
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.textContent = formatDateLabel(ts);
    container.appendChild(sep);
  }

  function appendMessage(m) {
    const container = document.getElementById('chat-messages');
    maybeInsertDateSeparator(container, m.ts);
    const isMine = m.sender === state.myName;
    const div = document.createElement('div');
    div.className = 'msg' + (isMine ? ' msg-mine' : '');
    if (m.id != null) div.dataset.id = m.id;
    if (m.tempId) div.dataset.tempid = m.tempId;

    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    sender.textContent = m.sender;

    let quote = null;
    if (m.replyTo) {
      quote = document.createElement('div');
      quote.className = 'msg-reply-quote';
      const accent = document.createElement('div');
      accent.className = 'msg-reply-quote-accent';
      const body = document.createElement('div');
      body.className = 'msg-reply-quote-body';
      const qSender = document.createElement('div');
      qSender.className = 'msg-reply-quote-sender';
      qSender.textContent = m.replyTo.sender;
      const qText = document.createElement('div');
      qText.className = 'msg-reply-quote-text';
      qText.textContent = m.replyTo.text;
      body.appendChild(qSender);
      body.appendChild(qText);
      quote.appendChild(accent);
      quote.appendChild(body);
      quote.addEventListener('click', () => scrollToMessage(m.replyTo.id));
    }

    if (m.mediaUrl) {
      const wrap = document.createElement('div');
      wrap.className = 'msg-media-wrap';
      let media;
      if (m.type === 'video') {
        media = document.createElement('video');
        media.controls = true;
        media.playsInline = true;
      } else if (m.type === 'audio') {
        media = document.createElement('audio');
        media.controls = true;
      } else {
        media = document.createElement('img');
        media.loading = 'lazy';
        // Opens in-page, not a new tab -- a new tab hides this one, which
        // used to trigger the auto-lock as if you'd switched away.
        media.addEventListener('click', () => {
          if (!div.classList.contains('msg-uploading') && !div.classList.contains('msg-failed')) openLightbox(media.src);
        });
      }
      media.className = 'msg-media';
      media.src = m.mediaUrl;
      wrap.appendChild(media);

      // Never just hides while uploading -- the local preview shows
      // immediately, with a visible progress overlay on top of it.
      if (m.uploading) {
        div.classList.add('msg-uploading');
        wrap.appendChild(buildUploadOverlay());
      }
      div.appendChild(wrap);
    }

    if (m.type === 'deleted') div.classList.add('msg-deleted');

    const text = document.createElement('div');
    text.className = 'msg-text';
    // textContent only -- never render message text as HTML
    text.textContent = m.type === 'deleted' ? 'This message was deleted' : m.text;
    if (!m.text && m.type !== 'deleted') text.classList.add('hidden'); // media-only message, no caption to show

    const foot = document.createElement('div');
    foot.className = 'msg-foot';
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = new Date(m.ts).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    foot.appendChild(time);
    if (isMine) {
      const ticks = document.createElement('span');
      ticks.className = 'msg-ticks';
      setTickState(ticks, m.pending ? 'pending' : 'sent');
      foot.appendChild(ticks);
    }

    div.appendChild(sender);
    if (quote) div.appendChild(quote);
    div.appendChild(text);
    div.appendChild(foot);

    // Reply/delete only make sense once the message has a real, confirmed id
    // -- and there's nothing left to reply to or delete on an already-deleted
    // one. WhatsApp-style: swipe right to reply, press-and-hold to select and
    // get a Reply/Delete menu -- no persistent buttons cluttering every message.
    if (m.id != null && !m.pending && m.type !== 'deleted') {
      const hint = document.createElement('div');
      hint.className = 'msg-swipe-hint';
      hint.textContent = '↩';
      div.appendChild(hint);
      attachMessageGestures(div, m, hint);
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    if (isMine && !m.pending) updateTicksFor(div, m.id);
    return div;
  }

  // ---------- reply / quote ----------
  function replyPreviewText(m) {
    if (m.type === 'image') return '📷 Photo';
    if (m.type === 'video') return '🎥 Video';
    if (m.type === 'audio') return '🎤 Voice note';
    return (m.text || '').slice(0, 120);
  }

  function startReply(m) {
    state.replyingTo = { id: m.id, sender: m.sender, text: replyPreviewText(m), type: m.type || 'text' };
    document.getElementById('reply-preview-sender').textContent = m.sender;
    document.getElementById('reply-preview-text').textContent = state.replyingTo.text;
    document.getElementById('reply-preview-bar').classList.remove('hidden');
    document.getElementById('chat-input').focus();
  }

  function cancelReply() {
    state.replyingTo = null;
    document.getElementById('reply-preview-bar').classList.add('hidden');
  }
  document.getElementById('reply-preview-cancel').addEventListener('click', cancelReply);

  function scrollToMessage(id) {
    const target = document.querySelector(`#chat-messages [data-id="${id}"]`);
    if (!target) return; // not in the currently loaded history -- nothing to jump to
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('highlight');
    setTimeout(() => target.classList.remove('highlight'), 1500);
  }

  // ---------- delete / unsend ----------
  // Opened by a long-press (see attachMessageGestures below), not a
  // persistent button -- offers Reply plus the two delete options.
  let actionTargetMsg = null;
  let actionTargetEl = null;

  function openMsgActionSheet(m, el) {
    actionTargetMsg = m;
    actionTargetEl = el;
    el.classList.add('msg-selected');
    // "Delete for everyone" only ever shows for your own messages -- you
    // can't unsend something the other person sent.
    document.getElementById('msg-action-delete-everyone-btn').classList.toggle('hidden', m.sender !== state.myName);
    document.getElementById('msg-action-sheet').classList.remove('hidden');
  }
  function closeMsgActionSheet() {
    if (actionTargetEl) actionTargetEl.classList.remove('msg-selected');
    actionTargetMsg = null;
    actionTargetEl = null;
    document.getElementById('msg-action-sheet').classList.add('hidden');
  }

  document.getElementById('msg-action-cancel-btn').addEventListener('click', closeMsgActionSheet);
  document.getElementById('msg-action-sheet').addEventListener('click', (e) => {
    if (e.target.id === 'msg-action-sheet') closeMsgActionSheet(); // tap the backdrop
  });
  document.getElementById('msg-action-reply-btn').addEventListener('click', () => {
    if (actionTargetMsg) startReply(actionTargetMsg);
    closeMsgActionSheet();
  });
  document.getElementById('msg-action-delete-everyone-btn').addEventListener('click', () => {
    if (actionTargetMsg && state.socket) state.socket.emit('delete_message', { id: actionTargetMsg.id, forEveryone: true });
    closeMsgActionSheet();
  });
  document.getElementById('msg-action-delete-me-btn').addEventListener('click', () => {
    if (actionTargetMsg && state.socket) state.socket.emit('delete_message', { id: actionTargetMsg.id, forEveryone: false });
    closeMsgActionSheet();
  });

  // ---------- swipe-to-reply / press-and-hold-to-select gestures ----------
  // One Pointer Events handler covers touch AND mouse identically. Distinct
  // from a tap: hold still past LONG_PRESS_MS -> opens the action sheet;
  // drag right past SWIPE_THRESHOLD -> replies directly. A small early
  // deadzone lets a normal vertical scroll pass through untouched instead of
  // being hijacked as a swipe.
  const LONG_PRESS_MS = 450;
  const SWIPE_THRESHOLD = 56;
  const MOVE_DEADZONE = 10;
  const SWIPE_MAX = 80;

  function attachMessageGestures(div, m, hint) {
    let startX = 0;
    let startY = 0;
    let dragging = false; // confirmed horizontal swipe in progress
    let longPressTimer = null;
    let pointerId = null;

    function clearLongPress() {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    function resetPosition() {
      div.style.transform = '';
      hint.style.opacity = '0';
    }

    div.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return; // left click / primary touch only
      if (document.getElementById('msg-action-sheet').classList.contains('hidden') === false) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
      div.classList.add('msg-pressed');
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        div.classList.remove('msg-pressed');
        resetPosition();
        if (navigator.vibrate) navigator.vibrate(15); // subtle haptic where supported; harmless no-op elsewhere
        openMsgActionSheet(m, div);
      }, LONG_PRESS_MS);
    });

    div.addEventListener('pointermove', (e) => {
      if (pointerId !== e.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!dragging) {
        if (Math.abs(dx) < MOVE_DEADZONE && Math.abs(dy) < MOVE_DEADZONE) return; // still within the deadzone
        // A real, clear movement -- this is not a long-press anymore.
        clearLongPress();
        div.classList.remove('msg-pressed');
        if (Math.abs(dy) > Math.abs(dx)) return; // vertical scroll -- let the page handle it, not us
        dragging = true;
        div.setPointerCapture(pointerId);
      }

      if (dx <= 0) {
        resetPosition();
        return;
      }
      const clamped = Math.min(dx, SWIPE_MAX);
      div.style.transform = `translateX(${clamped}px)`;
      hint.style.opacity = String(Math.min(1, clamped / SWIPE_THRESHOLD));
    });

    function endGesture(e) {
      if (pointerId !== e.pointerId) return;
      clearLongPress();
      div.classList.remove('msg-pressed');
      if (dragging) {
        const dx = e.clientX - startX;
        if (dx >= SWIPE_THRESHOLD) startReply(m);
      }
      dragging = false;
      pointerId = null;
      resetPosition();
    }
    div.addEventListener('pointerup', endGesture);
    div.addEventListener('pointercancel', endGesture);
    div.addEventListener('contextmenu', (e) => e.preventDefault()); // no native right-click/long-press menu
  }

  // Server confirms every delete back to whoever it actually affects:
  // "for everyone" goes to both of you and turns the bubble into a
  // placeholder in place; "for me" comes back only to the requester and
  // just removes the bubble from this one view entirely.
  function handleMessageDeleted({ id, forEveryone }) {
    const div = document.querySelector(`#chat-messages [data-id="${id}"]`);
    if (!div) return;
    if (forEveryone) {
      div.classList.add('msg-deleted');
      div.querySelectorAll('.msg-media-wrap, .msg-reply-quote, .msg-swipe-hint').forEach((el) => el.remove());
      const textEl = div.querySelector('.msg-text');
      if (textEl) {
        textEl.textContent = 'This message was deleted';
        textEl.classList.remove('hidden');
      }
    } else {
      div.remove();
    }
  }

  function buildUploadOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'msg-upload-overlay';
    const spinner = document.createElement('div');
    spinner.className = 'msg-upload-spinner';
    const label = document.createElement('div');
    label.className = 'msg-upload-label';
    label.textContent = 'Uploading…';
    overlay.appendChild(spinner);
    overlay.appendChild(label);
    return overlay;
  }

  // clock (waiting for network) vs. sent/read double-tick.
  function setTickState(ticks, kind) {
    if (kind === 'pending') {
      ticks.textContent = '🕐';
      ticks.classList.add('pending');
    } else {
      ticks.textContent = '✓✓';
      ticks.classList.remove('pending');
    }
  }

  // Recolors the tick marks on every one of my messages based on how far
  // the other person has read.
  function updateTicks() {
    document.querySelectorAll('#chat-messages .msg-mine[data-id]').forEach((div) => {
      updateTicksFor(div, Number(div.dataset.id));
    });
  }
  function updateTicksFor(div, id) {
    const ticks = div.querySelector('.msg-ticks');
    if (!ticks || id == null || ticks.classList.contains('pending')) return;
    ticks.classList.toggle('seen', id <= state.otherReadUpToId);
  }

  // The server has now genuinely saved one of our own pending sends --
  // update that exact bubble in place (clock -> real tick) rather than
  // adding a second copy of the message.
  function resolvePendingMessage(tempId, serverMsg) {
    pendingOutbox.delete(tempId);
    const div = document.querySelector(`#chat-messages [data-tempid="${tempId}"]`);
    if (!div) {
      appendMessage(serverMsg);
      markReadIfVisible();
      return;
    }
    div.dataset.id = serverMsg.id;
    div.classList.remove('msg-uploading', 'msg-failed');
    const overlay = div.querySelector('.msg-upload-overlay');
    if (overlay) overlay.remove();
    const ticks = div.querySelector('.msg-ticks');
    if (ticks) setTickState(ticks, 'sent');
    updateTicksFor(div, serverMsg.id);

    // Swipe/long-press only got skipped while this was still pending (no
    // real id yet) -- now that it's confirmed, wire them up just like any
    // other message, instead of only ever getting them after a reload.
    if (!div.querySelector('.msg-swipe-hint')) {
      const hint = document.createElement('div');
      hint.className = 'msg-swipe-hint';
      hint.textContent = '↩';
      div.appendChild(hint);
      attachMessageGestures(div, serverMsg, hint);
    }

    markReadIfVisible();
  }

  // ---------- connection status banner ----------
  function setConnBanner(mode) {
    const el = document.getElementById('conn-banner');
    if (mode === 'hidden') {
      el.classList.add('hidden');
      el.className = 'conn-banner hidden';
      return;
    }
    el.classList.remove('hidden');
    el.className = 'conn-banner ' + mode;
    el.textContent = mode === 'offline'
      ? 'No connection — your messages will send once it’s back'
      : 'Connecting…';
  }

  // ---------- full-size image viewer (in-page, never a new tab) ----------
  function openLightbox(url) {
    document.getElementById('media-lightbox-img').src = url;
    document.getElementById('media-lightbox').classList.remove('hidden');
  }
  function closeLightbox() {
    document.getElementById('media-lightbox').classList.add('hidden');
    document.getElementById('media-lightbox-img').src = '';
  }
  document.getElementById('media-lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('media-lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'media-lightbox') closeLightbox(); // tap the dark backdrop, not the image itself
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });

  // Tells the server "I've seen everything up to here" -- but only while
  // the chat is genuinely in front of the user (unlocked and visible).
  function markReadIfVisible() {
    if (state.currentView !== 'chat' || state.locked || document.hidden) return;
    if (!state.socket) return;
    const container = document.getElementById('chat-messages');
    const last = container.lastElementChild;
    const lastId = last ? Number(last.dataset.id) : null;
    if (lastId == null || Number.isNaN(lastId) || lastId <= state.lastReadIdSent) return;
    state.lastReadIdSent = lastId;
    state.socket.emit('mark_read', { upToId: lastId });
  }

  // Tapping the Send button would otherwise steal focus from the text
  // input, which is exactly what closes the on-screen keyboard after every
  // message. Preventing the button's default mousedown behavior stops it
  // from ever taking focus in the first place. (Deliberately NOT doing the
  // same for touchstart -- that also suppresses the synthetic click event
  // mobile browsers fire afterward, which broke the button entirely.)
  document.getElementById('chat-send-btn').addEventListener('mousedown', (e) => e.preventDefault());

  // ---------- image / video attachments ----------
  document.getElementById('chat-attach-btn').addEventListener('click', () => {
    document.getElementById('chat-file-input').click();
  });

  document.getElementById('chat-file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow picking the same file again later
    if (!file || !state.socket) return;

    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      window.alert('Only photos and videos can be sent.');
      return;
    }
    sendMediaMessage(file);
  });

  function mediaKind(file) {
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return 'image';
  }

  // Shows the picked file immediately (from the file itself, no network
  // needed) with a real upload-progress overlay -- never just hidden until
  // it's done. Once uploaded, it becomes a normal pending (clock) send that
  // resolves the same way a text message does. filename is only needed for
  // a recorded voice note (a Blob, not a File, so it has no name of its own).
  // replyTo is only omitted on a fresh send (reads the current reply
  // context then); a retry after a failed upload always passes it explicitly
  // so the original reply isn't lost or swapped for whatever's pending now.
  function sendMediaMessage(file, filename, replyTo) {
    if (replyTo === undefined) replyTo = state.replyingTo;
    const kind = mediaKind(file);
    const tempId = makeTempId();
    const localUrl = URL.createObjectURL(file);
    const div = appendMessage({
      tempId, sender: state.myName, ts: Date.now(), text: '',
      type: kind, mediaUrl: localUrl, uploading: true, pending: true, replyTo,
    });
    cancelReply(); // reply context applies to just this one send, like WhatsApp

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const label = div.querySelector('.msg-upload-label');
      if (label) label.textContent = `Uploading… ${Math.round((e.loaded / e.total) * 100)}%`;
    });
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (err) { /* leave data null */ }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
        URL.revokeObjectURL(localUrl);
        const mediaEl = div.querySelector('.msg-media');
        if (mediaEl) mediaEl.src = data.url;
        div.classList.remove('msg-uploading');
        const overlay = div.querySelector('.msg-upload-overlay');
        if (overlay) overlay.remove();

        const payload = replyTo
          ? { type: kind, mediaUrl: data.url, mediaMime: data.mime, replyTo }
          : { type: kind, mediaUrl: data.url, mediaMime: data.mime };
        pendingOutbox.set(tempId, payload);
        if (state.socket && state.socket.connected) {
          state.socket.emit('send_message', { ...payload, tempId });
        }
      } else {
        markUploadFailed(div, tempId, file, (data && data.error) || 'Upload failed.', filename, replyTo);
      }
    };
    xhr.onerror = () => markUploadFailed(div, tempId, file, 'Upload failed. Check your connection.', filename, replyTo);
    const formData = new FormData();
    formData.append('file', file, filename || undefined);
    xhr.send(formData);
  }

  function markUploadFailed(div, tempId, file, message, filename, replyTo) {
    pendingOutbox.delete(tempId);
    div.classList.remove('msg-uploading');
    div.classList.add('msg-failed');
    const overlay = div.querySelector('.msg-upload-overlay');
    if (overlay) {
      overlay.innerHTML = '';
      const label = document.createElement('div');
      label.className = 'msg-upload-label';
      label.textContent = '⚠ ' + message + ' Tap to retry.';
      overlay.appendChild(label);
      const retry = () => {
        div.remove();
        sendMediaMessage(file, filename, replyTo || null);
      };
      overlay.onclick = retry;
      // Also retries on its own the moment the browser notices it's back
      // online, so a dropped connection doesn't need to be noticed by hand.
      window.addEventListener('online', retry, { once: true });
    }
  }

  // ---------- voice notes ----------
  let mediaRecorder = null;
  let recordingStream = null;
  let recordedChunks = [];
  let recordingStartTime = 0;
  let recordingTimer = null;

  function pickAudioMimeType() {
    if (!window.MediaRecorder) return '';
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  document.getElementById('chat-mic-btn').addEventListener('click', startRecording);
  document.getElementById('recording-cancel-btn').addEventListener('click', cancelRecording);
  document.getElementById('recording-send-btn').addEventListener('click', stopAndSendRecording);

  async function startRecording() {
    if (mediaRecorder) return; // already recording
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      window.alert("Voice notes aren't supported in this browser.");
      return;
    }
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      window.alert('Could not access the microphone.\n\n' + describeMediaError(err));
      return;
    }
    const mimeType = pickAudioMimeType();
    mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    recordedChunks = [];
    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    });
    mediaRecorder.start();
    recordingStartTime = Date.now();
    document.getElementById('chat-form').classList.add('hidden');
    document.getElementById('recording-bar').classList.remove('hidden');
    updateRecordingTimer();
    recordingTimer = setInterval(updateRecordingTimer, 200);
  }

  function updateRecordingTimer() {
    const secs = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mm = Math.floor(secs / 60);
    const ss = String(secs % 60).padStart(2, '0');
    document.getElementById('recording-timer').textContent = `${mm}:${ss}`;
  }

  function stopRecordingStream() {
    if (recordingStream) {
      recordingStream.getTracks().forEach((t) => t.stop());
      recordingStream = null;
    }
  }

  function hideRecordingUI() {
    document.getElementById('chat-form').classList.remove('hidden');
    document.getElementById('recording-bar').classList.add('hidden');
    clearInterval(recordingTimer);
    recordingTimer = null;
  }

  function cancelRecording() {
    if (!mediaRecorder) return;
    mediaRecorder.stop();
    stopRecordingStream();
    mediaRecorder = null;
    recordedChunks = [];
    hideRecordingUI();
  }

  function stopAndSendRecording() {
    if (!mediaRecorder) return;
    const mimeType = mediaRecorder.mimeType || 'audio/webm';
    mediaRecorder.addEventListener('stop', () => {
      stopRecordingStream();
      const blob = new Blob(recordedChunks, { type: mimeType });
      recordedChunks = [];
      mediaRecorder = null;
      hideRecordingUI();
      if (blob.size === 0) return; // nothing was actually recorded
      const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
      sendMediaMessage(blob, `voice-note.${ext}`);
    }, { once: true });
    mediaRecorder.stop();
  }

  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !state.socket) return;
    sendTextMessage(text);
    stopTyping();
    input.value = '';
    updateSendMicToggle();
    input.focus(); // belt-and-suspenders: keep the keyboard open even if focus slipped anyway
  });

  // Shows the message right away with a clock ⏱ tick -- never hidden while
  // waiting on a slow/dropped connection -- and only switches to a real
  // sent/read tick once the server actually confirms it. If the socket is
  // disconnected right now, it just stays pending and goes out automatically
  // the moment 'connect' fires again (see connectSocket above).
  function sendTextMessage(text) {
    const tempId = makeTempId();
    const replyTo = state.replyingTo;
    const payload = replyTo ? { text, replyTo } : { text };
    appendMessage({
      tempId, sender: state.myName, ts: Date.now(), text, type: 'text', mediaUrl: null, pending: true, replyTo,
    });
    pendingOutbox.set(tempId, payload);
    cancelReply(); // reply context applies to just this one send, like WhatsApp
    if (state.socket && state.socket.connected) {
      state.socket.emit('send_message', { ...payload, tempId });
    }
  }

  function scrollMessagesToEnd() {
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
    updateJumpToLatestVisibility();
  }

  // ---------- jump-to-latest button ----------
  const NEAR_BOTTOM_PX = 150;
  let unreadWhileScrolledUp = 0;

  function isNearBottom() {
    const container = document.getElementById('chat-messages');
    return container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
  }

  function updateJumpToLatestVisibility() {
    const nearBottom = isNearBottom();
    document.getElementById('jump-to-latest-btn').classList.toggle('hidden', nearBottom);
    if (nearBottom) clearUnreadBadge();
  }

  function bumpUnreadBadge() {
    unreadWhileScrolledUp += 1;
    const badge = document.getElementById('jump-to-latest-badge');
    badge.textContent = unreadWhileScrolledUp > 9 ? '9+' : String(unreadWhileScrolledUp);
    badge.classList.remove('hidden');
  }
  function clearUnreadBadge() {
    unreadWhileScrolledUp = 0;
    document.getElementById('jump-to-latest-badge').classList.add('hidden');
  }

  document.getElementById('chat-messages').addEventListener('scroll', updateJumpToLatestVisibility);
  document.getElementById('jump-to-latest-btn').addEventListener('click', () => {
    const container = document.getElementById('chat-messages');
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    clearUnreadBadge();
  });

  // Opening the keyboard (tapping the input) should jump straight to the
  // latest message, not leave you wherever you'd scrolled to.
  document.getElementById('chat-input').addEventListener('focus', () => {
    scrollMessagesToEnd();
    // The keyboard's opening animation can still be resizing the visible
    // area a moment later, so re-settle once that finishes too.
    setTimeout(scrollMessagesToEnd, 300);
  });

  // ---------- typing indicator ----------
  let typingActive = false;
  let typingStopTimer = null;

  // Mic button shows while the box is empty; Send takes its place the
  // moment there's something to send (WhatsApp's mic-becomes-send pattern).
  function updateSendMicToggle() {
    const hasText = document.getElementById('chat-input').value.trim() !== '';
    document.getElementById('chat-mic-btn').classList.toggle('hidden', hasText);
    document.getElementById('chat-send-btn').classList.toggle('hidden', !hasText);
  }

  document.getElementById('chat-input').addEventListener('input', (e) => {
    updateSendMicToggle();
    if (!state.socket) return;
    const value = e.target.value;
    if (value.trim() === '') {
      stopTyping();
      return;
    }
    typingActive = true;
    state.socket.emit('typing');
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTyping, 2000);
  });

  function stopTyping() {
    if (typingActive && state.socket) state.socket.emit('stop_typing');
    typingActive = false;
    clearTimeout(typingStopTimer);
  }

  let typingHideTimer = null;
  function showTypingIndicator(name) {
    const el = document.getElementById('typing-indicator');
    document.getElementById('typing-indicator-text').textContent = `${name} is typing`;
    el.classList.remove('hidden');
    // Safety auto-hide in case a stop_typing event never arrives (e.g. the
    // other person's tab closed mid-type).
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(hideTypingIndicator, 4000);
  }
  function hideTypingIndicator() {
    clearTimeout(typingHideTimer);
    document.getElementById('typing-indicator').classList.add('hidden');
  }

  // ---------- push notifications (survive the browser being fully closed) ----------
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }

  let pushSubscribed = false;

  // manual=true (the storefront button) shows a visible result via alert(),
  // since silent failures here left no way to tell why notifications never
  // came. This can run BEFORE login (tapped from the storefront) -- in that
  // case it still registers the service worker, gets permission, and creates
  // the browser-side subscription; the only thing it can't do yet is tell
  // the server which account it belongs to (no session), so that last step
  // finishes automatically, silently, the moment you actually sign in.
  async function setupPushNotifications(manual) {
    if (pushSubscribed) {
      if (manual) window.alert('Notifications are already on for this device.');
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      if (manual) window.alert("This browser doesn't support push notifications.");
      return;
    }

    try {
      // Request permission FIRST, directly inside the click, before any
      // await -- some browsers only show the prompt (rather than silently
      // auto-denying it) when it's requested with no async gap after the
      // user gesture that triggered it.
      let permission = Notification.permission;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }
      if (permission !== 'granted') {
        if (manual) window.alert('Notifications are blocked. Enable them for this site in your browser settings, then try again.');
        return;
      }

      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const keyRes = await fetch('/api/vapid-public-key');
      if (!keyRes.ok) {
        if (manual) window.alert('Notifications are not configured on the server yet.');
        return;
      }
      const { publicKey } = await keyRes.json();

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      const subRes = await fetch('/api/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription }),
      });

      if (subRes.status === 401) {
        // Not signed in yet -- permission is granted and the subscription
        // already exists; the server just doesn't know whose account it
        // belongs to until you sign in, which happens automatically then.
        if (manual) window.alert('Notifications enabled. Sign in to finish setup.');
        return;
      }
      if (!subRes.ok) throw new Error('push-subscribe failed: ' + subRes.status);

      pushSubscribed = true;
      if (manual) window.alert('Notifications are on for this device.');
    } catch (err) {
      // Automatic (post-login) attempts fail silently -- notifications are a
      // nice-to-have and shouldn't interrupt the chat. The manual storefront
      // button always reports back so it's actually possible to tell what happened.
      console.warn('Push notification setup failed:', err);
      if (manual) window.alert('Could not enable notifications: ' + (err && err.message ? err.message : err));
    }
  }

  document.getElementById('storefront-notif-btn').addEventListener('click', () => setupPushNotifications(true));

  // ---------- video/audio calls ----------
  // The server only relays small setup messages (see 'call:*' below); once
  // connected, audio/video flows directly between the two browsers over
  // WebRTC. A STUN server alone often isn't enough to get two phones on
  // different networks talking directly, so a free public TURN relay is
  // included as a fallback -- good enough for personal use, not as reliable
  // as a paid service under every possible network condition.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ];

  const callState = {
    status: 'idle', // idle | ringing-out | ringing-in | connecting | connected
    callType: null, // 'audio' | 'video'
    role: null, // 'caller' | 'callee'
    pc: null,
    localStream: null,
    connectedAt: null,
    durationTimer: null,
  };

  function callEl(id) {
    return document.getElementById(id);
  }

  // getUserMedia rejects with a specific error name -- translate the common
  // ones into something actionable instead of a bare "permission denied".
  // Note: once a browser remembers camera/mic as *blocked* for this site, it
  // will NOT show the prompt again on its own -- that stored decision has to
  // be reset in the browser's own site settings; no page can force it to
  // re-ask (same reason a site can't force the password-save prompt away).
  function describeMediaError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return (
        'Camera/microphone access is blocked for this site in your browser.\n\n' +
        'Fix: tap the 🔒/ⓘ icon next to the address bar → Permissions (or Site settings) ' +
        '→ set Camera and Microphone to "Allow" (or "Ask") → then try calling again.'
      );
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return "No camera/microphone was found on this device.";
    }
    if (name === 'NotReadableError') {
      return 'Your camera/microphone is already being used by another app. Close it and try again.';
    }
    return (err && err.message) || String(err);
  }

  document.getElementById('chat-call-audio-btn').addEventListener('click', () => startCall('audio'));
  document.getElementById('chat-call-video-btn').addEventListener('click', () => startCall('video'));

  function startCall(callType) {
    if (!state.socket) return;
    if (callState.status !== 'idle') {
      window.alert('Already on a call.');
      return;
    }
    callState.callType = callType;
    callState.role = 'caller';
    callState.status = 'ringing-out';
    callEl('call-outgoing-text').textContent = `Calling… (${callType === 'video' ? 'video' : 'voice'})`;
    callEl('call-outgoing-icon').textContent = callType === 'video' ? '🎥' : '📞';
    callEl('call-outgoing').classList.remove('hidden');
    state.socket.emit('call:invite', { callType });
  }

  function wireCallSocketEvents() {
    state.socket.on('call:incoming', ({ from, callType }) => {
      if (callState.status !== 'idle') {
        state.socket.emit('call:decline'); // already on a call -- auto-decline
        return;
      }
      callState.callType = callType;
      callState.role = 'callee';
      callState.status = 'ringing-in';
      callEl('call-incoming-text').textContent = `${from} is calling (${callType === 'video' ? 'video' : 'voice'})`;
      callEl('call-incoming-icon').textContent = callType === 'video' ? '🎥' : '📞';
      callEl('call-incoming').classList.remove('hidden');
    });

    state.socket.on('call:accepted', async () => {
      if (callState.role !== 'caller') return;
      callEl('call-outgoing').classList.add('hidden');
      try {
        await setupPeerConnection();
        const offer = await callState.pc.createOffer();
        await callState.pc.setLocalDescription(offer);
        state.socket.emit('call:signal', { type: 'offer', sdp: offer });
        showActiveCallUI();
      } catch (err) {
        window.alert('Could not start the call.\n\n' + describeMediaError(err));
        endCall();
      }
    });

    state.socket.on('call:declined', () => {
      window.alert('Call declined.');
      resetCallUI();
    });

    state.socket.on('call:unavailable', () => {
      window.alert('Not reachable right now.');
      resetCallUI();
    });

    state.socket.on('call:ended', () => {
      if (callState.status === 'idle') return;
      resetCallUI();
    });

    state.socket.on('call:camera', ({ on }) => {
      if (callState.status !== 'connected' || callState.callType !== 'video') return;
      callEl('call-remote-video').classList.toggle('hidden', !on);
      callEl('call-remote-camera-off').classList.toggle('hidden', on);
    });

    state.socket.on('call:signal', async (payload) => {
      if (!callState.pc || !payload) return;
      try {
        if (payload.type === 'offer') {
          await callState.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          const answer = await callState.pc.createAnswer();
          await callState.pc.setLocalDescription(answer);
          state.socket.emit('call:signal', { type: 'answer', sdp: answer });
          showActiveCallUI();
        } else if (payload.type === 'answer') {
          await callState.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        } else if (payload.type === 'candidate' && payload.candidate) {
          await callState.pc.addIceCandidate(payload.candidate);
        }
      } catch (err) {
        console.warn('Call signaling error:', err);
      }
    });
  }

  document.getElementById('call-cancel-btn').addEventListener('click', () => endCall());

  document.getElementById('call-decline-btn').addEventListener('click', () => {
    if (!state.socket) return;
    state.socket.emit('call:decline');
    resetCallUI();
  });

  document.getElementById('call-accept-btn').addEventListener('click', async () => {
    callEl('call-incoming').classList.add('hidden');
    callState.status = 'connecting';
    try {
      await setupPeerConnection();
      state.socket.emit('call:accept');
      // The caller sends the offer next; showActiveCallUI() runs once it arrives.
    } catch (err) {
      window.alert('Could not answer the call.\n\n' + describeMediaError(err));
      state.socket.emit('call:decline');
      resetCallUI();
    }
  });

  async function setupPeerConnection() {
    callState.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      // "ideal" (not "exact"/min) lets the browser start modestly and the
      // codec/network layer negotiate upward when bandwidth allows, rather
      // than insisting on a fixed resolution that a slow network can't carry.
      video: callState.callType === 'video'
        ? { facingMode: 'user', width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 24, max: 30 } }
        : false,
    });
    callEl('call-local-video').srcObject = callState.localStream;
    callEl('call-local-video').classList.toggle('hidden', callState.callType !== 'video');

    // Mic starts muted by default -- tap 🎤 to speak.
    const audioTrack = callState.localStream.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = false;
    callEl('call-mute-btn').classList.add('muted');

    // Camera button only makes sense on a video call -- starts on, same as
    // any other call app, and behaves identically for whoever taps it.
    callEl('call-camera-btn').classList.toggle('hidden', callState.callType !== 'video');
    callEl('call-camera-btn').classList.remove('cam-off');
    callEl('call-camera-btn').title = 'Turn camera off';
    callEl('call-local-camera-off').classList.add('hidden');
    callEl('call-remote-camera-off').classList.add('hidden');

    callState.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    callState.localStream.getTracks().forEach((track) => {
      const sender = callState.pc.addTrack(track, callState.localStream);
      if (track.kind === 'video') applyAdaptiveVideoParams(sender);
    });

    callState.pc.onicecandidate = (e) => {
      if (e.candidate && state.socket) state.socket.emit('call:signal', { type: 'candidate', candidate: e.candidate });
    };
    callState.pc.ontrack = (e) => {
      const remoteVideo = callEl('call-remote-video');
      remoteVideo.srcObject = e.streams[0];
      // Autoplay policies block an unmuted <video> here because srcObject is
      // set asynchronously, outside any user-gesture call stack -- start
      // muted (always allowed) then unmute right after playback begins.
      remoteVideo.play().then(() => {
        remoteVideo.muted = false;
      }).catch(() => {
        // Even muted autoplay was blocked -- retry on the next tap anywhere.
        const retry = () => {
          remoteVideo.play().then(() => { remoteVideo.muted = false; }).catch(() => {});
          document.removeEventListener('click', retry);
        };
        document.addEventListener('click', retry, { once: true });
      });
    };
    callState.pc.onconnectionstatechange = () => {
      if (callState.pc && callState.pc.connectionState === 'failed') endCall();
    };

    startNetworkQualityMonitor();
  }

  // WebRTC already adapts bitrate/resolution to the network automatically
  // (browsers run real-time bandwidth estimation under the hood) -- this
  // just points that built-in adaptation in a sane direction: a ceiling so
  // a strong connection doesn't waste bandwidth it doesn't need, and a
  // preference for staying smooth (lower resolution) over freezing when the
  // network gets bad, rather than the reverse.
  function applyAdaptiveVideoParams(sender) {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = 1_500_000;
    params.degradationPreference = 'maintain-framerate';
    sender.setParameters(params).catch(() => {}); // best-effort -- not every browser supports every field here
  }

  // A small 🟢/🟡/🔴 indicator on the call controls, from real connection
  // stats (packet loss + round-trip time) -- so it's visible when the call
  // itself is struggling, even though the quality adjustment is automatic.
  let networkQualityTimer = null;
  function startNetworkQualityMonitor() {
    stopNetworkQualityMonitor();
    networkQualityTimer = setInterval(async () => {
      if (!callState.pc) return;
      try {
        const stats = await callState.pc.getStats();
        let rtt = null;
        let lossFraction = null;
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
            rtt = report.currentRoundTripTime;
          }
          if (report.type === 'remote-inbound-rtp' && typeof report.fractionLost === 'number') {
            lossFraction = report.fractionLost;
          }
        });
        setNetworkQualityIndicator(rtt, lossFraction);
      } catch (err) {
        // stats aren't critical -- just skip this tick
      }
    }, 3000);
  }
  function stopNetworkQualityMonitor() {
    clearInterval(networkQualityTimer);
    networkQualityTimer = null;
  }
  function setNetworkQualityIndicator(rtt, lossFraction) {
    const el = callEl('call-network-quality');
    if (!el) return;
    let quality = 'good';
    if ((rtt != null && rtt > 0.5) || (lossFraction != null && lossFraction > 0.1)) quality = 'poor';
    else if ((rtt != null && rtt > 0.25) || (lossFraction != null && lossFraction > 0.03)) quality = 'fair';
    el.className = 'call-network-quality ' + quality;
    el.title = quality === 'good' ? 'Good connection' : quality === 'fair' ? 'Fair connection' : 'Poor connection';
  }

  function showActiveCallUI() {
    callState.status = 'connected';
    const isVideo = callState.callType === 'video';
    callEl('call-remote-video').classList.toggle('hidden', !isVideo);
    callEl('call-audio-indicator').classList.toggle('hidden', isVideo);
    if (!isVideo) callEl('call-audio-name').textContent = 'Call in progress';
    callEl('call-active').classList.remove('hidden');
    callEl('call-active').classList.remove('expanded');
    startCallDurationTimer();
  }

  function formatCallDuration(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function startCallDurationTimer() {
    // showActiveCallUI() can legitimately run twice for the callee (once
    // when the offer arrives, in case renegotiation ever re-fires it) --
    // guard against starting a second overlapping interval.
    if (callState.durationTimer) return;
    callState.connectedAt = Date.now();
    const el = callEl('call-duration');
    el.textContent = '0:00';
    el.classList.remove('hidden');
    callState.durationTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - callState.connectedAt) / 1000);
      el.textContent = formatCallDuration(secs);
    }, 1000);
  }

  function stopCallDurationTimer() {
    clearInterval(callState.durationTimer);
    callState.durationTimer = null;
    callState.connectedAt = null;
    const el = callEl('call-duration');
    el.classList.add('hidden');
    el.textContent = '0:00';
  }

  function endCall() {
    if (state.socket) state.socket.emit('call:end');
    resetCallUI();
  }
  document.getElementById('call-end-btn').addEventListener('click', endCall);

  function resetCallUI() {
    stopNetworkQualityMonitor();
    stopCallDurationTimer();
    hideFloatingExpandButton();
    if (callState.pc) {
      callState.pc.close();
      callState.pc = null;
    }
    if (callState.localStream) {
      callState.localStream.getTracks().forEach((t) => t.stop());
      callState.localStream = null;
    }
    callState.status = 'idle';
    callState.role = null;
    callState.callType = null;
    callEl('call-remote-video').srcObject = null;
    callEl('call-local-video').srcObject = null;
    callEl('call-incoming').classList.add('hidden');
    callEl('call-outgoing').classList.add('hidden');
    callEl('call-active').classList.add('hidden');
    callEl('call-active').classList.remove('expanded');
    callEl('call-mute-btn').classList.remove('muted');
    callEl('call-camera-btn').classList.add('hidden');
    callEl('call-camera-btn').classList.remove('cam-off');
    callEl('call-local-camera-off').classList.add('hidden');
    callEl('call-remote-camera-off').classList.add('hidden');
    const quality = callEl('call-network-quality');
    if (quality) quality.className = 'call-network-quality';
  }

  document.getElementById('call-mute-btn').addEventListener('click', () => {
    if (!callState.localStream) return;
    const track = callState.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    callEl('call-mute-btn').classList.toggle('muted', !track.enabled);
  });

  document.getElementById('call-camera-btn').addEventListener('click', () => {
    if (!callState.localStream) return;
    const track = callState.localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    callEl('call-camera-btn').classList.toggle('cam-off', !track.enabled);
    callEl('call-camera-btn').title = track.enabled ? 'Turn camera off' : 'Turn camera on';
    callEl('call-local-video').classList.toggle('hidden', !track.enabled);
    callEl('call-local-camera-off').classList.toggle('hidden', track.enabled);
    if (state.socket) state.socket.emit('call:camera', { on: track.enabled });
  });

  document.getElementById('call-expand-btn').addEventListener('click', () => {
    callEl('call-active').classList.toggle('expanded');
  });

  // Dragging the floating call widget (not while expanded to full-screen).
  // Tapping the floating bubble reveals a full-screen button (auto-hiding
  // after a few seconds) rather than expanding right away -- so repositioning
  // it with a quick tap-drag, or just tapping it once, never accidentally
  // full-screens the call. You have to deliberately tap the revealed button.
  let floatingExpandHideTimer = null;
  function showFloatingExpandButton() {
    const btn = callEl('call-floating-expand-btn');
    btn.classList.add('visible');
    clearTimeout(floatingExpandHideTimer);
    floatingExpandHideTimer = setTimeout(() => btn.classList.remove('visible'), 3000);
  }
  function hideFloatingExpandButton() {
    clearTimeout(floatingExpandHideTimer);
    floatingExpandHideTimer = null;
    callEl('call-floating-expand-btn').classList.remove('visible');
  }
  callEl('call-floating-expand-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    callEl('call-active').classList.add('expanded');
    hideFloatingExpandButton();
  });

  // Dragging the floating bubble; a tap that barely moved reveals the
  // full-screen button above instead of expanding directly.
  (function makeCallWidgetDraggable() {
    const widget = callEl('call-active');
    const handle = callEl('call-drag-handle');
    const TAP_MAX_MOVE = 8;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    let startClientX = 0;
    let startClientY = 0;
    let moved = 0;

    function start(x, y) {
      if (widget.classList.contains('expanded')) return;
      dragging = true;
      moved = 0;
      startClientX = x;
      startClientY = y;
      const rect = widget.getBoundingClientRect();
      offsetX = x - rect.left;
      offsetY = y - rect.top;
    }
    function move(x, y) {
      if (!dragging) return;
      moved = Math.max(moved, Math.hypot(x - startClientX, y - startClientY));
      const maxX = window.innerWidth - widget.offsetWidth;
      const maxY = window.innerHeight - widget.offsetHeight;
      widget.style.left = Math.min(Math.max(0, x - offsetX), maxX) + 'px';
      widget.style.top = Math.min(Math.max(0, y - offsetY), maxY) + 'px';
      widget.style.right = 'auto';
    }
    function end() {
      if (dragging && moved < TAP_MAX_MOVE) showFloatingExpandButton(); // a genuine tap, not a drag
      dragging = false;
    }

    handle.addEventListener('mousedown', (e) => start(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', end);

    handle.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      start(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      move(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchend', end);
  })();

  // Resizing the floating call widget by dragging its corner handle, like a
  // floating/PiP app window (not available while expanded full-screen).
  (function makeCallWidgetResizable() {
    const widget = callEl('call-active');
    const handle = callEl('call-resize-handle');
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    const MIN_W = 130;
    const MIN_H = 190;

    function start(x, y) {
      if (widget.classList.contains('expanded')) return;
      resizing = true;
      const rect = widget.getBoundingClientRect();
      startX = x;
      startY = y;
      startW = rect.width;
      startH = rect.height;
    }
    function move(x, y) {
      if (!resizing) return;
      const maxW = Math.min(360, window.innerWidth - widget.offsetLeft - 8);
      const maxH = Math.min(480, window.innerHeight - widget.offsetTop - 8);
      widget.style.width = Math.min(Math.max(MIN_W, startW + (x - startX)), maxW) + 'px';
      widget.style.height = Math.min(Math.max(MIN_H, startH + (y - startY)), maxH) + 'px';
    }
    function end() {
      resizing = false;
    }

    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      start(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', end);

    handle.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      const t = e.touches[0];
      start(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!resizing) return;
      const t = e.touches[0];
      move(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchend', end);
  })();

  renderProducts();
})();
