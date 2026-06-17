# Mosaic analyze service — container image for Railway (also works on Render,
# Fly, Cloud Run). Railway auto-detects this Dockerfile and builds it. The
# container must listen on $PORT, which the platform injects; the CMD binds to it.

FROM python:3.11-slim

# System deps: ffmpeg lets librosa decode mp3/m4a; libsndfile backs soundfile for
# wav/flac/ogg. (The soundfile wheel usually bundles libsndfile, but installing it
# keeps decoding robust across formats.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so this layer is cached across app.py changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Platform provides $PORT (Railway/Render/Cloud Run). Shell form so it expands.
EXPOSE 8000
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
