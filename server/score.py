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
"""

import json
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

    def do_POST(self):
        url = urlparse(self.path)
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
    print(f"loading {MODEL} ...", file=sys.stderr)
    transcribe(os.path.join(MOCK, "media", "lao_pilot_greet01.mp3"))
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"ready on http://localhost:{PORT}/", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
