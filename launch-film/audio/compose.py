# Orlo launch theme: an original 127 BPM electronic track, synthesized from scratch onto the film's beat grid.
# Writes audio/music.wav (48 kHz stereo). build.py then lays the SFX on top and masters.
# F minor, Fm - Db - Ab - Eb, resolving to Ab major on the end card. No gaps: the build runs straight into the drop.
import numpy as np
from pathlib import Path
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 48000
LEN = 28.0
N = int(SR * (LEN + 3))  # room for tails, trimmed at the end
B = lambda k: 0.0162 + 0.47242 * k  # same grid as index.html: drop on B(32), end card on B(54)
BEAT = 0.47242
rng = np.random.default_rng(7)
T = np.arange(N) / SR

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def lp(x, f, o=2): return sosfilt(butter(o, f, "low", fs=SR, output="sos"), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, "high", fs=SR, output="sos"), x)
def bp(x, a, b, o=2): return sosfilt(butter(o, [a, b], "band", fs=SR, output="sos"), x)
def env(points): return np.interp(T, [p[0] for p in points], [p[1] for p in points])
def saw(f, t, ph=0.0): return 2 * ((f * t + ph) % 1.0) - 1
def place(bus, sig, t0, gain=1.0):
    i = int(round(t0 * SR))
    if i >= N: return
    sig = sig if sig.ndim == 2 else np.stack([sig, sig])
    n = min(sig.shape[1], N - i)
    bus[:, i:i + n] += gain * sig[:, :n]

# ---- harmony: one chord per bar of 4 beats ----
CH = {
    "Fm": ([53, 56, 60, 65], 41),
    "Db": ([53, 56, 61, 65], 37),
    "Ab": ([51, 56, 60, 63], 44),
    "Eb": ([51, 55, 58, 63], 39),
    "AbEnd": ([56, 60, 63, 70, 72], 32),
}
PROG = ["Fm", "Db", "Ab", "Eb"]
def chord_at(k):
    if k >= 54: return "AbEnd"
    if k >= 52: return "Eb"
    return PROG[int(k // 4) % 4]

# ---- drums ----
def kick(big=False):
    n = int(SR * (0.9 if big else 0.42)); t = np.arange(n) / SR
    f = 46 + 120 * np.exp(-t * 32)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * (3.2 if big else 6.5))
    click = hp(rng.standard_normal(n), 3000) * np.exp(-t * 400) * 0.25
    return np.tanh(1.6 * (body + click))

def clap():
    n = int(SR * 0.35); t = np.arange(n) / SR
    noise = bp(rng.standard_normal(n), 900, 4200)
    e = sum(np.exp(-np.clip(t - d, 0, None) * (25 if d < 0.02 else 13)) * (t >= d) for d in (0, 0.009, 0.019))
    return noise * e * 0.6

def hat(open_=False):
    n = int(SR * (0.22 if open_ else 0.05)); t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7500, 4) * np.exp(-t * (14 if open_ else 70))

def snare():
    n = int(SR * 0.18); t = np.arange(n) / SR
    return (bp(rng.standard_normal(n), 250, 6000) * 0.8 + np.sin(2 * np.pi * 190 * t) * 0.5) * np.exp(-t * 28)

def crash(d=2.2):
    n = int(SR * d); t = np.arange(n) / SR
    s = np.stack([hp(rng.standard_normal(n), 4500), hp(rng.standard_normal(n), 4500)])
    return s * np.exp(-t * 2.2) * 0.5

# ---- synths ----
SPREAD = np.linspace(-1, 1, 7)
def supersaw(notes, dur, attack=0.01, release=0.25):
    n = int(SR * (dur + release)); t = np.arange(n) / SR
    out = np.zeros((2, n))
    for m in notes:
        for v in SPREAD:
            s = saw(hz(m + 0.16 * v), t, rng.random())
            out[0] += s * (1 - v) / 2
            out[1] += s * (1 + v) / 2
    e = np.minimum(1, t / attack) * np.where(t < dur, 1, np.exp(-(t - dur) / (release / 4)))
    return out * e / (len(notes) * 3.5)

def pluck(m, dur=0.16, bright=30):
    n = int(SR * (dur + 0.05)); t = np.arange(n) / SR
    f = hz(m)
    return (saw(f, t) * np.exp(-t * bright) + 0.7 * np.sin(2 * np.pi * f * t)) * np.exp(-t / dur * 3)

def lead_note(m, dur):
    n = int(SR * (dur + 0.12)); t = np.arange(n) / SR
    f = hz(m) * (1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.minimum(1, t / 0.15))
    ph = np.cumsum(f) / SR
    s = (2 * (ph % 1) - 1) * 0.6 + (2 * ((ph * 1.006) % 1) - 1) * 0.4
    return lp(s, 7000) * np.minimum(1, t / 0.006) * np.where(t < dur, 1, np.exp(-(t - dur) * 40))

