# Exploration: phone as smart remote (Pro featurette)

The presenter pockets their phone, walks the room, and drives everything from it —
next/prev step, jump-to-anything, blackout, spotlight nudge — while the laptop (or the
audience screen) stays the display. Both stay live: the presenter can drive from either
the machine or the phone at any moment; the laptop is always the source of truth.

## Why this is a *good* Pro feature (not just a nice one)

Every current feature runs 100% locally, which is great for trust but awkward for
subscriptions ("why pay monthly for a file on my disk?"). The phone remote is the first
feature that **legitimately uses our cloud** — a tiny relay for pairing and message
passing. Recurring infrastructure → recurring price feels fair. It draws the cleanest
possible tier line:

> **Free = everything that runs on your machine. Pro = everything that uses ours.**

And it pairs naturally with the audience screen: laptop → projector, phone → in hand,
presenter fully untethered. That combination is the "walk the room" story completed.

## The channel problem (why this can't be pure-offline)

A browser page — single HTML file or MV3 extension alike — **cannot listen for
connections**. No server sockets, no mDNS, no Bluetooth-peripheral mode (Web Bluetooth
on phones can't advertise). So the phone can never "just find" the laptop. Options:

| Channel | Verdict |
|---|---|
| Local HTTP/WS server on the laptop | ❌ Impossible from a browser; needs a companion native app — kills the zero-install story |
| Web Bluetooth | ❌ Phones can't act as peripherals from the browser; desktop can't advertise either |
| WebRTC with QR-only signaling (no server) | ❌ Offer fits in a QR, but the *answer* has to travel back phone→laptop — camera-scanning the phone or typing ~1 KB by hand. Unusable on stage |
| **Hosted relay (WebSocket rooms)** | ✅ Both devices dial out to `wss://relay…`; pair by 6-char code / QR. ~50 lines of Worker code, works on hotel Wi-Fi, guest networks, phone on LTE |
| Relay for signaling + WebRTC DataChannel upgrade | ✅ Later optimization: after pairing, traffic goes P2P (LAN-local when both are on the same Wi-Fi). Same UX, lower latency, near-zero relay cost |

**Decision: hosted relay first, WebRTC upgrade later.** Latency through a relay is
30–80 ms for a button press — imperceptible. The honest framing in the UI: *"The remote
needs internet to connect. Your document never does."*

## Privacy architecture — the document never leaves the laptop

This is the part that keeps the product story intact:

- Only **control events** travel: `{next}`, `{prev}`, `{jump:"section 3.2.1"}`,
  `{blackout}`, `{nudge:dx,dy}` — plus a small **status frame** back to the phone
  (current step index/label, next label, step count, timer). Never the PDF, never
  rendered pixels.
- Even those frames are **end-to-end encrypted** (AES-GCM via WebCrypto). The symmetric
  key is generated on the laptop and shipped inside the QR code **URL fragment**
  (`…/#room=X7K2PQ&k=<base64key>`) — fragments are never sent in HTTP requests, so the
  relay stores and sees only ciphertext and a room code. We can truthfully say the
  server *cannot* read step labels.
- Rooms are single-controller (second phone joining bumps the first), high-entropy
  codes, expire after the session, nothing persisted.

## Pairing UX

1. Presenter clicks **📱 Remote** → laptop generates room + key, shows a QR overlay
   (plus a short code for manual entry).
2. Phone scans → opens `remote.focuspresenter.app` (a ~15 KB static PWA — installable,
   works in any mobile browser, nothing on the App/Play Store to maintain).
3. QR overlay auto-dismisses on connect; toolbar shows a small 📱 "remote connected"
   chip. Disconnect/reconnect is automatic (relay rooms are re-joinable while the
   session lives).

## What the phone shows (thin controller, zero document state)

```
┌───────────────────────────┐
│  Step 7 / 22        12:41 │   ← progress + room-clock/elapsed timer
│  ▶ Verify email address   │   ← current step label
│  next: Send welcome mail  │   ← what's coming (presenter-only knowledge)
├───────────────────────────┤
│                           │
│      [   ◀   ] [   ▶   ]  │   ← giant thumb-sized prev/next
│                           │
├───────────────────────────┤
│  🔍 jump…   ⬛ black   💡  │   ← jump palette · blackout · spotlight on/off
└───────────────────────────┘
```

- **▶ / ◀** — `stepNext()` / `stepPrev()`, same glide as a laptop click.
- **Jump** — text field feeding the existing `matchStep()` fuzzy matcher on the laptop
  (the query travels, matching stays local). Phone keyboards also have a built-in mic
  key, so this doubles as voice-jump with zero extra work.
- **Blackout** — instant full-shade slate (the classic presenter "B" key).
- **Touchpad strip** (v2) — drag to nudge the spotlight freely for non-linear charts.
- The whole screen except the header is also a tap target: tap right half = next, left
  half = prev, so the presenter can drive without looking.

Wake Lock API keeps the phone screen on while connected.

## Implementation shape

Reuses the machinery that already exists for the audience screen — the remote is a new
*transport*, not a new feature:

- Laptop side (~200 lines in `app.js`): QR overlay, relay socket, decrypt → dispatch to
  `stepNext/stepPrev/matchStep/stepTo/toggleBlackout`, encrypt + push a status frame on
  every step change (piggyback on the existing `snapshot()` diffing loop).
- Phone side (~300 lines, static page): connect, render status, send commands. No pdf.js,
  no rendering — it never sees the document.
- Relay (~50–100 lines): Cloudflare Worker + Durable Object per room, pure
  ciphertext pass-through. Cost at this message rate is effectively zero (pennies per
  thousand sessions) — free tier covers the first years of the product's life.
- QR generation: tiny local encoder (~5 KB inlined), no network.

Estimated effort: **3–4 days** including the relay deploy and reconnect handling.

## Risks / honest caveats

- **Corporate networks that block WebSockets** — rare (Slack/Teams need them too);
  fallback to HTTPS long-polling through the same Worker if reviews demand it.
- **The single-file HTML version** can't be paywalled offline — the remote is naturally
  extension/Pro-only anyway since it needs the relay; no license-check gymnastics needed.
  The relay only opens rooms for authenticated Pro accounts → the paywall *is* the server.
- **Latency on LTE** — still fine for button presses; the WebRTC LAN upgrade path exists
  if we ever want live touchpad-drag to feel native.

## Verdict

Build it. Small, high perceived value ("my phone is the clicker"), completes the
walk-the-room story that left-click/right-click started, and it's the feature that makes
the subscription make sense. Slot it right after the store launch, as the headline of
the first Pro update.
