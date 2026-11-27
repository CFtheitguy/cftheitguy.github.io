#!/usr/bin/env bash
# Build a narrated training video (voice-over + background music + captions) from a content.json.
# usage: build.sh <content.json> <output.mp4>
# needs: python3 (numpy), node with playwright + chromium, ffmpeg. Installs piper-tts and the voice if missing.
set -euo pipefail
KIT=$(cd "$(dirname "$0")" && pwd)
CONTENT=$(realpath "$1"); OUT=$(realpath -m "$2")
WORK=${WORK:-$(mktemp -d)}
VOICE_DIR=${VOICE_DIR:-$HOME/.cache/video-kit}; VOICE=en_US-ryan-high
MUSIC_VOLUME=${MUSIC_VOLUME:-0.2}

python3 -c "import piper" 2>/dev/null || pip install -q piper-tts
mkdir -p "$VOICE_DIR" "$WORK"
[ -f "$VOICE_DIR/$VOICE.onnx" ] || (cd "$VOICE_DIR" && python3 -m piper.download_voices "$VOICE")

python3 "$KIT/tts.py" "$VOICE_DIR/$VOICE.onnx" "$CONTENT" "$WORK"
rm -rf "$WORK/frames"
node "$KIT/render.js" "$CONTENT" "$WORK"
python3 "$KIT/music.py" "$WORK/music.wav"

DUR=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['total'])" "$WORK/segments.json")
FADE=$(python3 -c "print($DUR - 2.5)")
# music loops under the voice and ducks while the narrator is speaking
ffmpeg -v error -y -f concat -safe 0 -i "$WORK/frames.txt" -i "$WORK/narration.wav" -stream_loop -1 -i "$WORK/music.wav" \
  -filter_complex "[0:v]fps=30,format=yuv420p[v];\
[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,asplit[vo][sc];\
[2:a]aresample=48000,volume=$MUSIC_VOLUME,afade=t=in:d=2[m];\
[m][sc]sidechaincompress=threshold=0.02:ratio=5:attack=150:release=1200[md];\
[vo][md]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=$FADE:d=2.5[a]" \
  -map "[v]" -map "[a]" -t "$DUR" -c:v libx264 -preset slow -crf 20 -c:a aac -b:a 160k -movflags +faststart "$OUT"
cp "$WORK/captions.srt" "${OUT%.mp4}.srt"
echo "built $OUT ($DUR s)"
