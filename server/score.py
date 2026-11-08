"""Serve the mock and score Speak recordings with Whisper, all on this machine.

Run from the repo root:
    uv run --with mlx-whisper python -I server/score.py
then open http://localhost:8792/

POST /api/score?target=<Lao text>&roman=<romanization> with the recorded audio as the body.
The reply is {"heard": <what Whisper wrote>, "score": 0-100}.

Whisper large-v3-turbo usually writes Lao speech in Latin letters ("Khoi sabai di") rather than
Lao script, so the score compares against the romanization after folding spelling variants
(ee/i, kh/k, doubled letters). If Whisper does return Lao script, it compares against the script.
Whisper ignores tone, so the score says whether the sounds were right, not the tones.

Teacher recordings: /teacher.html lists every phrase with a record button.
POST /api/teacher?key=<phrase key> saves the audio as mock/media/teacher/<key>.mp3,
DELETE /api/teacher?key=<phrase key> removes it, and both rewrite mock/data/teacher.js,
which the app reads so a teacher recording plays ahead of native and synthetic audio.
"""

import json
import subprocess
import time
import os
import re
import sys
import tempfile
import threading
import unicodedata
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import mlx_whisper

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK = os.path.join(ROOT, "mock")
MODEL = "mlx-community/whisper-large-v3-turbo"
PORT = 8792
MAX_BYTES = 10 * 1024 * 1024
TEACHER_DIR = os.path.join(MOCK, "media", "teacher")
TEACHER_JS = os.path.join(MOCK, "data", "teacher.js")
TEACHER_LOCK = threading.Lock()

MODEL_LOCK = threading.Lock()
LAO_LETTERS = re.compile(r"[^ກ-ໟ]")


def normalize(s):
    """Lao letters only, with ໍ + າ folded into ຳ so both spellings compare equal."""
    return LAO_LETTERS.sub("", s.replace("ໍາ", "ຳ"))


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


FOLDS = [("bp", "p"), ("dt", "t"), ("ee", "i"), ("ea", "i"), ("oo", "u"), ("ou", "u"), ("ao", "au"),
         ("ae", "e"), ("ay", "ai"), ("ey", "ei"), ("eu", "u"), ("ch", "j"), ("c", "k"), ("q", "k"),
         ("x", "s"), ("z", "s"), ("w", "v")]


def fold(s):
    """Collapse romanization spelling variants so 'Sabaidi' and 'sabaidee' compare equal."""
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if c.isascii() and c.isalpha())
    for a, b in FOLDS:
        s = s.replace(a, b)
    s = s.replace("h", "").replace("y", "i")
    return re.sub(r"(.)\1+", r"\1", s)


def similarity(a, b):
    if not a and not b:
        return 0
    return max(0, round(100 * (1 - edit_distance(a, b) / max(len(a), len(b)))))


def score(heard, target, roman):
    if normalize(heard):
        return similarity(normalize(heard), normalize(target))
    # Words in parentheses are optional in the deck, so score with and without them.
    forms = {fold(roman), fold(re.sub(r"\([^)]*\)", "", roman))} - {""}
    if not forms:
        raise ValueError(f"romanization has no letters: {roman!r}")
    return max(similarity(fold(heard), f) for f in forms)


def transcribe(path):
    with MODEL_LOCK:
        out = mlx_whisper.transcribe(path, path_or_hf_repo=MODEL, language="lo",
                                     condition_on_previous_text=False, temperature=0.0)
    return out["text"].strip()


def phrase_keys():
    src = open(os.path.join(MOCK, "data", "units.js"), encoding="utf-8").read()
    units = json.loads(src[src.index("["):src.rindex("]") + 1])
    return {it["key"] for u in units for it in u["items"]}


def teacher_manifest():
    out = {}
    for f in sorted(os.listdir(TEACHER_DIR)):
        if f.endswith(".mp3"):
            out[f[:-4]] = int(os.path.getmtime(os.path.join(TEACHER_DIR, f)))
    return out


