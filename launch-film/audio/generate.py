# Generates candidate launch tracks with MusicGen (facebook/musicgen-stereo-melody), steered by guide.wav:
# compose.py's chords + arp + lead with no drums or bass, so the model keeps the film's harmony, melody and beat grid
# and supplies the actual production. Run with the venv that has torch + transformers:
#   HF_HOME=D:/dev/tmp/hf D:/dev/tmp/musicgen-venv/Scripts/python audio/generate.py
import sys
import numpy as np, torch
from pathlib import Path
from scipy.io import wavfile
from scipy.signal import resample_poly
from transformers import AutoProcessor, MusicgenMelodyForConditionalGeneration

HERE = Path(__file__).parent
OUT = HERE / "candidates"; OUT.mkdir(exist_ok=True)
MODEL = "facebook/musicgen-stereo-melody"
SECONDS = 28.4

PROMPTS = {
    "anthem": "Premium tech product launch anthem, modern progressive house, 127 BPM, F minor, punchy four-on-the-floor kick, wide sidechained supersaw chords, plucky synth arpeggio, snare roll and white noise riser building into a huge euphoric drop, polished radio-ready mix, energetic and confident, instrumental, no vocals",
    "keynote": "Cinematic electronic music for an AI product reveal, 127 BPM, pulsing analog synth bass, glossy arpeggios, tense build-up with risers, explosive drop with heavy sidechain pumping, modern EDM production like a keynote launch video, instrumental",
    "techno": "Driving melodic techno, 127 BPM, dark F minor, rolling bassline, hypnotic arpeggiated lead, tension build and hard drop, crisp hi-hats, big reverb, sleek futuristic launch trailer energy, instrumental",
    "electro": "Uplifting electro house, 127 BPM, bright supersaw chords, tight claps, filtered intro opening into a massive drop, clean professional mastering, startup launch video, instrumental",
}
# `generate.py free 1 2`: no guide, full-energy drop material for arrange.py to cut to picture
FREE = sys.argv[1:2] == ["free"]
if FREE:
    SECONDS = 16.5
    PROMPTS = {
        "drop": "high energy progressive house drop, 127 bpm, four on the floor kick, punchy sidechained supersaw chords, driving bassline, bright lead synth hook, festival main stage, polished modern mastering, instrumental",
        "tech": "energetic electro house, 127 bpm, punchy kick on every beat, rolling bassline, crisp hi-hats, catchy synth stab hook, modern product launch commercial, polished mix, instrumental",
        "future": "modern electronic launch trailer music, 127 bpm, huge sidechained synth chords, punchy drums, bright arpeggio, euphoric and confident, tech keynote style, instrumental",
    }
SEEDS = [int(s) for s in sys.argv[1 + FREE:]] or [1, 2]

sr, guide = wavfile.read(HERE / "guide.wav")
guide = resample_poly(guide.mean(1), 2, 3).astype(np.float32)  # 48 kHz -> 32 kHz mono, what the chroma extractor expects

processor = AutoProcessor.from_pretrained(MODEL)
model = MusicgenMelodyForConditionalGeneration.from_pretrained(MODEL, torch_dtype=torch.float16).to("cuda")
rate = model.config.audio_encoder.sampling_rate
tokens = int(SECONDS * model.config.audio_encoder.frame_rate)

for name, prompt in PROMPTS.items():
    if FREE: inputs = processor(text=[prompt], padding=True, return_tensors="pt").to("cuda")
    else:
        inputs = processor(audio=guide, sampling_rate=32000, text=[prompt], padding=True, return_tensors="pt").to("cuda")
        inputs["input_features"] = inputs["input_features"].half()
    for seed in SEEDS:
        path = OUT / f"{'free-' if FREE else ''}{name}-{seed}.wav"
        if path.exists(): continue
        torch.manual_seed(seed)
        with torch.inference_mode():
            audio = model.generate(**inputs, do_sample=True, guidance_scale=3.5, max_new_tokens=tokens)
        wav = audio[0].float().cpu().numpy()
        wavfile.write(path, rate, wav.T)
        print("wrote", path.name, wav.shape, flush=True)
