"""
Mosaic Sampler analyze service.

A single endpoint that does the *smart* listening — tempo (librosa) and key
(essentia, with a confidence) — and returns it in the exact metadata shape the
browser's `analyzer.js` already produces. The JS analyzer keeps doing the instant,
cheap work (leading-silence trim, waveform thumbnail, loudness); this service only
fills in the few fields where a real MIR library beats a hand-rolled heuristic.

It sits behind the same stable contract analyzer.js documents — return
`{ bpm, key, keyConfidence, detectedType }` and nothing downstream in the app
has to change.

The heavy MIR libraries are imported LAZILY (on the first /analyze), not at module
load. librosa/numba/essentia take several seconds to import; doing that at startup
delays the web process binding its port, which makes platforms like Railway/Render
return 502 ("application failed to respond"). Deferring keeps boot instant and
/health always responsive.

Run:
    cd server
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000
"""

import io
import os
import tempfile

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Mosaic Sampler analyze")

# Allowed browser origins. Defaults to "*" for local dev (the Vite server runs on
# :5173); in production set ALLOWED_ORIGINS to your frontend URL, comma-separated
# for several (e.g. "https://mosaic.vercel.app").
_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Pitch-class index matching musicTheory.js NOTE_NAMES (C=0 .. B=11). Accept both
# sharp and flat spellings so any library's labelling maps cleanly.
_PITCH_CLASS = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5,
    "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}

# Lazily-imported heavy libs, cached after first load. _libs() is called from the
# request path, never at import time.
_LIBS = {}


def _libs():
    if not _LIBS:
        import numpy as np
        import librosa
        import soundfile as sf

        _LIBS["np"] = np
        _LIBS["librosa"] = librosa
        _LIBS["sf"] = sf
        # essentia is optional — its wheel is fiddly on some platforms. Without it,
        # tempo + type still work; only key falls back to the JS chroma heuristic.
        try:
            import essentia.standard as es

            _LIBS["es"] = es
        except Exception:
            _LIBS["es"] = None
    return _LIBS


def _load_mono(data: bytes):
    """Decode arbitrary uploaded audio to a mono float32 array + sample rate."""
    lb = _libs()
    np, librosa, sf = lb["np"], lb["librosa"], lb["sf"]
    try:
        # soundfile handles wav/flac/ogg from memory directly.
        y, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
        if getattr(y, "ndim", 1) > 1:
            y = y.mean(axis=1)
    except Exception:
        # mp3/m4a/aac: fall back to librosa (audioread/ffmpeg) via a temp file.
        with tempfile.NamedTemporaryFile(suffix=".audio") as tmp:
            tmp.write(data)
            tmp.flush()
            y, sr = librosa.load(tmp.name, sr=None, mono=True)
    return np.asarray(y, dtype="float32"), int(sr)


def detect_bpm(y, sr):
    """librosa beat tracking, folded into the app's musical range (74-168)."""
    lb = _libs()
    np, librosa = lb["np"], lb["librosa"]
    if y.size < sr // 2:  # under ~0.5s: not enough rhythmic content
        return None
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])
    if not np.isfinite(bpm) or bpm <= 0:
        return None
    while bpm < 74:
        bpm *= 2
    while bpm > 168:
        bpm /= 2
    return round(bpm)


def detect_key(y, sr):
    """essentia KeyExtractor -> ({tonic,mode}, strength). None when unavailable."""
    lb = _libs()
    es, librosa = lb["es"], lb["librosa"]
    if es is None:
        return None, None
    # KeyExtractor expects 44.1k mono; resample anything else first.
    if sr != 44100:
        y = librosa.resample(y, orig_sr=sr, target_sr=44100)
    key, scale, strength = es.KeyExtractor()(y.astype("float32"))
    tonic = _PITCH_CLASS.get(key)
    if tonic is None:
        return None, None
    mode = "min" if scale == "minor" else "maj"
    return {"tonic": tonic, "mode": mode}, round(float(strength), 3)


def classify_type(y, sr):
    """Same decision ladder as classifyType() in analyzer.js, on real features."""
    lb = _libs()
    np, librosa = lb["np"], lb["librosa"]
    dur = y.size / sr if sr else 0
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    density = len(onsets) / dur if dur > 0 else 0
    rms = float(np.sqrt(np.mean(np.square(y)))) if y.size else 0

    if density > 3.2 and centroid > 1800:
        return "drum"
    if dur < 0.6 and density >= 1 and centroid > 1400:
        return "drum"
    if centroid < 500 and dur > 0.4:
        return "bass"
    if centroid > 3500 and density < 1.5:
        return "fx"
    if rms < 0.05 and density < 1.2:
        return "texture"
    if 900 < centroid < 2600 and density < 2.5 and dur > 0.8:
        return "vocal"
    if density < 1.8:
        return "chord"
    return "melody"


@app.get("/health")
def health():
    # Trivial on purpose: touches no heavy imports, so it always answers fast and
    # the platform healthcheck passes the moment the process is up. `loaded` shows
    # whether the MIR libs have been pulled in yet (after the first /analyze).
    return {"ok": True, "loaded": bool(_LIBS), "essentia": bool(_LIBS.get("es"))}


@app.post("/analyze")
def analyze(file: UploadFile = File(...)):
    # Sync `def` on purpose: FastAPI runs it in a threadpool, so several uploads
    # analyze in parallel instead of serializing on the event loop (librosa/
    # essentia are CPU-bound and would otherwise block it).
    raw = file.file.read()
    y, sr = _load_mono(raw)
    key, confidence = detect_key(y, sr)
    return {
        "bpm": detect_bpm(y, sr),          # number | null
        "key": key,                        # {tonic:0-11, mode:'maj'|'min'} | null
        "keyConfidence": confidence,       # 0..1 | null
        "detectedType": classify_type(y, sr),
    }
