# Kick-grid fit for a track: finds low-end onsets, then the beat period and phase that best explain them.
# Prints BPM, phase, timing spread and drift, so a generated take can be judged for steadiness and locked to the film grid.
import sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, find_peaks

def kicks(path, a=0.0, b=None):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64); x = x.mean(1) if x.ndim == 2 else x
    x = x[int(a * sr):int(b * sr) if b else None]
    low = sosfilt(butter(4, 120, "low", fs=sr, output="sos"), x)
    hop = sr // 1000
    n = len(low) // hop
    e = np.sqrt((low[:n * hop].reshape(n, hop) ** 2).mean(1))
    flux = np.maximum(0, np.diff(np.convolve(e, np.ones(5) / 5, "same"), prepend=0))
    pk, _ = find_peaks(flux, height=flux.max() * 0.2, distance=250)
    return pk / 1000 + a

def fit(t):
    best = None
    for period in np.arange(0.40, 0.55, 0.0002):
        ph = np.angle(np.exp(2j * np.pi * t / period).mean())
        r = np.abs(np.exp(2j * np.pi * t / period).mean())
        if best is None or r > best[0]: best = (r, period, ph)
    r, period, ph = best
    t0 = (ph / (2 * np.pi)) * period % period
    k = np.round((t - t0) / period)
    resid = t - (t0 + k * period)
    A = np.stack([k, np.ones_like(k)], 1)
    period, t0 = np.linalg.lstsq(A[np.abs(resid) < 0.04], t[np.abs(resid) < 0.04], rcond=None)[0]
    resid = t - (t0 + np.round((t - t0) / period) * period)
    return 60 / period, t0, resid

if __name__ == "__main__":
    for p in sys.argv[1:]:
        t = kicks(p)
        bpm, t0, resid = fit(t)
        good = np.abs(resid) < 0.04
        h = t.max() / 2
        bpm1 = fit(t[t < h])[0]; bpm2 = fit(t[t >= h])[0]
        print(f"{p.split('/')[-1]:18s} {bpm:6.2f} BPM t0 {t0:.3f}  kicks {len(t)} on-grid {good.mean():.0%}  spread {np.std(resid[good]) * 1000:.0f} ms  halves {bpm1:.1f}/{bpm2:.1f}")
