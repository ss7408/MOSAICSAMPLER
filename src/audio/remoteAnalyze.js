// remoteAnalyze.js
// Thin client for the optional Python analyze service (server/app.py). Sends one
// uploaded file, gets back the "smart" metadata fields (bpm / key / keyConfidence
// / detectedType) in the exact shape analyzer.js produces. Everything here is
// best-effort: if the service is down, slow, or disabled, we return null and the
// caller keeps the in-browser heuristic. The app is never blocked on this.

const RAW = import.meta.env.VITE_ANALYZE_URL ?? "http://localhost:8000/analyze";

// Tolerate a scheme-less VITE_ANALYZE_URL (e.g. "host/analyze"). Without a
// scheme, fetch() treats it as a *relative* URL and silently hits the frontend
// origin instead of the analyze service — the remote analyzer then appears to
// "work" while every call 404s and falls back to the JS heuristic. Normalize to
// https:// when the value is a bare host. Leaves "off", absolute URLs, and
// same-origin paths ("/analyze") untouched.
const ENDPOINT =
  RAW === "off" || /^https?:\/\//i.test(RAW) || RAW.startsWith("/")
    ? RAW
    : `https://${RAW}`;

// Set VITE_ANALYZE_URL=off to run fully offline (JS heuristics only).
export const remoteEnabled = !!ENDPOINT && ENDPOINT !== "off";

export async function analyzeRemote(file, { timeoutMs = 20000 } = {}) {
  if (!remoteEnabled || !file) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new FormData();
    body.append("file", file, file.name);
    const res = await fetch(ENDPOINT, { method: "POST", body, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json(); // { bpm, key, keyConfidence, detectedType }
  } catch {
    return null; // offline / no server / timeout -> fall back to the JS heuristic
  } finally {
    clearTimeout(timer);
  }
}
