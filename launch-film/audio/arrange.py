# Cuts one generated take (audio/candidates/free-*.wav) to the picture, the way a music editor cuts a library track:
# lock it to the film's 127 BPM grid, loop its 8 bars, and shape the arc with filter and edit moves —
# muffled intro, opening on Enter, low end pulled out through the build with a reverse swell made from the drop
# itself, the full track slamming in on the drop, filtered word hits, and the downbeat landing on the end card.
# Usage: python audio/arrange.py free-drop-1   ->  audio/music.wav
import subprocess, sys, tempfile
import numpy as np
from pathlib import Path
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, sosfilt_zi
from beats import kicks, fit

HERE = Path(__file__).parent
SR, LEN = 48000, 28.0
BEAT, T0 = 0.47242, 0.0162
def B(k): return T0 + BEAT * k
LOOP = 32  # beats: 8 bars

take = HERE / "candidates" / f"{sys.argv[1]}.wav"
bpm = fit(kicks(str(take)))[0]
with tempfile.TemporaryDirectory() as d:
    out = Path(d) / "locked.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(take), "-af", f"rubberband=tempo={60 / BEAT / bpm:.6f},aresample={SR}",
                    "-c:a", "pcm_f32le", str(out)], check=True)
    _, src = wavfile.read(out)
src = src.T.astype(np.float64)

# phase: the offset whose beat grid collects the most low-end onset energy
low = sosfilt(butter(4, 120, "low", fs=SR, output="sos"), src.mean(0))
env = np.abs(low)
flux = np.maximum(0, np.diff(np.convolve(env, np.ones(240) / 240, "same"), prepend=0))
offs = np.arange(0, int(BEAT * SR), 48)
grid = lambda o: np.arange(o, len(flux) - 1, BEAT * SR).astype(int)
phase = offs[np.argmax([flux[grid(o)].sum() for o in offs])] / SR
start = phase + BEAT * np.ceil((0.25 - phase) / BEAT)  # first beat after the take settles: source beat 0
assert start + LOOP * BEAT <= src.shape[1] / SR, "take too short for an 8-bar loop"
print(f"{take.name}: {bpm:.2f} BPM -> 127.0, loop starts {start:.3f}s")

# map film time to source time: film beat k plays source beat k mod 32, so the drop (k=32) and the
# end card (k=54, re-anchored) both land on the loop's downbeat
t = np.arange(int(SR * LEN)) / SR
k = (t - T0) / BEAT
srcbeat = np.where(k >= 54, k - 54, np.mod(k, LOOP))
idx = np.clip(((start + srcbeat * BEAT) * SR).astype(int), 0, src.shape[1] - 1)
music = src[:, idx]
for w in (32, 54):  # an 8 ms dip either side of each jump, so the cut never clicks; the downbeat after it covers it
    i = int(B(w) * SR); n = int(0.008 * SR)
    music[:, i - n:i] *= np.linspace(1, 0, n)
    music[:, i:i + n] *= np.linspace(0, 1, n)

def curve(points):
    return np.interp(t, [p[0] for p in points], [p[1] for p in points])

def sweep(x, cutoff, kind, order=4, block=256):
    y = np.empty_like(x)
    zi = None
    for a in range(0, x.shape[1], block):
        sos = butter(order, float(np.clip(cutoff[a], 25, 21000)), kind, fs=SR, output="sos")
        if zi is None: zi = np.stack([sosfilt_zi(sos) * x[c, 0] for c in range(2)], 1)
        for c in range(2):
            y[c, a:a + block], zi[:, c] = sosfilt(sos, x[c, a:a + block], zi=zi[:, c])
    return y

# low-pass: muffled intro, opens on Enter, wide open by the drop, closes as the board shrinks, word hits punch through
hits = [48, 49, 50, 52]
lp_pts = [(0, 380), (B(10.9), 450), (B(11), 1300), (B(24), 2600), (B(31.9), 16000), (B(32), 21000), (B(46), 21000), (B(48), 2200)]
for h in hits:
    lp_pts += [(B(h) - 0.001, 2200), (B(h), 21000), (B(h) + 0.30, 21000), (B(h) + 0.45, 2200)]
lp_pts += [(B(54) - 0.001, 2200), (B(54), 21000), (B(55), 21000), (LEN, 600)]
lp_pts.sort()
# high-pass: the build loses its kick and bass, so the drop's return of the low end is the hit
hp_pts = [(0, 25), (B(28), 25), (B(31.9), 260), (B(32), 25), (LEN, 25)]
music = sweep(music, curve(lp_pts), "low")
music = sweep(music, curve(hp_pts), "high", order=2)

# reverse swell into the drop, made from the drop's own first second
n = int(SR * 1.1)
rev = src[:, int(start * SR):int(start * SR) + n][:, ::-1] * np.linspace(0, 1, n) ** 2.5
i = int(B(32) * SR) - n
music[:, i:i + n] += 0.6 * rev

gain = curve([(0, 0.55), (B(11), 0.55), (B(11) + 0.01, 0.8), (B(24), 0.8), (B(31.9), 0.95), (B(32), 1.0), (B(46), 1.0), (B(48), 0.75),
              (B(54), 0.85), (B(54) + 0.01, 1.0), (B(56), 0.9), (LEN - 0.4, 0.5), (LEN, 0.0)])
music *= gain
music /= np.abs(music).max() / 0.9
wavfile.write(HERE / "music.wav", SR, music.T.astype(np.float32))
print("wrote music.wav")
