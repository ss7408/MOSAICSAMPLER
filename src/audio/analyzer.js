// analyzer.js
// The listening layer. Takes a decoded AudioBuffer and returns the metadata
// record the rest of the app reasons about. Some fields are measured for real
// from the samples (duration, waveform, loudness, transient density, spectral
// centroid); BPM and key use lightweight DSP heuristics that are good enough to
// feel intelligent in a prototype.
//
// ARCHITECTURE NOTE: every heuristic below is isolated in its own function with
// a stable signature. To go production-grade you swap the body of detectBpm /
// detectKey / classifyType for Essentia.js, aubio (wasm), or a server worker —
// the returned shape stays identical, so nothing downstream changes.

import { noteName } from "./musicTheory.js";

let _id = 0;
const nextId = () => `s${(++_id).toString(36)}${Date.now().toString(36).slice(-3)}`;

// --- Public entry point --------------------------------------------------
// `hint` lets the demo pack pass authored ground-truth (bpm/key/type) so the
// procedurally-generated demo reads cleanly; real uploads pass no hint and get
// fully analyzed.
export function analyzeBuffer(audioBuffer, filename, hint = {}) {
  const sampleRate = audioBuffer.sampleRate;
  const mono = toMono(audioBuffer);

  const duration = audioBuffer.duration;
  // Leading-silence trim: where does the sound actually start? Everything in the
  // sampler aligns to this so samples start at 0 the moment a key is hit.
  const trimIdx = detectTrimIndex(mono);
  const trim = trimIdx / sampleRate;
  const waveformData = computeWaveform(mono.subarray(trimIdx), 80);
  const { rms, peak, loudnessLufs } = computeLoudness(mono);
  const onsets = detectOnsets(mono, sampleRate);
  const transientDensity = duration > 0 ? onsets.length / duration : 0;
  const centroid = spectralCentroid(mono, sampleRate);

  // `'x' in hint` (not ??) so an explicit null from the demo means "no bpm/key"
  // — a drum or FX has none — while uploads (hint = {}) get fully analyzed.
  const bpm = "bpm" in hint ? hint.bpm : detectBpm(onsets, duration);
  const key = "key" in hint ? hint.key : detectKey(mono, sampleRate);
  const detectedType =
    "type" in hint ? hint.type : classifyType({ duration, transientDensity, centroid, rms });

  const energy = computeEnergy({ rms, transientDensity, centroid, detectedType });
  const rootPitch = key ? noteName(key.tonic) : null;

  return {
    id: nextId(),
    filename,
    name: prettyName(filename),
    duration: round(duration, 2),
    bpm,
    key,
    rootPitch,
    detectedType,
    energy: round(energy, 2),
    loudness: round(loudnessLufs, 1),
    peak: round(peak, 3),
    trim: round(trim, 3),
    waveformData,
    transientDensity: round(transientDensity, 2),
    centroid: Math.round(centroid),
    tags: buildTags({ detectedType, bpm, key, energy, transientDensity }),
    // Per-project fields (compatibility / suggestedPitchShift) are filled in by
    // the store relative to the current project key — they aren't intrinsic.
  };
}

// --- Leading-silence trim (real) -----------------------------------------
// First sample whose level crosses a small threshold, backed off a few ms so we
// don't clip the very front of the transient. Returns a sample index.
function detectTrimIndex(data) {
  const threshold = 0.012;
  let i = 0;
  for (; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) break;
  }
  if (i >= data.length) return 0; // silent / already aligned
  const backoff = Math.floor(0.003 * 44100); // ~3ms pre-roll
  return Math.max(0, i - backoff);
}

// --- Channel helpers -----------------------------------------------------
function toMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const a = buffer.getChannelData(0);
  const b = buffer.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) * 0.5;
  return out;
}

