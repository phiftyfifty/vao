"""Export the Lao Class decks from the local Anki collection into mock/data/units.js.

Reads an immutable snapshot of the collection, never the live file.
Run: python3 -I scripts/build_mock_data.py
"""

import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import sys
import zlib
from collections import OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANKI = os.path.expanduser("~/Library/Application Support/Anki2/User 1")
COLLECTION = os.path.join(ANKI, "collection.anki2")
MEDIA_SRC = os.path.join(ANKI, "collection.media")
OUT_DIR = os.path.join(ROOT, "mock", "data")
MEDIA_OUT = os.path.join(ROOT, "mock", "media")

KAIKKI = os.path.expanduser("~/Downloads/lao-datasets/kaikki/kaikki.org-dictionary-Lao.jsonl")
CLASS_NOTES = os.path.join(ROOT, "scripts", "data", "class_notes.json")
TTS_DIR = os.path.join(MEDIA_OUT, "tts")

LESSON_SIZE = 6
LAO_RE = re.compile(r"^[\u0E80-\u0EFF0-9\s?.!/_,()\u200b\u2026-]+$")
THAI_RE = re.compile(r"[\u0E00-\u0E7F]")

# Hand segmentation stands in for a real Lao word segmenter until that spike is done.
SEGMENTS = {
    "ເຈົ້າສະບາຍດີບໍ?": ["ເຈົ້າ", "ສະບາຍດີ", "ບໍ?"],
    "ຂ້ອຍສະບາຍດີ": ["ຂ້ອຍ", "ສະບາຍດີ"],
    "ຂ້ອຍບໍ່ສະບາຍ": ["ຂ້ອຍ", "ບໍ່", "ສະບາຍ"],
    "ບໍ່ເປັນຫຍັງ": ["ບໍ່", "ເປັນ", "ຫຍັງ"],
    "ໄປກ່ອນເດີ້": ["ໄປ", "ກ່ອນ", "ເດີ້"],
    "ແລ້ວພົບກັນ": ["ແລ້ວ", "ພົບ", "ກັນ"],
    "ແລ້ວພົບກັນໃໝ່": ["ແລ້ວ", "ພົບ", "ກັນ", "ໃໝ່"],
    "ຫ້ອງນ້ຳຢູ່ໃສ": ["ຫ້ອງນ້ຳ", "ຢູ່", "ໃສ"],
    "ແຊບຫຼາຍ": ["ແຊບ", "ຫຼາຍ"],
    "ບໍ່ເຜັດ": ["ບໍ່", "ເຜັດ"],
    "ອີ່ມແລ້ວ": ["ອີ່ມ", "ແລ້ວ"],
    "ໄກບໍ": ["ໄກ", "ບໍ"],
    "ຈອດບ່ອນນີ້": ["ຈອດ", "ບ່ອນ", "ນີ້"],
    "ໄປບ່ອນນີ້ໄດ້ບໍ": ["ໄປ", "ບ່ອນ", "ນີ້", "ໄດ້", "ບໍ"],
    "ຂອບໃຈຫຼາຍໆ": ["ຂອບໃຈ", "ຫຼາຍໆ"],
    "ມ່ວນຫຼາຍ": ["ມ່ວນ", "ຫຼາຍ"],
    "ເມື່ອຍຫຼາຍ": ["ເມື່ອຍ", "ຫຼາຍ"],
    "ພົບກັນໃໝ່": ["ພົບ", "ກັນ", "ໃໝ່"],
}

warnings = []


def connect():
    if not os.path.exists(COLLECTION):
        sys.exit(f"collection not found: {COLLECTION}")
    db = sqlite3.connect(f"file:{COLLECTION}?immutable=1", uri=True)
    db.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
    return db


def strip_html(s):
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s).strip()


def parse_lao_roman(s):
    """Sentence notes store 'LAO (roman) [sound:x.mp3]' in one field."""
    sound = re.search(r"\[sound:([^\]]+)\]", s)
    s = re.sub(r"\[sound:[^\]]+\]", "", s).strip()
    m = re.match(r"^(.*?)\s*\((.*)\)\s*$", s)
    if not m:
        return None, s, sound.group(1) if sound else None
    return m.group(1).strip(), m.group(2).strip(), sound.group(1) if sound else None


def check_lao(lao, where):
    if THAI_RE.search(lao):
        warnings.append(f"Thai character in Lao field, skipped: {where}: {lao}")
        return False
    if not LAO_RE.match(lao):
        warnings.append(f"non-Lao text in Lao field, skipped: {where}: {lao}")
        return False
    return True


