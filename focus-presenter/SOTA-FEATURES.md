# Exploration: 2026 SOTA features for Focus Presenter

What the 2026 web platform makes possible that the incumbent tools (screen shades,
annotation pens, spotlight widgets — all built on ~2015 tech) do not use. Everything
below is filtered through two product laws: **offline-first stays true** (all AI/speech
on-device) and **never block or embarrass a presenter mid-meeting**.

## A. On-device AI (Chrome built-in AI — Gemini Nano, GA for extensions since 138)

The Prompt API runs a local multimodal model inside Chrome — free, no API keys, no data
leaving the machine. It is *extension-first* (service-worker access), which dovetails
with the Web Store move: the extension form factor unlocks AI the plain HTML file can't
reliably use.

1. **Auto-choreography** ⭐ — feed the rendered page (canvas → image input) to the local
   model: "identify the process steps and their order." Output: a numbered reveal
   sequence — curtain stops or a spotlight path — generated in one click. The user then
   just presses *next*. This turns 5 minutes of manual slate setup into zero.
   Feasibility: multimodal Prompt API accepts canvas input; our tile renderer already
   produces the images. Fallback when the model is unavailable: PDF text layer + layout
   heuristics (pdf.js gives text boxes with coordinates — clustering them into "steps"
   works without any AI for well-structured flows).
2. **Talk-track sync (voice-following focus)** ⭐⭐ — the original product vision, fully
   automated: mic → on-device speech-to-text (Web Speech API's new local mode, or
   Whisper-small via WASM/WebGPU, both offline) → fuzzy-match the spoken words against
   step labels → the spotlight *glides to whatever the speaker is talking about*, and
   the curtain never reveals a step that hasn't been mentioned. No incumbent has
   anything within years of this. Risk: latency/accuracy tuning; ship as "assist mode"
   (suggests the jump, presenter confirms with one key) before full auto.
3. **Jump-to-anything (Ctrl+K)** — command palette over the PDF text layer: type or say
   "email verification", spotlight glides there. Pure text search first; local embeddings
   later. Answers the audience-question moment ("wait, go back to X") gracefully.
4. **Auto speaker notes** — Summarizer API (also on-device) drafts one-line talking
   points per detected step, shown only in presenter view.

## B. Presentation craft (no AI, high perceived quality)

5. **Choreography timeline** ⭐ — record an ordered list of reveal states; advance /
   rewind with Space or arrows; step counter chip. Persist per file (`chrome.storage` +
   file hash) so covers are restored on reopen. This is the backbone feature: A1 and A2
   both *produce* a timeline; clickers and presenter view *consume* it.
6. **Hardware clicker support** — map PageUp/PageDown/B (what every Logitech/Kensington
   remote sends) to timeline next/prev/blackout. Trivial to build, strategically loud:
   "works with the $130 Logitech Spotlight remote" reframes us as the software their
   hardware deserves.
7. **Cinematic camera** — animated zoom/pan (eased, Screen-Studio-style) when moving
   between reveal steps instead of teleporting; the tile renderer re-sharpens at rest.
   Cheap to build on our zoom engine; the single biggest "feels premium" upgrade.
8. **Laser + fading ink** — pointer trail and pressure-sensitive ink that auto-fades
   (Pointer Events); parity that removes the need to run Epic Pen/ZoomIt alongside.
9. **Loupe magnifier** — a cursor lens at 2–4× rendered from vector at full resolution.
   Only possible because of our tile engine; screen-anchored competitors physically
   cannot do this (they'd magnify pixels).

## C. Multi-screen & remote presenting (2026 platform APIs)

10. **True presenter view** ⭐ — Window Management API: audience projector gets the clean
    fullscreen canvas; the laptop shows minimap, current/next step, timer, and controls.
    For the *remote-call* case (the more common 2026 meeting): share the tab in
    Meet/Zoom and keep a **Document Picture-in-Picture** floating control strip —
    presenter drives from the PiP while the shared tab stays clean. Nobody in the
    category has this.
11. **Phone as remote** — honest note: needs a signaling channel (WebRTC/QR pairing), so
    it breaks pure-offline. Option: offer it as an explicitly online convenience, or
    skip — clicker support (B6) covers the need offline.

## D. Async & capture (the Loom era)

12. **Walkthrough recording** — capture the choreographed reveal + mic narration to a
    local webm (MediaRecorder over captureStream; WebCodecs→mp4 later). "Couldn't make
    the meeting? Here's the guided flow, 90 seconds." Fully offline, file never uploads.

## E. Input formats

13. **Mermaid paste-to-present** — paste flowchart-as-code (Mermaid), render to SVG
    locally (bundleable, ~1 MB), present vector-sharp. Engineering teams keep flows in
    Mermaid in their repos/wikis; this makes us their native presenter.
14. **PPTX direct import** — still not worth it (fidelity trap; export-to-PDF is one
    click and pixel-perfect). Revisit only if reviews demand it.

## F. Accessibility & i18n

15. **On-device translation** — Chrome's Translator API: hover-translate revealed step
    text for mixed-language audiences (relevant to Israeli teams presenting to
    international stakeholders). Plus reduced-motion and high-contrast modes (cheap,
    review-friendly).

## Priority map

| Wave | Features | Rationale |
|---|---|---|
| Quick wins (days) | 6 clicker · 8 laser/ink · 7 camera · 15 a11y | Cheap, immediately visible quality |
| Backbone (1–2 wks) | 5 timeline (+persistence) · 3 Ctrl+K · 9 loupe | Enables everything else; first real Pro value |
| Flagship AI | 1 auto-choreography → 2 talk-track assist → full voice-follow | The 2026 headline; extension-only (Prompt API), reinforcing the store move |
| Platform | 10 presenter view/PiP · 12 recording | Pro tier depth for professionals |
| Reach | 13 Mermaid · 4 auto-notes · 11 phone remote (online-optional) | Segment expanders |

Tier mapping: free gets 6/7/8/15 and a 3-step timeline (taste of choreography); Pro gets
unlimited timeline, AI features, presenter view, recording, loupe, Mermaid.

The through-line for positioning: incumbents *cover pixels*; Focus Presenter
*understands the document* — and 2026's on-device AI lets it understand the *speaker*
too, without a single byte leaving the room.