def bass_note(m, dur):
    n = int(SR * (dur + 0.03)); t = np.arange(n) / SR
    f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.35 * lp(saw(f, t), 420)
    return s * np.minimum(1, t / 0.004) * np.where(t < dur, 1, np.exp(-(t - dur) * 120))

# ---- buses ----
drums, chords, stabs, arp, lead, bass, fx = (np.zeros((2, N)) for _ in range(7))

# kick on every beat from Enter (k11) to the end card, except the last beat before the drop, which belongs to the roll
KICKS = [k for k in range(11, 54) if k not in (31, 32)]
for k in KICKS: place(drums, kick(), B(k), 0.78 if k < 32 else 1.0)  # the drop is louder than everything before it
for k in range(4, 11): place(drums, lp(kick(), 180), B(k), 0.45)  # a muffled pulse under the typing
for k in (32, 54): place(drums, kick(big=True), B(k), 1.0)  # the drop and the end card hit harder
place(drums, kick(big=True), B(0), 0.8)  # the cold open hit under the mascot
for k in range(13, 54, 2):
    if 24 <= k < 32: continue  # the roll owns the build
    place(drums, clap(), B(k), 0.45 if k < 32 else 0.8)
for k in np.arange(4.5, 54, 1.0):
    place(drums, hat(open_=k >= 32), B(k), 0.10 if k < 11 else 0.14 if k < 32 else 0.22)
for k in np.arange(32, 46, 0.25):  # 16th hats drive the drop
    if k % 1: place(drums, hat(), B(k), 0.11)
    place(drums, hp(hat(), 5000) * 0.6, B(k) + 0.01, 0.08)  # shaker on every 16th

# build k24-32: snare roll from quarters to 32nds, rising, straight into the drop
roll = [*np.arange(24, 28, 1), *np.arange(28, 30, 0.5), *np.arange(30, 31, 0.25), *np.arange(31, 32, 0.125)]
for k in roll: place(drums, snare(), B(k), 0.18 + 0.5 * ((k - 24) / 8) ** 2)
for k in (32, 40, 54): place(fx, crash(3.0 if k == 54 else 2.2), B(k), 0.55)

# riser: noise swell and a climbing saw over the build, peaking on the drop frame
n = int(SR * (B(32) - B(24))); t = np.arange(n) / SR; p = t / t[-1]
noise = rng.standard_normal(n)
swell = (hp(noise, 600) * 0.5 + hp(noise, 3000)) * p ** 2.5 * 0.35
climb = saw(1, np.cumsum(np.ones(n) * (180 * 2 ** (p * 2.2))) / SR) * p ** 2 * 0.06
place(fx, swell + lp(climb, 5000), B(24))
# downlifter as the board shrinks away (k46-48): the energy falls, the sound does not stop
n = int(SR * (B(48) - B(46))); t = np.arange(n) / SR; p = t / t[-1]
fall = np.sin(2 * np.pi * np.cumsum(380 * 2 ** (-p * 2.6)) / SR) * (1 - p) ** 1.5 * 0.18 + lp(rng.standard_normal(n), 2500) * (1 - p) ** 2 * 0.25
place(fx, fall, B(46))

# chords: a continuous pad, re-voiced every bar
for bar in range(14):
    k = bar * 4
    name = chord_at(k)
    if k >= 54: break
    end = min(k + 4, 54)
    place(chords, supersaw(CH[name][0], B(end) - B(k) + 0.02, attack=0.02 if k else 0.4, release=0.05), B(k))
place(chords, supersaw(CH["AbEnd"][0], 1.6, attack=0.005, release=2.0) * 1.3, B(54))
place(chords, supersaw([m + 12 for m in CH["AbEnd"][0]], 1.2, attack=0.005, release=1.6) * 0.6, B(54))
# word hits: bright stabs on Delegate. Review. Done. and the full line
for k in (48, 49, 50, 52):
    place(stabs, supersaw([m + 12 for m in CH[chord_at(k)][0]], 0.22, attack=0.003, release=0.3), B(k), 0.9 if k < 52 else 1.1)

# arp: 16ths over the chord tones an octave up, from the README line to the end card's tail
PAT = [0, 1, 2, 3, 2, 1, 3, 2]
for i, k in enumerate(np.arange(1, 60, 0.25)):
    if B(k) > LEN: break
    v = CH[chord_at(k)][0]
    m = v[PAT[i % 8] % len(v)] + 12
    place(arp, pluck(m, bright=55 if k < 11 else 30), B(k), 0.5 + 0.5 * (k % 1 == 0))

# lead hook on the drop
MOTIF = {
    "Fm": [(0, 72, .5), (.5, 75, .5), (1, 77, .75), (2, 75, .5), (2.5, 72, .5), (3, 68, .5), (3.5, 72, .5)],
    "Db": [(0, 77, 1), (1, 75, .5), (1.5, 73, .5), (2, 72, 1), (3, 68, .5), (3.5, 70, .5)],
    "Ab": [(0, 72, .5), (.5, 75, .5), (1, 79, .75), (2, 77, .5), (2.5, 75, .5), (3, 72, 1)],
    "Eb": [(0, 70, .5), (.5, 72, .5), (1, 75, 1), (2, 79, .5), (2.5, 77, .5), (3, 75, .5), (3.5, 70, .5)],
}
for bar in range(8, 12):
    for off, m, d in MOTIF[PROG[bar % 4]]:
        k = bar * 4 + off
        if k >= 46: break
        place(lead, lead_note(m, d * BEAT * 0.92), B(k))
