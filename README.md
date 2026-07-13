# Briefly — Speech ⇄ Text Chrome Extension

A minimal Chrome side-panel extension for speech-to-text (STT) and text-to-speech (TTS) with pluggable providers, live streaming, theme toggle, retries, and one-click paste into any web page.

> "Briefly" is the working name. Stronger options for the Chrome Web Store listing — pick one:
> **Voxa · Spoke · Talkstrip · Whisperline · Earful · Pipevoice · Castaway · Sayblock · Quill.io**

## Providers

**Speech → Text**

| Provider | Free? | Live streaming | Notes |
|---|---|---|---|
| **Web Speech API** | ✅ free, no key | yes (browser-native) | Chromium-only, requires internet. |
| **On-device (offline)** | ✅ free, no key | yes (browser-native) | Transcribes locally where Chrome ships an on-device model; audio never leaves the device. Falls back gracefully if unavailable. |
| **Groq Whisper** | ✅ generous free tier | no (fast batch) | `whisper-large-v3-turbo`. |
| **Deepgram** | 🆓 free credits | ✅ yes (WebSocket) | `nova-3`. |
| **AssemblyAI** | 🆓 free credits | ✅ yes (Universal v3) | Token-exchanged WS. |
| **OpenAI Whisper** | paid | no | `whisper-1`. |

**Text → Speech**

| Provider | Free? | Voices | Notes |
|---|---|---|---|
| **Web Speech API** | ✅ free, no key | OS voices | Rate / pitch / volume sliders. |
| **Google Translate TTS** | ✅ free, no key | 1 voice per language | Best for short text (auto-chunked at ~190 chars). |
| **Groq TTS (Orpheus)** | ✅ free tier | PlayAI voices | Used in the Listen tab. |
| **Deepgram Aura** | 🆓 free credits | Aura-2 voices | Used in the Listen tab. |
| **ElevenLabs** | paid | premium AI voices | Stability + similarity controls. |
| **OpenAI TTS** | paid | `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` | `tts-1` / `tts-1-hd`. |

## Keyboard shortcuts — use Briefly without opening it

Briefly's fastest path needs **no window at all**. Select text on any page and press a shortcut; the offscreen player reads it aloud through your configured Text→Speech voice (defaults to free Web Speech, zero keys).

| Action | macOS | Windows / Linux |
|---|---|---|
| **Read selected text aloud** | `⌘⇧S` | `Ctrl+Shift+S` |
| **Read the whole page aloud** | `⌘⇧U` | `Ctrl+Shift+U` |
| **Stop reading** | `⌘⇧X` | `Ctrl+Shift+X` |
| **Dictate → clipboard** | `⌘⇧Space` | `Ctrl+Shift+Space` |

**Dictate** is fully hands-off: press it and a **red recording pill** appears on the page (no side panel). Speak, then press again — after a ~1.5 s settle Briefly **inserts the text at your cursor** in whatever field is focused (input, textarea, or contenteditable) **and copies it to the clipboard** as a fallback. Recognition runs on the page via the free Web Speech engine, so the first time you dictate on a site the browser asks for microphone access (click Allow, once per site). Sites that disable the microphone via `Permissions-Policy` aren't supported.

Two options in ⚙ Settings sharpen it toward a Wispr-Flow-style experience:
- **AI cleanup** — runs the raw transcript through Groq (free) / OpenAI to punctuate, strip filler words ("um", "you know"), and fix obvious errors before delivery.
- **Custom vocabulary** — list your names/jargon (e.g. `Kubernetes, Anthropic, AI`); AI cleanup spells them correctly even when misheard, and a literal casing pass applies even without a key.

