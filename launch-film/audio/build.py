# Builds assets/mix.wav: a MusicGen take (generate.py) cut to picture by arrange.py, plus cue SFX, mastered to -14 LUFS.
# Usage: python audio/build.py [take]   (default free-drop-2). Needs numpy + scipy, ffmpeg with rubberband, and node.
# SFX times come from the timeline in index.html via cues.mjs, so they always sit on their visual hits.
import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "music.wav"
OUT = HERE.parent / "assets" / "mix.wav"
LEN = 28.0

SFX = {
    "click": "anoisesrc=d=0.04:c=white:a=0.9:r=48000,highpass=f=2500,afade=t=out:st=0:d=0.035:curve=exp,volume=0.55",
    "tick": "anoisesrc=d=0.02:c=white:a=0.6:r=48000,bandpass=f=3800:w=2500,afade=t=out:st=0:d=0.018:curve=exp,volume=0.16",
    "sub": "aevalsrc='0.9*sin(2*PI*(42+70*exp(-t*28))*t)*exp(-t*6)':d=0.6:s=48000",
    # rises to its peak at 0.2 s (the cue time), then falls away
    "whoosh": "anoisesrc=d=0.6:c=pink:a=0.8:r=48000,highpass=f=300,lowpass=f=7000,volume='if(lt(t,0.2),pow(t/0.2,2),exp(-(t-0.2)*9))':eval=frame,volume=0.7",
}
LEAD = {"whoosh": 0.2}

TAKE = sys.argv[1] if len(sys.argv) > 1 else "free-drop-2"
subprocess.run(["python", str(HERE / "arrange.py"), TAKE], check=True)
cues = json.loads(subprocess.run(["node", str(HERE / "cues.mjs")], capture_output=True, text=True, check=True).stdout)
graph = [f"[0:a]atrim=0:{LEN},asetpts=PTS-STARTPTS,aresample=48000[m]"]
labels = ["[m]"]
for i, (t, kind) in enumerate(cues):
    ms = max(0, round((t - LEAD.get(kind, 0)) * 1000))
    graph.append(f"{SFX[kind]},adelay={ms}|{ms},aformat=channel_layouts=stereo[c{i}]")
    labels.append(f"[c{i}]")
graph.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:duration=first[mix]")

def run(extra, out):
    return subprocess.run(["ffmpeg", "-v", "info", "-y", "-i", str(SRC), "-filter_complex", ";".join(graph) + extra, "-map", "[o]", *out],
                          capture_output=True, text=True, check=True)

target = "I=-14:TP=-1.0:LRA=11"
r = run(f";[mix]loudnorm={target}:print_format=json[o]", ["-f", "null", "-"])
m = json.loads(r.stderr[r.stderr.rindex("{"):r.stderr.rindex("}") + 1])
two = (f";[mix]loudnorm={target}:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
       f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,aresample=48000[o]")
run(two, ["-t", str(LEN), "-c:a", "pcm_s16le", str(OUT)])
print(f"wrote {OUT} with {len(cues)} cues")