# dotted-eighth echo, panned, for width
echo = int(SR * BEAT * 0.75)
lead[0, echo:] += 0.35 * lead[1, :-echo]
lead[1, 2 * echo:] += 0.2 * lead[0, :-2 * echo]

# bass: offbeat pumps before the drop, driving 8ths on it, a long low note on the end card
for k in np.arange(11.5, 54, 0.5):
    if k < 32 and k % 1 == 0: continue
    if 46 <= k < 48: continue
    place(bass, bass_note(CH[chord_at(k)][1], BEAT * 0.42), B(k), 0.85 if k >= 32 else 0.7)
tail = bass_note(CH["AbEnd"][1] + 12, 2.0)
place(bass, tail * np.exp(-np.arange(len(tail)) / SR * 1.2), B(54), 1.0)

# sub: a pure sine under the drop and the words, the weight a launch drop needs
for bar in range(8, 14):
    k = bar * 4
    for a, b in ((32, 46), (48, 54)):
        lo, hi = max(k, a), min(k + 4, b)
        if lo >= hi: continue
        m = CH[chord_at(lo)][1]
        while m > 40: m -= 12
        d = B(hi) - B(lo); t = np.arange(int(SR * d)) / SR
        place(bass, np.sin(2 * np.pi * hz(m) * t) * np.minimum(1, np.minimum(t, d - t) / 0.01) * 0.7, B(lo))

# ---- sidechain: everything melodic ducks under each kick ----
sc = np.ones(N)
for k in KICKS + [0, 32, 54]:
    i = int(B(k) * SR); n = int(SR * BEAT); t = np.arange(min(n, N - i)) / SR
    sc[i:i + len(t)] = np.minimum(sc[i:i + len(t)], 1 - 0.62 * np.exp(-t / 0.11))

# ---- arrangement: section levels and the filter opening ----
# dark (lowpassed) pad before the drop, opening over the build, fully bright on the drop
bright = env([(0, 0.0), (B(11), 0.15), (B(24), 0.2), (B(32), 1.0), (B(46), 1.0), (B(48), 0.25), (B(54), 1.0), (31, 1.0)])
chords = lp(chords, 900) * (1 - bright) + lp(chords, 12000) * bright
chords *= env([(0, 0.0), (B(0), 0.95), (B(11), 0.6), (B(31.9), 0.65), (B(32), 0.95), (B(46), 0.95), (B(48), 0.6), (B(54), 0.95), (31, 0.95)])
arp_g = env([(0, 0), (B(1), 0.0), (B(2), 0.45), (B(11), 0.3), (B(24), 0.36), (B(32), 0.2), (B(46), 0.18), (B(54), 0.2), (LEN - 0.3, 0.0), (31, 0)])
arp = lp(arp, 6000) * arp_g
chords *= sc; arp *= 0.4 + 0.6 * sc; bass *= sc * 0.9; lead *= 0.32 * (0.55 + 0.45 * sc); stabs *= 0.8

# ---- space ----
def reverb(x, secs=2.2, wet=0.25):
    n = int(SR * secs); t = np.arange(n) / SR
    ir = np.stack([lp(rng.standard_normal(n), 7000), lp(rng.standard_normal(n), 7000)]) * np.exp(-t * 3.0 / secs)
    ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    return np.stack([fftconvolve(x[c], ir[c])[:N] for c in range(2)]) * wet
send = chords * 0.6 + arp + lead + stabs + drums * 0.08
mix = drums + chords + stabs + arp + lead + bass + fx + reverb(send)
# the harmony and melody alone (no drums, no bass): the guide generate.py conditions MusicGen on
guide = (chords + stabs + arp + lead)[:, :int(SR * LEN)]
wavfile.write(Path(__file__).parent / "guide.wav", SR, (guide / np.abs(guide).max() * 0.9).T.astype(np.float32))
mix = hp(mix, 28)
mix *= env([(0, 1.6), (B(10.5), 1.6), (B(11), 1.0), (31, 1.0)])  # the intro sits ~7 dB under the groove, not 11
mix += 0.8 * hp(mix, 4500)  # high shelf: the air a modern electronic master has

# glue: gentle bus saturation, then tidy the last frames so the end card's tail lands at 28 s
mix = np.tanh(mix * 0.9) / 0.9
mix = mix[:, :int(SR * LEN)]
mix[:, -int(SR * 0.25):] *= np.linspace(1, 0, int(SR * 0.25)) ** 2
mix /= np.abs(mix).max() / 0.9
wavfile.write(Path(__file__).parent / "music.wav", SR, mix.T.astype(np.float32))
print("wrote music.wav", mix.shape)
