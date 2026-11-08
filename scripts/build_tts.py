"""Synthesize Lao audio for every phrase without a native recording, using Meta's MMS Lao voice.

Writes mock/media/tts/<key>.mp3, one per distinct Lao text, and skips files that already exist.
build_mock_data.py then attaches them. The voice (facebook/mms-tts-lao) is CC-BY-NC 4.0.

Run after build_mock_data.py, then run build_mock_data.py again:
    uv run --with transformers --with torch python -I scripts/build_tts.py
"""

import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np
import torch
from transformers import AutoTokenizer, VitsModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_mock_data import OUT_DIR, TTS_DIR, spoken_text, tts_key  # noqa: E402

VOICE = "facebook/mms-tts-lao"


def main():
    src = open(os.path.join(OUT_DIR, "units.js"), encoding="utf-8").read()
    units = json.loads(src[src.index("["):src.rindex("]") + 1])
    todo = {}
    for u in units:
        for it in u["items"]:
            if it.get("audio_src") == "native":
                continue
            text = spoken_text(it["lao"])
            if text:
                todo[tts_key(it["lao"])] = text
    os.makedirs(TTS_DIR, exist_ok=True)
    missing = {k: t for k, t in todo.items() if not os.path.exists(os.path.join(TTS_DIR, k + ".mp3"))}
    print(f"{len(todo)} phrases need synthetic audio, {len(missing)} not generated yet")
    if not missing:
        return

    model = VitsModel.from_pretrained(VOICE)
    tok = AutoTokenizer.from_pretrained(VOICE)
    rate = model.config.sampling_rate
    for n, (key, text) in enumerate(sorted(missing.items()), 1):
        ids = tok(text, return_tensors="pt")
        if ids["input_ids"].shape[1] < 2:
            sys.exit(f"tokenizer produced nothing for {text!r}")
        torch.manual_seed(0)
        with torch.no_grad():
            y = model(**ids).waveform[0].numpy()
        pcm = (np.clip(y, -1, 1) * 32767).astype(np.int16)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
            wav_path = fh.name
        with wave.open(wav_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(rate)
            wf.writeframes(pcm.tobytes())
        out = os.path.join(TTS_DIR, key + ".mp3")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav_path, "-af", "apad=pad_dur=0.15",
                        "-ac", "1", "-b:a", "48k", out], check=True)
        os.unlink(wav_path)
        if n % 50 == 0:
            print(f"  {n}/{len(missing)}")
    print(f"wrote {len(missing)} files to {TTS_DIR}")


if __name__ == "__main__":
    main()