def write_teacher_manifest():
    body = json.dumps(teacher_manifest(), indent=1)
    tmp = TEACHER_JS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("// Written by server/score.py when a teacher records. Phrase key -> recording time.\n")
        fh.write(f"window.VAO_TEACHER = {body};\n")
    os.replace(tmp, TEACHER_JS)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=MOCK, **kw)

    def send_json(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path == "/api/health":
            return self.send_json(200, {"ok": True, "model": MODEL})
        return super().do_GET()

    def end_headers(self):
        if urlparse(self.path).path.endswith((".js", ".html")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def teacher_key(self, url):
        key = parse_qs(url.query).get("key", [""])[0]
        if not re.fullmatch(r"[0-9a-f]{12}", key) or key not in phrase_keys():
            self.send_json(400, {"error": f"unknown phrase key {key!r}"})
            return None
        return key

    def do_DELETE(self):
        url = urlparse(self.path)
        if url.path != "/api/teacher":
            return self.send_json(404, {"error": "not found"})
        key = self.teacher_key(url)
        if not key:
            return
        path = os.path.join(TEACHER_DIR, key + ".mp3")
        with TEACHER_LOCK:
            if not os.path.exists(path):
                return self.send_json(404, {"error": "no teacher recording for that phrase"})
            os.unlink(path)
            write_teacher_manifest()
        return self.send_json(200, {"deleted": key})

    def save_teacher(self, url):
        key = self.teacher_key(url)
        if not key:
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BYTES:
            return self.send_json(400, {"error": f"audio body must be 1 to {MAX_BYTES} bytes, got {length}"})
        audio = self.rfile.read(length)
        with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as fh:
            fh.write(audio)
        out = os.path.join(TEACHER_DIR, key + ".mp3")
        tmp_out = out + ".tmp.mp3"
        try:
            # Trim leading and trailing silence so the clip starts when the word does.
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", fh.name, "-af",
                            "silenceremove=start_periods=1:start_threshold=-45dB,areverse,"
                            "silenceremove=start_periods=1:start_threshold=-45dB,areverse,apad=pad_dur=0.15",
                            "-ac", "1", "-ar", "44100", "-b:a", "96k", tmp_out],
                           check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as e:
            print(f"ffmpeg failed: {e.stderr}", file=sys.stderr)
            return self.send_json(400, {"error": "could not read that recording"})
        finally:
            os.unlink(fh.name)
        if os.path.getsize(tmp_out) < 2000:
            os.unlink(tmp_out)
            return self.send_json(400, {"error": "that recording was silent, try again closer to the mic"})
        with TEACHER_LOCK:
            os.replace(tmp_out, out)
            write_teacher_manifest()
        return self.send_json(200, {"saved": key, "v": int(time.time())})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/api/teacher":
            return self.save_teacher(url)
        if url.path != "/api/score":
            return self.send_json(404, {"error": "not found"})
        q = parse_qs(url.query)
        target, roman = q.get("target", [""])[0], q.get("roman", [""])[0]
        length = int(self.headers.get("Content-Length") or 0)
        if not normalize(target) or not fold(roman):
            return self.send_json(400, {"error": "target must be Lao text and roman its romanization"})
        if not 0 < length <= MAX_BYTES:
            return self.send_json(400, {"error": f"audio body must be 1 to {MAX_BYTES} bytes, got {length}"})
        audio = self.rfile.read(length)
        with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as fh:
            fh.write(audio)
        try:
            heard = transcribe(fh.name)
        except Exception as e:
            print(f"transcribe failed: {e!r}", file=sys.stderr)
            return self.send_json(500, {"error": f"transcription failed: {e}"})
        finally:
            os.unlink(fh.name)
        return self.send_json(200, {"heard": heard, "score": score(heard, target, roman)})


def main():
    os.makedirs(TEACHER_DIR, exist_ok=True)
    write_teacher_manifest()
    print(f"loading {MODEL} ...", file=sys.stderr)
    transcribe(os.path.join(MOCK, "media", "lao_pilot_greet01.mp3"))
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"ready on http://localhost:{PORT}/ (teacher recording at /teacher.html)", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
