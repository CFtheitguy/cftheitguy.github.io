# cftheitguy.github.io

- `docs/ivr-script.md` — Friendly, professional phone IVR greeting and after-hours script.
- `noise/` — **Linear Noise**, a browser noise machine (linearit.co/noise). Twelve sounds — white/pink/brown noise, rain, thunder, wind, ocean, stream, campfire, crickets, fan and a drone — all synthesised live with the Web Audio API, so there are no audio files in the repo. Mixer, presets, sleep timer with fade-out, mixes saved to `localStorage` and shareable via URL hash. No backend.
- `typing/` — **Linear Type**, a browser typing tutor (linearit.co/typing). 31 lessons, timed tests and weak-key drills; progress is kept in `localStorage`, with no account or backend.
- `time/` — **Linear Time**, an installable time-tracking PWA (time.linearit.co). Setup + rollout guide in [`time/README.md`](time/README.md); Cloudflare Worker + D1 backend in [`time-worker/`](time-worker/README.md).
- `board/` — **Linear Board**, a whiteboard two people can share with a link (board.linearit.co). No signup; boards delete themselves 24 hours after the last change. App notes in [`board/README.md`](board/README.md); Cloudflare Worker + Durable Object relay in [`board-worker/`](board-worker/README.md).