// --- Waveform (real) -----------------------------------------------------
// Downsample to `buckets` peak values for a crisp thumbnail. We keep absolute
// peaks (not RMS) so transients read as spikes — looks like a real editor.
function computeWaveform(data, buckets) {
  const out = new Array(buckets).fill(0);
  const block = Math.floor(data.length / buckets) || 1;
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * block;
    const end = Math.min(start + block, data.length);
    for (let i = start; i < end; i++) {
      const v = Math.abs(data[i]);
      if (v > max) max = v;
    }
    out[b] = max;
  }
  // Normalise so quiet samples still render a visible shape.
  const peak = Math.max(...out, 0.0001);
  return out.map((v) => round(v / peak, 3));
}

// --- Loudness (real-ish) -------------------------------------------------
function computeLoudness(data) {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / (data.length || 1));
  // Rough LUFS-ish figure: 20*log10(rms) with the K-weight offset baked in.
  const loudnessLufs = rms > 0 ? 20 * Math.log10(rms) - 0.691 : -70;
  return { rms, peak, loudnessLufs: clamp(loudnessLufs, -70, 0) };
}

// --- Onset detection (real) ----------------------------------------------
// Spectral-flux-free, time-domain envelope onset detector. Fast, deterministic,
// good enough to drive both transient density and the BPM guess.
function detectOnsets(data, sampleRate) {
  const hop = 256;
  const env = [];
  for (let i = 0; i < data.length; i += hop) {
    let sum = 0;
    const end = Math.min(i + hop, data.length);
    for (let j = i; j < end; j++) sum += Math.abs(data[j]);
    env.push(sum / hop);
  }
  // Adaptive threshold via local mean.
  const onsets = [];
  const win = 8;
  for (let i = 1; i < env.length - 1; i++) {
    let mean = 0;
    const a = Math.max(0, i - win);
    const b = Math.min(env.length, i + win);
    for (let k = a; k < b; k++) mean += env[k];
    mean /= b - a;
    const isPeak = env[i] > env[i - 1] && env[i] >= env[i + 1];
    if (isPeak && env[i] > mean * 1.6 && env[i] > 0.01) {
      const t = (i * hop) / sampleRate;
      if (onsets.length === 0 || t - onsets[onsets.length - 1] > 0.06) {
        onsets.push(t);
      }
    }
  }
  return onsets;
}

// --- BPM (heuristic) -----------------------------------------------------
// Histogram of inter-onset intervals, folded into a musical range. Returns null
// only when there genuinely isn't enough rhythmic content.
function detectBpm(onsets, duration) {
  if (onsets.length < 4) return null;
  const intervals = [];
  for (let i = 1; i < onsets.length; i++) {
    intervals.push(onsets[i] - onsets[i - 1]);
  }
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  if (!median || median <= 0) return null;
  let bpm = 60 / median;
  // Fold into a sensible loop range (74–168).
  while (bpm < 74) bpm *= 2;
  while (bpm > 168) bpm /= 2;
  return Math.round(bpm);
}

// --- Key detection (heuristic chroma) ------------------------------------
// Build a 12-bin chroma by summing energy of a coarse DFT into pitch classes,
// then correlate against major/minor key profiles (Krumhansl-style, simplified).
function detectKey(data, sampleRate) {
  const chroma = new Float32Array(12);
  // Analyse a window from the middle of the sample for tonal stability.
  const N = 4096;
  const start = Math.max(0, Math.floor(data.length / 2) - N);
  const slice = data.subarray(start, start + N);
  if (slice.length < N) return null;

  // Coarse DFT over musical frequencies only (cheap, ~ piano range).
  const minMidi = 36; // C2
  const maxMidi = 84; // C6
  let total = 0;
  for (let midi = minMidi; midi <= maxMidi; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const mag = goertzel(slice, sampleRate, freq);
    chroma[midi % 12] += mag;
    total += mag;
  }
  if (total <= 0) return null;
  for (let i = 0; i < 12; i++) chroma[i] /= total;

  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  let best = { score: -Infinity, tonic: 0, mode: "min" };
  for (let t = 0; t < 12; t++) {
    let majScore = 0;
    let minScore = 0;
    for (let i = 0; i < 12; i++) {
      majScore += chroma[(i + t) % 12] * major[i];
      minScore += chroma[(i + t) % 12] * minor[i];
    }
    if (majScore > best.score) best = { score: majScore, tonic: t, mode: "maj" };
    if (minScore > best.score) best = { score: minScore, tonic: t, mode: "min" };
  }
  return { tonic: best.tonic, mode: best.mode };
}

