# Firefox port — plan & status

Briefly is currently **Chromium-only**. This document is the concrete plan to
support Firefox. It is **not implemented yet** — a real port needs manual QA in
Firefox, and two Chrome-specific architectural pieces have no Firefox
equivalent, so shipping an untested "port" would be worse than none.

## What blocks a drop-in port

| Chrome feature Briefly uses | Firefox status | Consequence |
|---|---|---|
| `chrome.sidePanel` | ❌ not implemented | Must use `sidebar_action` (different manifest key + open model). |
| `chrome.offscreen` documents | ❌ not implemented | The whole mic-capture + audio-playback architecture must move. In Firefox, `getUserMedia` and `Audio`/`speechSynthesis` are allowed directly from the sidebar/background page, so the offscreen doc collapses into the sidebar page. |
| `background.service_worker` | ⚠️ partial | Firefox MV3 uses `background.scripts` (event pages), not a service worker. |
| `chrome.*` namespace | ✅ aliased to `browser.*` | Most call sites work as-is; promises already used. |

## Plan

1. **Manifest split.** Keep `manifest.json` (Chrome) and add `manifest.firefox.json`:
   - Replace `side_panel` → `sidebar_action` (`{ "default_panel": "sidepanel/sidepanel.html", "default_title": "Briefly" }`).
   - Replace `background.service_worker` → `background: { "scripts": ["background/background.js"], "type": "module" }`.
   - Add `browser_specific_settings.gecko` (id + `strict_min_version`).
   - Drop `offscreen` from `permissions`.
   - Keep `commands`, `host_permissions`, `content_security_policy` (Firefox honors `connect-src`).

2. **Abstract the audio backend.** Introduce `lib/audio-backend.js` with two
   implementations behind one interface (start/stop/stream/play):
   - **Chrome:** current offscreen-document path (`recorder.js` / `player.js`).
   - **Firefox:** the same recorder/player logic hosted in the sidebar page
     (no offscreen hop; `getUserMedia`/`Audio` run in-page). Playback does not
     survive closing the sidebar on Firefox — document that limitation.

3. **Feature-detect at runtime.** `const hasOffscreen = !!chrome.offscreen;`
   selects the backend; the message protocol (`LISTEN_START`, `REC_*`, …) stays
   identical so `sidepanel.js` / `listen.js` are unchanged.

4. **Build.** Add an npm script that zips with the Firefox manifest swapped in
   (`web-ext` is the conventional tool for signing/running).

5. **QA matrix.** Manually verify in Firefox: dictation (Web Speech + a cloud
   provider), read-selection/read-page shortcuts, Listen playback, streaming STT.

## Effort

Realistically a few focused days plus Firefox QA — the audio-backend
abstraction is the bulk of it. Tracked separately from the current work.

---

## Related: `sidepanel.js` decomposition status

This session extracted the cleanly-separable, now unit-tested pieces out of the
former ~1000-line `sidepanel.js`:

- `lib/voice-rank.js` — Web Speech voice quality ranking (tested)
- `sidepanel/waveform.js` — recording waveform renderer
- `lib/tts-options.js`, `lib/listen-utils.js`, `lib/read-aloud.js`, `lib/lang.js` — shared/pure logic (tested)

**Remaining:** the stateful STT/TTS/settings controller in `sidepanel.js` is the
next split (into `sidepanel/stt.js`, `sidepanel/tts.js`, `sidepanel/settings.js`).
It was deliberately **not** split here because it re-wires many DOM event
listeners and shared state, and there is no automated end-to-end harness to
catch a regression — it should be done alongside manual in-browser QA.
