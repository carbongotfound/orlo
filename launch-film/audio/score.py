# Ranks audio/candidates/*.wav for the film: tempo against the 127 BPM grid, kick phase against B(k),
# and whether the energy shape matches the picture (lift on Enter, build, a drop on 15.13 s, a held end).
import sys
import numpy as np
from pathlib import Path
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

BEAT, T0 = 0.47242, 0.0162
def B(k): return T0 + BEAT * k

def rms_db(x, sr, a, b):
    s = x[int(a * sr):int(b * sr)]
    return 10 * np.log10(np.mean(s ** 2) + 1e-12)

def analyse(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64); x = x.mean(1) if x.ndim == 2 else x
    low = sosfilt(butter(4, 150, "low", fs=sr, output="sos"), x)
    hop = sr // 200  # 5 ms
    n = len(low) // hop
    e = np.sqrt((low[:n * hop].reshape(n, hop) ** 2).mean(1))
    flux = np.maximum(0, np.diff(np.log(e + 1e-6), prepend=0))
    # tempo: autocorrelation peak between 110 and 145 BPM
    ac = np.correlate(flux - flux.mean(), flux - flux.mean(), "full")[n - 1:]
    lags = np.arange(len(ac)) / 200
    m = (lags > 60 / 145) & (lags < 60 / 110)
    beat = lags[m][np.argmax(ac[m])]
    # grid fit: share of low-end onset energy landing within 30 ms of a film beat
    t = np.arange(n) / 200
    d = np.abs(((t - T0 + BEAT / 2) % BEAT) - BEAT / 2)
    on_grid = flux[d < 0.03].sum() / (flux.sum() + 1e-9)
    shape = {
        "intro": rms_db(x, sr, 0.5, B(11)),
        "groove": rms_db(x, sr, B(11), B(24)),
        "build_end": rms_db(x, sr, B(30), B(32)),
        "drop": rms_db(x, sr, B(32), B(46)),
        "words": rms_db(x, sr, B(48), B(54)),
        "end": rms_db(x, sr, B(54), 27.5),
    }
    ref = shape["drop"]
    return 60 / beat, on_grid, {k: round(v - ref, 1) for k, v in shape.items()}

rows = []
for p in sorted(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "candidates").glob("*.wav")):
    bpm, grid, shape = analyse(p)
    # a good fit: drop is the loudest part, intro clearly under it, ends not silent, beats on the grid
    score = grid * 10 - abs(bpm - 127) * 0.5 + min(0, -shape["groove"]) * 0.5 + min(4, -shape["intro"]) * 0.5 - max(0, -shape["end"] - 12)
    rows.append((score, p.name, bpm, grid, shape))
for score, name, bpm, grid, shape in sorted(rows, reverse=True):
    print(f"{score:6.2f}  {name:18s} {bpm:6.1f} BPM  on-grid {grid:.2f}  rel. to drop dB {shape}")
