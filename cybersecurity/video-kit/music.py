"""Synthesize a calm, royalty-free ambient background loop (original, generated from scratch).

usage: python3 music.py <out.wav>
Writes a seamless 32-second stereo loop: a slow pad over Am - F - C - G with soft bell notes.
"""
import sys, wave
import numpy as np

SR, BAR, CHORDS = 44100, 8.0, [
    [110.00, 164.81, 220.00, 261.63, 329.63],   # A minor
    [87.31, 130.81, 220.00, 261.63, 349.23],    # F major
    [130.81, 196.00, 261.63, 329.63, 392.00],   # C major
    [98.00, 146.83, 246.94, 293.66, 392.00],    # G major
]
N = int(SR * BAR * len(CHORDS))
t = np.arange(N) / SR
L, R = np.zeros(N), np.zeros(N)


def add(sig_l, sig_r, start, env):
    """Mix a note into the loop, wrapping around the end so the loop is seamless."""
    idx = (int(start * SR) + np.arange(len(env))) % N
    np.add.at(L, idx, sig_l * env)
    np.add.at(R, idx, sig_r * env)


# pad: each chord swells in and out, overlapping its neighbours
dur = BAR + 3.0
n = int(SR * dur)
tt = np.arange(n) / SR
env = np.sin(np.pi * np.clip(tt / dur, 0, 1)) ** 1.5
for c, chord in enumerate(CHORDS):
    for k, f in enumerate(chord):
        amp = 0.5 / (1 + k * 0.35)
        trem = 1 + 0.08 * np.sin(2 * np.pi * (0.11 + 0.03 * k) * tt)
        voice = lambda d: (np.sin(2 * np.pi * f * d * tt) + 0.22 * np.sin(2 * np.pi * 2 * f * d * tt)
                           + 0.08 * np.sin(2 * np.pi * 3 * f * d * tt)) * amp * trem
        add(voice(1.0015), voice(0.9985), c * BAR - 1.5, env)

# bells: one soft, decaying chord tone every two seconds
rng = np.random.default_rng(7)
bn = int(SR * 3.5)
bt = np.arange(bn) / SR
benv = np.exp(-bt * 1.6) * np.clip(bt / 0.02, 0, 1)
for i in range(int(BAR * len(CHORDS) / 2)):
    chord = CHORDS[int(i * 2 // BAR)]
    f = chord[rng.integers(2, 5)] * 2
    pan = rng.uniform(0.25, 0.75)
    tone = (np.sin(2 * np.pi * f * bt) + 0.3 * np.sin(2 * np.pi * 2.01 * f * bt)) * 0.16
    add(tone * (1 - pan), tone * pan, i * 2 + 0.5 + rng.uniform(-0.15, 0.15), benv)

mix = np.stack([L, R], axis=1)
mix = mix / np.abs(mix).max() * 0.7
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
