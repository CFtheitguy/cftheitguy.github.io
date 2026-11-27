# Training video kit

Builds a narrated 1080p training video (voice-over, background music, captions, Linear logos) from one JSON script.

```
cybersecurity/video-kit/build.sh <content.json> <output.mp4>
```

Needs `python3` with numpy, `node` with Playwright + Chromium, and `ffmpeg`. The script installs `piper-tts` and downloads the voice on first run. It writes the `.mp4` and a matching `.srt`.

## content.json

`footer` is the label next to the logo. `scenes` play in order; each has a `type`:

| type | fields |
|---|---|
| `intro` | `kicker`, `title`, `subtitle`, `say` |
| `bullets` | `kicker`, `title`, `say`, `items`: `[on-screen line, smaller line, spoken text]` (3–5 items) |
| `email` | `kicker`, `title`, `say`, `email` {name, addr, subject, greeting, body, button, link, attach}, `flags`: `[target, label, spoken text]` where target is `from`, `subject`, `greeting`, `link`, `attach` or `""` |
| `quiz` | `kicker`, `title`, `question`, `options` (3), `answer` (index), `explain`, `say`, `answer_say` |
| `outro` | `kicker`, `title`, `say`, `items`: `[one word, short line, spoken text]` (4 items) |

`say` text is written for the ear: spell out acronyms the voice should read letter by letter (`P H I`, `I.T.`, `A.I.`) and write numbers as words. `tts.py` has a `CAPTION_FIXES` list that turns those spellings back into normal text for the captions.

See `../awareness-video/content.json` and `../hipaa-video/content.json` for complete examples.