// Single-frequency magnitude via the Goertzel algorithm — cheaper than a full
// FFT when we only care about ~48 musical bins.
function goertzel(samples, sampleRate, freq) {
  const k = (freq / sampleRate) * samples.length;
  const w = (2 * Math.PI * k) / samples.length;
  const cosine = Math.cos(w);
  const coeff = 2 * cosine;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
}

// --- Spectral centroid (real) --------------------------------------------
// "Brightness" — drives type classification and energy. Coarse band energy
// weighted by frequency.
function spectralCentroid(data, sampleRate) {
  const N = 2048;
  const start = Math.max(0, Math.floor(data.length / 3));
  const slice = data.subarray(start, start + N);
  if (slice.length < N) return 1000;
  const bands = 24;
  let weighted = 0;
  let total = 0;
  for (let b = 0; b < bands; b++) {
    const freq = 80 * Math.pow(2, (b / bands) * 7); // 80Hz -> ~10kHz log spaced
    const mag = goertzel(slice, sampleRate, freq);
    weighted += mag * freq;
    total += mag;
  }
  return total > 0 ? weighted / total : 1000;
}

// --- Type classification (heuristic) -------------------------------------
function classifyType({ duration, transientDensity, centroid, rms }) {
  // Percussive: short and/or busy with transients, bright-ish.
  if (transientDensity > 3.2 && centroid > 1800) return "drum";
  if (duration < 0.6 && transientDensity >= 1 && centroid > 1400) return "drum";
  // Bass: dark and sustained.
  if (centroid < 500 && duration > 0.4) return "bass";
  // FX: bright, sparse, often a sweep — high centroid, low transient density.
  if (centroid > 3500 && transientDensity < 1.5) return "fx";
  // Texture: quiet, sustained, few transients.
  if (rms < 0.05 && transientDensity < 1.2) return "texture";
  // Vocal: mid-bright, sustained, moderate transients.
  if (centroid > 900 && centroid < 2600 && transientDensity < 2.5 && duration > 0.8) {
    return "vocal";
  }
  // Chord vs melody: chords are denser/sustained, melody more transient.
  if (transientDensity < 1.8) return "chord";
  return "melody";
}

function computeEnergy({ rms, transientDensity, centroid, detectedType }) {
  // 0..1 perceived intensity. Blend loudness, rhythmic activity and brightness.
  const loud = clamp(rms / 0.3, 0, 1);
  const busy = clamp(transientDensity / 6, 0, 1);
  const bright = clamp(centroid / 5000, 0, 1);
  let e = loud * 0.5 + busy * 0.32 + bright * 0.18;
  if (detectedType === "drum") e = Math.max(e, 0.55);
  if (detectedType === "texture") e = Math.min(e, 0.4);
  return clamp(e, 0.05, 1);
}

export function buildTags({ detectedType, bpm, key, energy, transientDensity }) {
  const tags = [detectedType];
  if (bpm) tags.push(`${bpm} BPM`);
  if (energy > 0.66) tags.push("high energy");
  else if (energy < 0.34) tags.push("mellow");
  if (transientDensity > 4) tags.push("busy");
  return tags;
}

// --- small utils ---------------------------------------------------------
function prettyName(filename) {
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function round(v, p = 2) {
  const f = Math.pow(10, p);
  return Math.round(v * f) / f;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
