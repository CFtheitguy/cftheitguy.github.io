"""Step 1: narrate content.json with Piper. Writes narration.wav, segments.json, captions.srt.

usage: python3 tts.py <voice.onnx> <out_dir>
(voice: `pip install piper-tts && python3 -m piper.download_voices en_US-ryan-high`)
"""
import json, sys, wave, io, os
from piper import PiperVoice

HERE = os.path.dirname(os.path.abspath(__file__))
voice = PiperVoice.load(sys.argv[1])
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
scenes = json.load(open(os.path.join(HERE, "content.json")))["scenes"]


def speak(text):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        voice.synthesize_wav(text, w)
    buf.seek(0)
    with wave.open(buf) as w:
        return w.getframerate(), w.readframes(w.getnframes())


# segment = one visual state: scene index + step n within the scene
plan = []
for i, s in enumerate(scenes):
    t = s["type"]
    if t == "intro":
        plan.append(dict(scene=i, n=0, say=s["say"], lead=0.8, tail=0.9))
    elif t == "quiz":
        plan.append(dict(scene=i, n=0, say=s["say"], lead=0.6, tail=3.0))  # thinking time
        plan.append(dict(scene=i, n=1, say=s["answer_say"], lead=0.4, tail=1.0))
    else:
        steps = s.get("items") or s["flags"]
        plan.append(dict(scene=i, n=0, say=s["say"], lead=0.6, tail=s.get("tail", 0.45)))
        for j, it in enumerate(steps, 1):
            plan.append(dict(scene=i, n=j, say=it[2], lead=0.35, tail=0.9 if j == len(steps) else 0.45))
plan[-1]["tail"] = 2.0

pcm, t, rate, srt = b"", 0.0, None, []


def ts(x):
    ms = int(round(x * 1000))
    return "%02d:%02d:%02d,%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)


for k, seg in enumerate(plan):
    rate, audio = speak(seg["say"])
    sil = lambda sec: b"\0\0" * int(rate * sec)
    chunk = sil(seg["lead"]) + audio + sil(seg["tail"])
    seg["start"], seg["dur"] = t, len(chunk) / 2 / rate
    a = t + seg["lead"]
    b = a + len(audio) / 2 / rate
    cap = seg["say"].replace("A.I.", "AI").replace("I.T.", "IT").replace("C E O", "CEO").replace("U S B", "USB").replace("V P N", "VPN")
    srt.append("%d\n%s --> %s\n%s\n" % (k + 1, ts(a), ts(b), cap))
    t += seg["dur"]
    pcm += chunk
    print(k, round(seg["dur"], 2), seg["say"][:50], flush=True)

with wave.open(os.path.join(out, "narration.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm)
json.dump(dict(total=t, segments=plan), open(os.path.join(out, "segments.json"), "w"), indent=1)
open(os.path.join(out, "captions.srt"), "w").write("\n".join(srt))
print("total seconds", round(t, 1))