PLAIN_LAO = re.compile(r"^[຀-໿]+$")


def spoken_text(lao):
    """What the synthetic voice reads: blanks and ellipses dropped, alternatives read in turn."""
    t = re.sub(r"[_…()]", "", lao).replace("/", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t if re.search(r"[ກ-ໟ]", t) else None


def tts_key(lao):
    return hashlib.sha1(lao.encode("utf-8")).hexdigest()[:12]


def load_dictionary():
    if not os.path.exists(KAIKKI):
        sys.exit(f"Lao dictionary not found: {KAIKKI}")
    words = set()
    with open(KAIKKI, encoding="utf-8") as fh:
        for line in fh:
            w = json.loads(line).get("word", "")
            if PLAIN_LAO.match(w):
                words.add(w)
    return words


def deck_words(lao):
    """Words a deck entry vouches for: 'ຊິ / ຈະ' gives both, '__ໃດ' gives ໃດ, '(ກະ)ປູ' gives ປູ and ກະປູ."""
    out = set()
    for alt in re.split(r"\s*/\s*", lao):
        alt = alt.replace("_", "").rstrip("?").strip()
        for form in (re.sub(r"\([^)]*\)", "", alt), alt.replace("(", "").replace(")", "")):
            if PLAIN_LAO.match(form):
                out.add(form)
    return out


def roman_words(roman, keep_optional):
    r = roman.replace("(", " ").replace(")", " ") if keep_optional else re.sub(r"\([^)]*\)", " ", roman)
    r = re.sub(r"[?,.!]", " ", r)
    return re.sub(r"\s*/.*$", "", r).split()


def segment(lao, roman, lexicon, dictionary):
    """Split a phrase into lexicon words, keeping only splits whose word count matches its romanization.

    Lao has no spaces, so a bare dictionary split is ambiguous; the romanization is the check.
    Optional words in parentheses may or may not be in the Lao, so both counts are tried.
    """
    clauses = [c.strip() for c in lao.split(",")]
    roman_clauses = roman.split(",")
    if len(clauses) != len(roman_clauses):
        return None
    tiles = []
    for n, (c, rc) in enumerate(zip(clauses, roman_clauses)):
        m = re.match(r"^(.*?)(\?*)$", c)
        core, punct = m.groups()
        if not PLAIN_LAO.match(core):
            return None
        counts = sorted({len(roman_words(rc, False)), len(roman_words(rc, True))})
        found = []

        def walk(i, acc, k):
            if len(acc) > k:
                return
            if i == len(core):
                if len(acc) == k:
                    found.append(list(acc))
                return
            for j in range(len(core), i, -1):
                w = core[i:j]
                if len(w) > 1 and w in lexicon and w != lao.rstrip("?"):
                    acc.append(w)
                    walk(j, acc, k)
                    acc.pop()

        for k in counts:
            walk(0, [], k)
        if not found:
            return None
        found.sort(key=lambda s: (sum(len(w) == 1 for w in s), -sum(w in dictionary for w in s)))
        best = found[0]
        best[-1] += punct + ("," if n < len(clauses) - 1 else "")
        tiles.extend(best)
    return tiles if len(tiles) >= 2 else None


def load_class_notes(seen):
    with open(CLASS_NOTES, encoding="utf-8") as fh:
        notes = json.load(fh)["items"]
    items = []
    for n in notes:
        if not check_lao(n["lao"], f"class notes/{n['en']}"):
            continue
        if n["lao"].rstrip("?") in seen:
            continue
        nid = "cn-" + format(zlib.crc32(n["lao"].encode("utf-8")), "08x")
        items.append({"id": nid, "en": n["en"], "roman": n["roman"], "lao": n["lao"],
                      "img": None, "note": None, "topic": n["topic"]})
    return items


def main():
    db = connect()
    rows = db.execute(
        "select d.name, n.guid, n.flds, n.tags from notes n "
        "join cards c on c.nid = n.id join decks d on c.did = d.id "
        "where d.name like 'Lao Class%' group by n.id order by n.id"
    ).fetchall()

    audio_by_lao = {}
    sentences = OrderedDict()
    units = OrderedDict()

    for deck, guid, flds, tags in rows:
        path = deck.split("\x1f")
        f = flds.split("\x1f")
        if path[-1] == "Sentences":
            lao, roman, sound = parse_lao_roman(f[1])
            if sound:
                audio_by_lao[lao] = sound
            tag = (f[2] if len(f) > 2 else "").replace("lao::", "") or "misc"
            if lao and check_lao(lao, f"Sentences/{f[0]}"):
                sentences.setdefault(tag, []).append(
                    {"id": guid, "en": strip_html(f[0]), "roman": roman, "lao": lao}
                )
            continue
        if len(path) != 3 or path[1] not in ("L1", "L2"):
            continue
        if len(f) < 4:
            warnings.append(f"unexpected field count {len(f)}: {deck}")
            continue
        en, roman, lao, extra = f[0], f[1], f[2].strip(), f[3]
        if not lao:
            continue
        if not check_lao(lao, f"{path[1]}/{path[2]}/{en}"):
            continue
        img = re.search(r'<img src="([^"]+)"', extra)
        note = strip_html(re.sub(r'<img[^>]*>', "", extra))
        units.setdefault((path[1], path[2]), []).append(
            {"id": guid, "en": strip_html(en), "roman": strip_html(roman), "lao": lao,
             "img": img.group(1) if img else None, "note": note or None}
        )

    out_units = []
    for (level, name), items in units.items():
        num, title = name.split(" ", 1)
        out_units.append({"id": f"{level}-{num}", "level": level, "title": title, "items": items})

    phrase_items = []
    for tag in ("social", "food", "practical", "transport", "laundry"):
        for it in sentences.get(tag, []):
            it["topic"] = tag
            phrase_items.append(it)
    out_units.append({"id": "P-01", "level": "Phrases", "title": "Getting by in Laos", "items": phrase_items})

    seen = {it["lao"].rstrip("?") for u in out_units for it in u["items"]}
    class_items = load_class_notes(seen)
    out_units.append({"id": "C-01", "level": "Class notes", "title": "Questions and ordering", "items": class_items})

    dictionary = load_dictionary()
    lexicon = dictionary | {w for u in out_units for it in u["items"] for w in deck_words(it["lao"])}
    n_hand = n_auto = 0
    used_media = set()
    for u in out_units:
        for it in u["items"]:
            it["key"] = tts_key(it["lao"])
            if it["lao"] in audio_by_lao:
                it["audio"] = audio_by_lao[it["lao"]]
                it["audio_src"] = "native"
            elif os.path.exists(os.path.join(TTS_DIR, tts_key(it["lao"]) + ".mp3")):
                it["audio"] = "tts/" + tts_key(it["lao"]) + ".mp3"
                it["audio_src"] = "tts"
            seg = SEGMENTS.get(it["lao"])
            if seg:
                n_hand += 1
            else:
                seg = segment(it["lao"], it["roman"], lexicon, dictionary)
                n_auto += bool(seg)
            if seg:
                if "".join(seg) != it["lao"].replace(" ", ""):
                    sys.exit(f"segmentation does not rebuild the phrase: {it['lao']} vs {seg}")
                it["tiles"] = seg
            if it.get("img"):
                used_media.add(it["img"])
            if it.get("audio_src") == "native":
                used_media.add(it["audio"])
        u["lessons"] = [
            [it["id"] for it in u["items"][i:i + LESSON_SIZE]]
            for i in range(0, len(u["items"]), LESSON_SIZE)
        ]
        if len(u["lessons"]) > 1 and len(u["lessons"][-1]) < 3:
            u["lessons"][-2].extend(u["lessons"].pop())

    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(MEDIA_OUT, exist_ok=True)
    missing = 0
    for m in sorted(used_media):
        src = os.path.join(MEDIA_SRC, m)
        if not os.path.exists(src):
            warnings.append(f"media missing on disk: {m}")
            missing += 1
            continue
        shutil.copy2(src, os.path.join(MEDIA_OUT, m))

    with open(os.path.join(OUT_DIR, "units.js"), "w", encoding="utf-8") as fh:
        fh.write("// Generated by scripts/build_mock_data.py. Do not edit by hand.\n")
        fh.write("window.VAO_UNITS = ")
        json.dump(out_units, fh, ensure_ascii=False, indent=1)
        fh.write(";\n")

    n_items = sum(len(u["items"]) for u in out_units)
    n_lessons = sum(len(u["lessons"]) for u in out_units)
    n_audio = sum(1 for u in out_units for it in u["items"] if it.get("audio_src") == "native")
    n_tts = sum(1 for u in out_units for it in u["items"] if it.get("audio_src") == "tts")
    n_tiles = sum(1 for u in out_units for it in u["items"] if it.get("tiles"))
    print(f"units {len(out_units)}  lessons {n_lessons}  items {n_items}  native audio {n_audio}  synthetic audio {n_tts}  segmented {n_tiles}"
          f" (hand {n_hand}, dictionary {n_auto})  class notes {len(class_items)}")
    print(f"media copied {len(used_media) - missing}")
    for w in warnings:
        print("warn:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
