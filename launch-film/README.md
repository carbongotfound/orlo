# Orlo launch film

28 s, 1920x1080, 60 fps, built with [HyperFrames](https://hyperframes.heygen.com). Everything on screen is the real app: the screenshots in `assets/ui/` were captured from a release build of Orlo 1.1.0 running on a throwaway copy of the demo data, and the diff is the real `--bare` fix in `src-tauri/src/lib.rs`.

```bash
npm run check    # lint + runtime + layout checks
npm run render   # renders/video.mp4
```

## Music

Generated with Meta's MusicGen (`facebook/musicgen-stereo-melody`, run locally on the GPU), then cut to picture the way a music editor cuts a library track. No stock music, no samples.

1. `audio/generate.py free 1 2` generates full-energy 16 s takes from three prompts (progressive house drop, electro house, launch-trailer electronic, all 127 BPM, instrumental). The take used is `free-drop-2`, seed 2 of the "drop" prompt:
   > high energy progressive house drop, 127 bpm, four on the floor kick, punchy sidechained supersaw chords, driving bassline, bright lead synth hook, festival main stage, polished modern mastering, instrumental
2. `audio/beats.py` fits the take's kick grid (127.14 BPM, 97% of kicks on the grid).
3. `audio/arrange.py` time-stretches it to exactly the film's 127 BPM with rubberband, loops its 8 bars, and edits the arc onto the beat map: muffled intro, filter opening on Enter, low end pulled out across the build with a reverse swell made from the drop itself, the full track slamming in on the drop (15.134 s), filtered word hits that open on each word, and the downbeat landing on the end card. There are no silences.
4. `python audio/build.py [take]` runs the arrangement, lays the synthesized clicks, key ticks, sub hits and whooshes on top, and masters to -14 LUFS into `assets/mix.wav`. The SFX times are not typed by hand: `audio/cues.mjs` runs the timeline script in `index.html` and reads back the cues it places.

MusicGen's weights are CC-BY-NC 4.0 (non-commercial). Fine for a free, open-source project's launch film; regenerate with a commercially licensed model before using the music in paid advertising.

Setup: `python -m venv D:/dev/tmp/musicgen-venv`, then `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124` and `pip install transformers soundfile scipy accelerate`; run `generate.py` with `HF_HOME` on a drive with ~5 GB free. `audio/compose.py` (the earlier hand-written synth theme) now only writes `guide.wav`, the melody guide for guided generation.

## Motion

- Moves arrive fast and land soft: each frame covers 15% of the remaining distance (the `land` ease), no overshoot.
- Camera holds keep a slow push-in, so no frame is fully still.
- Camera pans carry a horizontal or vertical motion blur along their travel that clears as they settle. The filter is only on while it smears.
- Cuts fall on kicks. Grouped elements (wordmark, diff lines) are staggered 3 frames apart.

## Beat map

Kicks fall on `0.0162 + 0.47242 k` seconds.

| Time | Shot |
| --- | --- |
| 0 – 1.9 | Mascot and wordmark on the first kick, README line on the next two |
| 1.9 – 5.2 | Claude Code prompt types, Enter on the kick, the real app springs out |
| 5.2 – 14.2 | Type a task with `#Work`, pick Claude and delegate, a note formats itself |
| 14.2 – 18.0 | Split: the real "Not logged in" thread, then the lib.rs diff on the drop, the agent run, `cargo test`, Approve |
| 18.0 – 22.5 | The finished task on the board, in search, on Home, the note, the command palette |
| 22.7 – 25.5 | Delegate. Review. Done. |
| 25.5 – 28 | Logo, URL, hold |
