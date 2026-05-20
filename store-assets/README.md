# Briefly — Chrome Web Store assets

## Hero image (1280 × 800)
- `hero.svg` — vector source. Open in Figma/Pixelmator/browser, export PNG at 1280×800.
- Quick CLI export (needs `librsvg`):
  ```
  brew install librsvg
  rsvg-convert hero.svg -w 1280 -h 800 -o hero.png
  ```

## Screenshots (1280 × 800 or 640 × 400, up to 5)
Take live screenshots of the running extension:

| # | What to capture | How |
|---|---|---|
| 1 | STT live-streaming with waveform mid-speech | Provider = Deepgram, Live ✓, speak a sentence |
| 2 | TTS panel with ElevenLabs voice + sliders | Pick any voice, type "Hello from Briefly", show audio player |
| 3 | Settings modal with all 5 key fields | Click ⚙, position window at 1280px |
| 4 | History drawer with 3-4 entries | After using both STT + TTS, open the drawer |
| 5 | Drop-zone + transcript with translated `[EN]` segment | Drop a Spanish audio file, hit Translate |

Resize each PNG to 1280×800 (pad with the same `#0f1115` background if needed).

## Promo tile (small: 440 × 280; large: 920 × 680)
Optional. Reuse cropped sections of `hero.svg`.

## Demo GIF (30 sec, README only)
Suggested script:
1. (0–3s) Click toolbar icon → side panel slides in
2. (3–10s) STT tab, Web Speech → record yourself saying "Schedule a meeting at 3 PM tomorrow" → text appears live
3. (10–18s) Switch to Deepgram + Live toggle → record same → words appear word-by-word
4. (18–24s) Hit "Send to tab" → cut to a Gmail compose window → text pastes
5. (24–30s) Switch to TTS tab → paste "Done." → ElevenLabs voice speaks → fade

Record at 720p using QuickTime → convert with `ffmpeg`:
```
ffmpeg -i demo.mov -vf "fps=15,scale=900:-1:flags=lanczos" -loop 0 demo.gif
```
