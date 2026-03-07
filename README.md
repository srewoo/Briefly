# Productify — Chrome Extension

> **Voice-powered AI assistant that converts speech to structured text, prompts, and actions — directly in your browser.**

---

## Features

| Feature | Details |
|---------|---------|
| 🎙️ Push-to-Talk + Toggle | Hold `Space` or click mic to record |
| 🤖 Browser-Only STT | OpenAI Whisper / GPT‑4o transcribe, Google STT, or ElevenLabs — all called directly from the extension |
| 🧠 12 Intents | Summarize, Prompt Gen, Tasks, Docs, Testing, Code Review, User Story, Explain, Translate, Email, Compare, Custom |
| 📄 Full Context | Extracts: selection, code blocks, headings, structured data, forms, domain detection |
| ⚡ GPT‑4o Output | Generates structured output (prompts, specs, tasks, docs) directly from the browser |
| 🌙 Dark/Light Theme | Glassmorphism design, smooth theme toggle |
| 📜 History | Last 50 outputs stored locally, searchable |
| ⭐ Prompt Library | Save, tag, search, and star reusable prompts |
| 🔗 Integrations | Notion, GitHub, Jira, Linear, Slack, Webhook (optional, all from the extension) |
| ↩️ Refine | Follow-up voice or text command to iterate on output |
| 🔑 BYOK | All API keys encrypted with AES-256-GCM on your device |

---

## Getting Started

### 1. Load the Extension

```bash
# Open Chrome → chrome://extensions
# Enable Developer Mode (toggle top-right)
# Click "Load unpacked"
# Select: /path/to/productify/productify/
```

### 2. Configure API Keys

On first launch, the onboarding flow will guide you through:
1. Granting microphone permission
2. Adding your **OpenAI API key** (required — for Whisper + GPT-4o)
3. Optionally adding a **Google STT** key as an alternative provider
4. Optionally adding an **ElevenLabs** key for their STT

Or go to **Settings** in the side panel at any time.

---

## Project Structure

```
productify/                 ← Chrome Extension (load unpacked from here)
├── manifest.json            ← MV3 manifest
├── icons/                   ← Extension icons (16, 32, 48, 128)
├── sidepanel/               ← Main UI
│   ├── sidepanel.html/.js/.css
├── background/
│   ├── service_worker.js    ← Message router + API orchestrator
│   ├── intentClassifier.js  ← Local keyword pre-classifier  
│   └── outputRouter.js      ← Integration dispatch (7 services)
├── content/
│   └── contentScript.js     ← Page context extraction (10 signals)
├── offscreen/
│   └── audioProcessor.js    ← Mic capture + waveform via Web Audio API
├── lib/
│   ├── storage.js / crypto.js / markdown.js / i18n.js
├── styles/
│   ├── design-tokens.css / animations.css / themes.css
└── onboarding/              ← First-run 6-step tutorial

serverBKP/                   ← (Optional / legacy) Node.js backend used in early versions.  
                             Not required for the extension to work; all AI calls now happen in the browser.
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘⇧P` | Open/close side panel |
| `⌘⇧Space` | Push-to-talk record |
| `Space` (hold, in panel) | Push-to-talk |
| `⌘⇧C` | Copy last output |
| `⌘⇧H` | Toggle history |
| `Esc` | Cancel recording |

---

## Supported Integrations

Connect via **Settings → Integrations**:

- **Notion** — Append to pages
- **GitHub** — Create issues
- **Jira** — Create/update tickets
- **Linear** — Create issues (GraphQL API)
- **Slack** — Post via Incoming Webhooks
- **Confluence** — Append to pages
- **Custom Webhook** — POST to any endpoint

---

## Security & Privacy

- **BYOK model** — You supply your own API keys
- **AES-256-GCM encryption** — Keys encrypted at rest in `chrome.storage.local`
- **Zero audio retention** — Audio blob destroyed immediately after transcription
- **Minimal permissions** — `activeTab`, `sidePanel`, `storage`, `offscreen` only
- **No analytics** — No usage data sent to any server

---

## Development

```bash
# Extension: just reload unpacked in chrome://extensions after changes
# (No build step needed — all logic runs in the browser)
```

---

## Roadmap

**v1.0 (current)** — Full local + cloud pipeline  
**v2.0** — Team shared library, wake word ("Hey Pilot"), cloud sync, analytics

---

*Built with ❤️ as a full-featured v1.0 product — not an MVP.*