Rebind any of them at `chrome://extensions/shortcuts` (there's a one-click link in ⚙ Settings). Shortcuts work on any normal web page; they're disabled on browser-internal pages (`chrome://`, the Web Store, etc.).

## Features

- ⌨ **Read-aloud keyboard shortcuts** that work **without opening the panel** — selection, whole page, and stop (see above).
- 🔒 **On-device (offline) STT** — a Web Speech engine that transcribes locally where the browser supports it, so audio never leaves your machine.
- 🌐 **Auto-detect spoken language** for dictation (Whisper, Deepgram, AssemblyAI).
- 🈳 **Localized UI** via `chrome.i18n` (English + Spanish bundled; add a locale by dropping a `_locales/<lang>/messages.json`).
- 🌗 **Light / Dark theme toggle** in the top bar — persists across sessions.
- 🎙 **Live streaming STT** (Deepgram + AssemblyAI v3) — words appear as you speak.
- 🌊 **Live waveform** during recording with pulsing record button.
- ⏹ **Auto-stop on silence** for batch cloud providers (configurable 1.5s–6s).
- 📋 **Auto-copy** transcript to clipboard on completion.
- 🌐 **Translate to English** (uses Groq if available, OpenAI as fallback).
- 📁 **Drag-and-drop audio file** to transcribe existing recordings.
- ↓ **Download** recorded audio + synthesized TTS audio.
- 🕘 **History drawer** — last 50 entries, click to restore.
- ⌨ **Push-to-talk** shortcut: `⌘⇧Space` (Mac) / `Ctrl+Shift+Space` (Win/Linux).
- 🧪 **Test API keys** before saving.
- 🔁 **Retry-with-backoff** on 429/5xx; offline detection.
- 🆓 **Two zero-key TTS options** — Web Speech and Google Translate.
- 🔐 Keys live only in `chrome.storage.local`, only sent to the provider you pick. [Privacy](Briefly/privacy.html).

## Zero-key quickstart

Briefly is fully usable **without any API key**:

1. **STT:** select **Web Speech API** in the side panel.
2. **TTS:** select **Web Speech** or **Google Translate**.

Add provider keys later only if you want premium voices, cloud STT, or live streaming.

## Load

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked**, select the `Briefly/` folder.
3. Pin the extension; click its icon to open the side panel.
4. Open ⚙ **Settings** and paste any provider API keys you want to use.
5. Press `⌘⇧Space` from anywhere to start/stop recording.

## Build

```
npm run build   # produces dist/briefly.zip
```

## Test

Pure logic (providers, storage, LLM parsing, WAV encoder, TTS option builder, page-type detection, language helpers) is covered by a zero-dependency suite on Node's built-in test runner:

```
npm test        # node --test
```

## Architecture

```
Briefly/
├── manifest.json                     MV3 — sidepanel + offscreen + scripting + commands
├── _locales/{en,es}/messages.json    chrome.i18n UI strings
├── privacy.html                      Chrome Web Store privacy policy
├── background/service_worker.js      Offscreen doc mgmt + headless read-aloud shortcuts
├── offscreen/
│   ├── offscreen.html
│   ├── recorder.js                   MediaRecorder + WebSocket streaming + AudioWorklet PCM
│   └── player.js                     Listen queue player + episode export
├── sidepanel/
│   ├── sidepanel.html / .css / .js   Three tabs (STT, TTS, Listen), settings, history
│   └── listen.js                     Read-page + AI modes
└── lib/
    ├── storage.js                    Settings + keys + history
    ├── providers.js                  All provider adapters + rfetch (retry)
    ├── tts-options.js                Provider TTS options (shared: listen + shortcuts)
    ├── listen-utils.js               Page-type detection + batching (pure)
    ├── lang.js                       STT language list + auto-detect helpers
    ├── wav.js                        PCM→WAV encoder for episode export
    ├── i18n.js                       data-i18n applier
    └── audio-cache.js                Persistent IndexedDB TTS cache

tests/                                node --test unit suite (no deps)
store-assets/                         Hero SVG + screenshot guide + GIF script
```

## Security & privacy

- **Keys** live only in `chrome.storage.local` and are sent only to the provider you pick.
- **CSP `connect-src` allowlist** — extension pages may only open network/WebSocket connections to the specific provider hosts (see `manifest.json`); anything else is blocked by the browser, so a compromised dependency can't exfiltrate to an arbitrary host.
- **No wildcard trust** — the only broad grant is `optional_host_permissions: https://*/*`, requested **per-origin at read time** with your consent (used by Listen to read the current page). `http://` was dropped.
- **No third-party audio relays** — every TTS/STT host is a first-party API you authenticate to directly. (The unauthenticated `freetts.org` relay was removed.)
- **On-device STT** keeps audio on your machine entirely.

## Browser support
**Chrome / Edge (Chromium):** full support via the `sidePanel` API.
**Firefox:** not yet — Firefox doesn't implement MV3 `sidePanel`. A separate Firefox build with a popup fallback is on the roadmap.

## Known limits
- Groq has **no streaming STT** — it's batch only (but fast enough that auto-stop-on-silence feels near-live).
- OpenAI new projects need explicit Whisper access (Settings → Limits in your OpenAI dashboard) or your request will 403.
- Web Speech API works only in Chromium and requires internet (it routes through Google).
