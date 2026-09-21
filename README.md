# secret_talk

A private, real-time, 2-person chat that's disguised as an ordinary online
storefront. To anyone else, it just looks like a generic shopping site.
Only the two of you know that typing the right password swaps in a real
chat — with calls, voice notes, photos, and push notifications.

Deploy your own copy in a few minutes, free, and you and one other person
get a private line that looks like nothing at all.

## What it does

- Each person has their **own password** (set via environment variables). The
  password you type determines your display name — there's no separate
  username/account system.
- Chat history is saved to a small local SQLite database so it's still there
  next time you sign in.
- Closing the browser fully clears the session — you'll need to sign in again.
- Minimizing the window, switching tabs, or clicking the 🔒 button instantly
  swaps back to the decoy sign-in screen, without losing the connection or
  any messages. Entering the password again brings the chat right back.
- When the other person sends a message, you get a real push notification —
  even if the site/browser is fully closed — worded generically (e.g. "Your
  order status has updated") so it never reveals who messaged or what was said.
- The whole thing is mobile-friendly (works well added to your phone's home
  screen too).
- Tap 📎 to send a photo or video (25MB max) — it shows up inline for both of
  you, same as a text message. Uploaded files live under `data/uploads/` and
  are subject to the same free-tier disk caveat as the database below.
- 📞/🎥 start a real voice or video call. Once connected, the call becomes a
  small floating window you can drag anywhere on screen (tap ⤢ to go
  full-screen and back) while the chat underneath stays fully usable — tap
  🎤/🎥 to mute/toggle camera, the red button to hang up.

### Calls: two things worth knowing

- **Incoming calls show through the disguise.** Everything else (the
  storefront, push notifications) stays generic on purpose, but a ringing
  call needs a real "so-and-so is calling" prompt to be usable, so it will
  pop up even over the storefront or lock screen.
- **Network reliability isn't guaranteed.** Two phones on different
  networks need a STUN/TURN server to connect directly; this uses Google's
  free STUN plus the free Open Relay TURN service. That's enough most of the
  time, but not as bulletproof as a paid calling service — an occasional
  call may fail to connect depending on both networks. Backgrounding the
  browser mid-call (switching apps, locking the phone) will likely drop the
  call too — mobile browsers pause camera/mic access for backgrounded tabs,
  which isn't something fixable from the app side.

## Deploy your own

Want your own private chat like this with someone? Fork this repo — it
takes about 10 minutes, entirely free, and only you and whoever you share it
with will ever see the real chat behind the storefront.

### 1. Fork it and configure your passwords

Fork this repository, then locally:

```
cp .env.example .env
```

Edit `.env` and set:

```
PASSWORD_A=<a strong password only you know>
NAME_A=<your name>
PASSWORD_B=<a different strong password only your friend knows>
NAME_B=<their name>
SESSION_SECRET=<a long random string>
```

Generate a good `SESSION_SECRET` with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use two genuinely different, non-guessable passwords — this is the only
thing standing between a stranger and your messages. (`.env` is already
gitignored, so these never get pushed to your fork.)

### Optional: enable push notifications

Generate a VAPID keypair **once**:

```
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Add the result to `.env`:

```
VAPID_PUBLIC_KEY=<publicKey from above>
VAPID_PRIVATE_KEY=<privateKey from above>
VAPID_SUBJECT=mailto:you@example.com
```

Keep these same keys forever (including across Render redeploys) — if they
ever change, both of you will need to reopen the chat once to re-subscribe.
If you skip this section entirely, the chat still works fine, you just won't
get notified of new messages.

**iPhone/iPad caveat:** Apple only allows web push for sites that have been
"Added to Home Screen" (Share button → Add to Home Screen), and requires
iOS 16.4+. Opening the site in Safari without adding it to your home screen
will not deliver background notifications on iOS — this is an Apple platform
restriction, not something fixable from the app side. Android (Chrome) gets
full background push with no extra steps.

### 2. Run it locally

```
npm install
npm start
```

Open http://localhost:3000 — you'll see the storefront homepage. Click
"Sign in", enter either password (the username field is ignored), and the
chat appears.

### 3. Deploy to Render (free tier)

1. On [render.com](https://render.com), create a new **Web Service** and
   connect your fork of this repo.
2. Build command: `npm install`. Start command: `npm start`.
3. Under the service's **Environment** tab, add the same variables from your
   `.env` file (`PASSWORD_A`, `NAME_A`, `PASSWORD_B`, `NAME_B`,
   `SESSION_SECRET`, and the `VAPID_*` ones if you set those up) plus
   `NODE_ENV=production`. Don't set `PORT` — Render provides its own.
4. Deploy. Render gives you a `https://your-app.onrender.com` URL — that's
   the link you and your friend open. On your phone, open that link and use
   "Add to Home Screen" (both iOS and Android) for the most app-like feel —
   and on iPhone, this step is required for push notifications to work at all.

### Persistence caveat -- and Render's 15-minute free-tier sleep

Render's **free** web services have no persistent disk at all (that's a paid-plan
feature) -- the whole filesystem, SQLite database included, resets on *every*
restart. And a free service auto-sleeps after 15 minutes with no incoming
requests, waking back up (with a fresh, empty database) on the next visit.
Left alone, that means chat history quietly resets every time nobody's used
it for 15+ minutes -- not just on code updates.

**Fix (still free): keep the service from ever going to sleep.** Have a free
uptime monitor ping it every few minutes so it never sits idle for 15:

1. Sign up free at [uptimerobot.com](https://uptimerobot.com) (no card needed).
2. **Add New Monitor** → type **HTTP(s)** → paste your Render URL with
   `/healthz` on the end (e.g. `https://your-app.onrender.com/healthz`) →
   monitoring interval **5 minutes** (the free plan's minimum) → Save.

That's it -- as long as that monitor keeps running, the service stays awake
and the database survives. It will still reset on an actual code
**redeploy** (a genuinely new container), since the free tier still has no
persistent disk for that case. If you ever want history to survive redeploys
too, the real fix is swapping the local SQLite file for a small external
database with its own free tier (e.g. Turso, Supabase, or Neon) instead of
storing data on Render's local disk at all.

## Notes on the disguise

The storefront/sign-in pages are an original, hand-built layout inspired by
common e-commerce site patterns (nav bar, search bar, hero banner, category
tiles, product grid), styled with colors/spacing close to a typical big-box
shopping site — not copied from any specific real company's code, logo, or
wordmark, so there's no trademark/impersonation risk while still reading as
"just some shopping site" at a glance. Notifications follow the same rule:
generic wording only, never the sender or message text.

## Like it?

If you deploy your own and like it, a ⭐ on this repo helps other people
find it.
