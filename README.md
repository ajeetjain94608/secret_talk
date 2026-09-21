# secret_talk

A private, real-time, 2-person chat that's disguised as an ordinary online
storefront. To anyone else — including anyone glancing at your phone — it
just looks like a boring shopping site. Only the two of you know that
typing the right password swaps in a real chat, with calls, voice notes,
photos, and notifications.

No coding, no terminal — you can have your own copy running in about 5
minutes.

## Get your own — one click

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ajeetjain94608/secret_talk)

1. Click the button above.
2. Sign up for [Render](https://render.com) if you don't have an account
   (it's free, no card needed) and let it connect to your GitHub account.
3. Render will ask you to fill in 4 boxes:
   - **NAME_A** → your name
   - **PASSWORD_A** → a password only you know
   - **NAME_B** → the other person's name
   - **PASSWORD_B** → a different password only they know
   - (Everything else is filled in for you automatically.)
4. Click **Apply** / **Create Web Service**, then wait a couple of minutes
   while it builds.
5. Render gives you a link like `https://secret-talk-xxxx.onrender.com` —
   that's your private chat. Open it, tap **Sign in**, and type your
   password (the "email" box can be anything). Send the same link to the
   other person so they can sign in with their own password.
6. On your phone, open the link and add it to your home screen (Share →
   **Add to Home Screen**) so it feels like a real app.

That's it — you're both in. Nobody else who opens that link will see
anything but a generic storefront, because they don't know the password.

**One free-tier thing worth doing:** a free web service on Render falls
asleep after 15 minutes of no visits, and wakes up with an empty chat
history. Keep it awake for free:

1. Go to [uptimerobot.com](https://uptimerobot.com) and sign up free (no
   card needed).
2. **Add New Monitor** → type **HTTP(s)** → paste your Render link with
   `/healthz` added to the end (e.g. `https://secret-talk-xxxx.onrender.com/healthz`)
   → interval **5 minutes** → **Save**.

As long as that monitor is running, your chat history stays put.

## What it does

- Each person has their **own password**. The password you type determines
  your display name — there's no separate username/account system.
- Chat history is saved so it's still there next time you sign in.
- Closing the browser fully clears the session — you'll need to sign in again.
- Minimizing the window, switching tabs, or tapping the 🔒 button instantly
  swaps back to the decoy storefront, without losing the connection or
  any messages. Entering your password again brings the chat right back.
- When the other person messages you, you get a real push notification —
  even if the site/browser is fully closed — worded generically (e.g. "Your
  order status has updated") so it never reveals who messaged or what was said.
- Works well added to your phone's home screen, like a real app.
- Tap 📎 to send a photo or video (25MB max) — it shows up inline for both of
  you, same as a text message.
- 📞/🎥 start a real voice or video call. Once connected, the call becomes a
  small floating window you can drag anywhere on screen (tap ⤢ to go
  full-screen and back) while the chat underneath stays fully usable — tap
  🎤/🎥 to mute your mic or turn your camera off, the red button to hang up.

### Calls: two things worth knowing

- **Incoming calls show through the disguise.** Everything else (the
  storefront, notifications) stays generic on purpose, but a ringing call
  needs a real "so-and-so is calling" prompt to be usable, so it will pop
  up even over the storefront or lock screen.
- **Network reliability isn't guaranteed.** Two phones on different
  networks need a relay server to connect directly; this app uses free
  ones, which work most of the time but occasionally a call may fail to
  connect, and backgrounding the app mid-call will likely drop it — that's
  a phone/browser limitation, not something fixable from the app side.

## Like it?

If you set up your own and like it, a ⭐ on this repo helps other people
find it.

---

## Advanced: manual setup, running locally, push notifications

Everything below is for people who'd rather run this on their own machine,
tweak the code, or turn on push notifications (which the one-click deploy
above skips, since it needs a couple of extra commands).

### Run it locally

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

Then:

```
npm install
npm start
```

Open http://localhost:3000 — you'll see the storefront homepage. Click
"Sign in", enter either password (the username field is ignored), and the
chat appears.

### Enable push notifications

The one-click Render deploy above doesn't set these up, since it needs a
one-time generated keypair. To add it after deploying (or for local use):

Generate a VAPID keypair **once**:

```
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Add the result as environment variables (in Render's **Environment** tab,
or your local `.env`):

```
VAPID_PUBLIC_KEY=<publicKey from above>
VAPID_PRIVATE_KEY=<privateKey from above>
VAPID_SUBJECT=mailto:you@example.com
```

Keep these same keys forever (including across Render redeploys) — if they
ever change, both of you will need to reopen the chat once to re-subscribe.
If you skip this entirely, the chat still works fine, you just won't get
notified of new messages.

**iPhone/iPad caveat:** Apple only allows web push for sites that have been
"Added to Home Screen" (Share button → Add to Home Screen), and requires
iOS 16.4+. Opening the site in Safari without adding it to your home screen
will not deliver background notifications on iOS — an Apple platform
restriction, not something fixable from the app side. Android (Chrome) gets
full background push with no extra steps.

### Deploying to Render manually (instead of the one-click button)

1. Fork this repo, then on [render.com](https://render.com) create a new
   **Web Service** connected to your fork.
2. Build command: `npm install`. Start command: `npm start`.
3. Under the service's **Environment** tab, add `PASSWORD_A`, `NAME_A`,
   `PASSWORD_B`, `NAME_B`, `SESSION_SECRET`, `NODE_ENV=production`, and the
   `VAPID_*` ones if you want push notifications. Don't set `PORT` — Render
   provides its own.
4. Deploy.

### Persistence caveat — and Render's 15-minute free-tier sleep

Render's **free** web services have no persistent disk at all (that's a
paid-plan feature) — the whole filesystem, SQLite database included,
resets on *every* restart. And a free service auto-sleeps after 15 minutes
with no incoming requests, waking back up (with a fresh, empty database)
on the next visit. Left alone, that means chat history quietly resets
every time nobody's used it for 15+ minutes — not just on code updates.
The uptime-monitor trick above works around the sleep; it will still reset
on an actual code **redeploy** (a genuinely new container), since the free
tier still has no persistent disk for that case. If you ever want history
to survive redeploys too, the real fix is swapping the local SQLite file
for a small external database with its own free tier (e.g. Turso,
Supabase, or Neon) instead of storing data on Render's local disk at all.

### Notes on the disguise

The storefront/sign-in pages are an original, hand-built layout inspired by
common e-commerce site patterns (nav bar, search bar, hero banner, category
tiles, product grid), under a made-up store name ("Shopwave") — not copied
from any real company's code, logo, or wordmark. Notifications follow the
same rule: generic wording only, never the sender or message text.
