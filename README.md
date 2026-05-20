# Briefly — Speech ⇄ Text Chrome Extension

A minimal Chrome side-panel extension for speech-to-text (STT) and text-to-speech (TTS) with pluggable providers, live streaming, theme toggle, retries, and one-click paste into any web page.

> "Briefly" is the working name. Stronger options for the Chrome Web Store listing — pick one:
> **Voxa · Spoke · Talkstrip · Whisperline · Earful · Pipevoice · Castaway · Sayblock · Quill.io**

## Providers

**Speech → Text**

| Provider | Free? | Live streaming | Notes |
|---|---|---|---|
| **Web Speech API** | ✅ free, no key | yes (browser-native) | Chromium-only, requires internet. |
| **Groq Whisper** | ✅ generous free tier | no (fast batch) | `whisper-large-v3-turbo`. |
| **Deepgram** | 🆓 free credits | ✅ yes (WebSocket) | `nova-3`. |
| **AssemblyAI** | 🆓 free credits | ✅ yes (Universal v3) | Token-exchanged WS. |
| **OpenAI Whisper** | paid | no | `whisper-1`. |

**Text → Speech**

| Provider | Free? | Voices | Notes |
|---|---|---|---|
| **Web Speech API** | ✅ free, no key | OS voices | Rate / pitch / volume sliders. |
| **StreamElements** | ✅ free, no key | 20+ Polly-backed voices | EN, FR, DE, ES, HI, JA, AU, IN accents. Auto-chunks long text. |
| **Google Translate TTS** | ✅ free, no key | 1 voice per language | Best for short text (auto-chunked at ~190 chars). |
| **ElevenLabs** | paid | premium AI voices | Stability + similarity controls. |
| **OpenAI TTS** | paid | `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` | `tts-1` / `tts-1-hd`. |

## Features

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
- 🆓 **Three zero-key TTS options** — Web Speech, StreamElements, Google Translate.
- 🔐 Keys live only in `chrome.storage.local`, only sent to the provider you pick. [Privacy](Briefly/privacy.html).

## Zero-key quickstart

Briefly is fully usable **without any API key**:

1. **STT:** select **Web Speech API** in the side panel.
2. **TTS:** select **Web Speech**, **StreamElements**, or **Google Translate**.

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

## Architecture

```
Briefly/
├── manifest.json                     MV3 — sidepanel + offscreen + scripting
├── privacy.html                      Chrome Web Store privacy policy
├── background/service_worker.js      Manages offscreen doc + push-to-talk
├── offscreen/
│   ├── offscreen.html
│   └── recorder.js                   MediaRecorder + WebSocket streaming + AudioWorklet PCM
├── sidepanel/
│   ├── sidepanel.html / .css / .js   Two tabs (STT, TTS), settings, history
└── lib/
    ├── storage.js                    Settings + keys + history
    └── providers.js                  All provider adapters + rfetch (retry)

store-assets/                         Hero SVG + screenshot guide + GIF script
```

## Browser support
**Chrome / Edge (Chromium):** full support via the `sidePanel` API.
**Firefox:** not yet — Firefox doesn't implement MV3 `sidePanel`. A separate Firefox build with a popup fallback is on the roadmap.

## Known limits
- Groq has **no streaming STT** — it's batch only (but fast enough that auto-stop-on-silence feels near-live).
- OpenAI new projects need explicit Whisper access (Settings → Limits in your OpenAI dashboard) or your request will 403.
- Web Speech API works only in Chromium and requires internet (it routes through Google).
