# Mosaic Sampler analyze service

Optional Python sidecar that does the *smart* listening — **tempo** (librosa) and
**key + confidence** (essentia) — and hands it back in the exact metadata shape
the browser's `src/audio/analyzer.js` already produces.

The browser keeps doing the instant, cheap work itself: leading-silence trim,
the waveform thumbnail, loudness. This service only replaces the three fields
where a real MIR library beats a hand-rolled heuristic — `bpm`, `key`,
`detectedType` — plus a `keyConfidence` the browser uses to decide whether to
trust a key for harmonic key-lock.

It sits behind the same stable contract analyzer.js documents, so nothing else in
the app changes whether it's running or not.

## Run

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

`GET /health` → `{ "ok": true, "essentia": true|false }`.

Then start the frontend as usual (`npm run dev`). The app calls
`http://localhost:8000/analyze` by default.

## How the browser uses it

- **Demo pack** never calls the service — it ships authored ground-truth, so it
  stays fully offline.
- **Real uploads** are sent to `/analyze`. When it answers, its `bpm`/`key`/`type`
  win over the JS heuristic and the sample is re-tagged + re-locked to the key.
- **No server / offline / timeout** → the upload silently keeps the JS heuristic
  result. The app is never blocked on this service.

Override or disable the endpoint with an env var when running Vite:

```bash
VITE_ANALYZE_URL=http://localhost:8000/analyze npm run dev   # default
VITE_ANALYZE_URL=off npm run dev                             # stay offline, JS-only
```

## Deploy to Railway

This service ships a `Dockerfile`, so Railway builds it directly (no Nixpacks).

1. **New Project → Deploy from GitHub repo**, pick this repo.
2. Service **Settings → Root Directory** → set `server`, so the Dockerfile,
   `requirements.txt`, and `app.py` resolve. Railway then picks up the Dockerfile
   and `railway.toml` automatically.
3. (Optional) **Variables → `ALLOWED_ORIGINS`** = your Vercel URL
   (`https://your-app.vercel.app`) to lock CORS down from the `*` default.
4. Deploy. Railway injects `$PORT`; the container binds to it, and the healthcheck
   hits `/health`.
5. **Settings → Networking → Generate Domain** to get the public URL, e.g.
   `https://mosaic-analyze-production.up.railway.app`.

> `essentia` builds on Railway's linux/x86_64, so you should get real key
> detection here even if `pip install` failed on an Apple Silicon Mac.

## Point the Vercel frontend at it

`VITE_ANALYZE_URL` is read at **build time** by Vite, so it must be set in Vercel
and the frontend redeployed — setting it only locally won't affect production.

1. Vercel project → **Settings → Environment Variables**
2. `VITE_ANALYZE_URL` = `https://<your-railway-domain>/analyze`
3. **Redeploy** the frontend so the value is baked into the bundle.

Leave it unset (or `off`) and the deployed app runs JS-only, exactly as before.

## Confidence-gated key-lock

essentia returns a key *strength* (0..1). The store treats anything below
`KEY_CONF_MIN` (currently 0.4, in `src/state/store.js`) as untrusted: it won't
vote for the project key and won't be auto-transposed. This kills the worst
failure mode — confidently transposing an atonal drum/FX loop. The JS heuristic
reports no confidence, so its keys stay always-trusted (identical to the old
no-backend behaviour).

## essentia note

The essentia wheel can fail to install on some platforms (notably Apple
Silicon). The service is written to start *without* it — tempo and type still
work; only key falls back to the browser's chroma heuristic. If `pip install`
chokes on the last line of `requirements.txt`, drop it and carry on.
