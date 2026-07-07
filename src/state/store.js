// store.js
// Single source of truth for the sampler. Small on purpose. The UI reads from
// here; actions push the audio side-effects into the engine.

import { create } from "zustand";
import * as Tone from "tone";
import { engine } from "../audio/engine.js";
import { analyzeBuffer, buildTags } from "../audio/analyzer.js";
import { analyzeRemote } from "../audio/remoteAnalyze.js";
import { buildDemoPack, DEMO_HOME } from "../audio/demoPack.js";
import { suggestPitchShift, transposeKey, noteName } from "../audio/musicTheory.js";

// Below this key strength (0..1) we don't trust a server-detected key: it won't
// vote for the project key and key-lock won't auto-transpose it. Kills the worst
// failure mode — confidently transposing an atonal drum/FX loop. The JS heuristic
// reports no confidence, so its keys are always trusted (keeps the no-backend
// behaviour identical).
const KEY_CONF_MIN = 0.4;
const keyTrusted = (s) => s.keyConfidence == null || s.keyConfidence >= KEY_CONF_MIN;
// Only pitched material gets key-locked. Drums / fx / textures still get a key
// from the analyzer (it always reports a best-correlation guess), but transposing
// them just detunes the groove — so they never vote for the project key and are
// never shifted.
const TONAL_TYPES = new Set(["bass", "chord", "melody", "vocal"]);
const isTonal = (s) => TONAL_TYPES.has(s.detectedType);

// Merge a server (Python) analysis result onto an existing sample. Tempo / key /
// type win over the in-browser heuristic; loop-status and tags are re-derived.
function applyRemote(smp, remote) {
  const next = { ...smp, analyzedBy: "python" };
  // Only let the server win when it actually found something — a null bpm/key
  // must not clobber a good heuristic value (and silently demote a loop).
  if (remote.bpm != null) next.bpm = remote.bpm;
  if (remote.key) {
    next.key = remote.key;
    next.rootPitch = noteName(remote.key.tonic);
    next.keyConfidence = remote.keyConfidence ?? null;
  }
  if (remote.detectedType && !smp.userTyped) next.detectedType = remote.detectedType;
  if (!smp.userLooped) next.loop = isLoop(next);
  next.tags = buildTags({
    detectedType: next.detectedType,
    bpm: next.bpm,
    key: next.key,
    energy: next.energy,
    transientDensity: next.transientDensity,
  });
  return next;
}

// Samples shorter than this are one-shots: they punch from the top on every
// press (MPC-style) instead of latching on/off. Auto loop/type detection is
// unreliable, so length is the signal we trust — and toggling a short hit off
// mid-finger-drum feels broken.
const MIN_LOOP_SEC = 1.2;

function isLoop(meta) {
  if (meta.detectedType === "fx") return false;
  if (meta.duration != null && meta.duration < MIN_LOOP_SEC) return false;
  if (meta.bpm == null && meta.detectedType !== "texture") return false;
  return true;
}

// Types the user can cycle through by clicking a sample's [letter]. Auto
// detection only seeds the value; this lets you correct it. ("unknown" isn't
// offered — it's just the fallback for an unrecognised value.)
const EDITABLE_TYPES = ["drum", "bass", "chord", "melody", "vocal", "fx", "texture"];

function enrich(meta) {
  return {
    ...meta,
    loop: isLoop(meta),
    // per-sample params (master transpose is global, see masterPitch)
    volume: 0,
    filter: 1,
    space: 0,
    chorus: 0,
    delay: 0,
    mute: false,
    solo: false,
    keyConfidence: meta.keyConfidence ?? null, // server key strength; null = JS heuristic (trusted)
    keyShift: 0, // auto harmonic lock toward the project key (semitones)
    tune: 0, // manual per-sample correction (semitones)
  };
}

// The project key everything locks to. Default to the key shared by the most
// samples so the fewest sounds have to move to agree.
function pickProjectKey(samples) {
  const counts = new Map();
  for (const s of samples) {
    if (!s.key || !keyTrusted(s) || !isTonal(s)) continue; // only confident, pitched keys vote
    const k = `${s.key.tonic}-${s.key.mode}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      const [tonic, mode] = k.split("-");
      best = { tonic: +tonic, mode };
    }
  }
  return best; // null when nothing is tonal (all drums / fx)
}

// The project tempo every loop locks to. Default to the tempo the most loops
// share (modal), falling back to the median, so the fewest sounds have to stretch
// far — minimal stretch keeps them clean and tight.
function pickProjectBpm(samples) {
  const loops = samples.filter((s) => s.loop && s.bpm);
  if (!loops.length) return null;
  const counts = new Map();
  for (const s of loops) counts.set(s.bpm, (counts.get(s.bpm) || 0) + 1);
  let mode = null;
  let modeN = 0;
  for (const [bpm, n] of counts) {
    if (n > modeN) {
      modeN = n;
      mode = bpm;
    }
  }
  if (modeN > 1) return mode; // a clearly shared tempo
  const sorted = loops.map((s) => s.bpm).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]; // else the median
}

const SLOTS = 8;
function buildDeck(samples) {
  const deck = new Array(SLOTS).fill(null);
  for (let i = 0; i < Math.min(SLOTS, samples.length); i++) deck[i] = samples[i].id;
  return deck;
}

async function decodeFile(file) {
  const ab = await file.arrayBuffer();
  return await Tone.getContext().rawContext.decodeAudioData(ab);
}

const AUDIO_RE = /\.(wav|mp3|aif|aiff|flac|ogg|m4a|aac|webm)$/i;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const useStore = create((set, get) => ({
  view: "empty", // empty | analyzing | ready
  samples: [], // the full library
  deck: [], // SLOTS ids (or null) — the playable arrangement
  selectedId: null,
  playing: {},
  bpm: DEMO_HOME.bpm,
  projectBpmAuto: true, // tempo was auto-derived from the loops (vs. user-set)
  masterPitch: 0,
  align: true,
  projectKey: null, // the global key samples lock to
  projectKeyAuto: true, // key was auto-derived (vs. user-set); lets the server refine it
  keyLock: true, // auto harmonic key-matching on/off
  master: { saturate: 0, compress: 0, makeup: 0 }, // master-bus effects
  analyzing: { active: false, total: 0, done: 0, current: "" },
  enriching: 0, // samples still awaiting server (Python) refinement
  recording: false, // capturing master bus to a downloadable file

  // --- ingestion ------------------------------------------------------
  loadDemo: async () => {
    await engine.unlock();
    engine.setBpm(DEMO_HOME.bpm);
    set({ view: "analyzing", bpm: DEMO_HOME.bpm, samples: [], analyzing: { active: true, total: 8, done: 0, current: "Rendering pack" } });
    const pack = await buildDemoPack(Tone.getContext().sampleRate);
    await get()._ingest(pack);
  },

  loadFiles: async (fileList) => {
    const files = Array.from(fileList).filter((f) => AUDIO_RE.test(f.name)).slice(0, 16);
    if (files.length === 0) return;
    await engine.unlock();
    set({ view: "analyzing", samples: [], analyzing: { active: true, total: files.length, done: 0, current: "Reading files" } });
    const items = [];
    for (const file of files) {
      try {
        items.push({ file, filename: file.name, audioBuffer: await decodeFile(file), hint: {} });
      } catch (e) {
        /* skip undecodable */
      }
    }
    await get()._ingest(items);
  },

  // Add more samples to a running session (button / drop on the library).
  // Appends to the library and fills any empty deck slots.
  addFiles: async (fileList) => {
    if (get().view !== "ready") return get().loadFiles(fileList);
    const files = Array.from(fileList).filter((f) => AUDIO_RE.test(f.name)).slice(0, 16);
    if (!files.length) return;
    const pending = [];
    for (const file of files) {
      try {
        const audioBuffer = await decodeFile(file);
        const meta = analyzeBuffer(audioBuffer, file.name, {});
        const sample = enrich(meta);
        engine.addVoice(meta, audioBuffer, { loop: sample.loop });
        pending.push({ file, id: sample.id });
        set((s) => {
          const samples = [...s.samples, sample];
          const deck = [...s.deck];
          const empty = deck.indexOf(null);
          if (empty >= 0) deck[empty] = sample.id;
          return { samples, deck, selectedId: sample.id };
        });
      } catch (e) {
        /* skip undecodable */
      }
    }
    if (!get().projectKey) set({ projectKey: pickProjectKey(get().samples) });
    get()._relock();
    get()._enrichRemote(pending);
  },

  _ingest: async (items) => {
    set((s) => ({ analyzing: { ...s.analyzing, total: items.length, done: 0 } }));
    const out = [];
    const pending = []; // real uploads to refine from the server, in the background
    // Pass 1 — instant, no network: cheap JS analysis + build the voice so the
    // deck is playable right away. The smart fields refine afterwards.
    for (let i = 0; i < items.length; i++) {
      const { file, filename, audioBuffer, hint } = items[i];
      const meta = analyzeBuffer(audioBuffer, filename, hint);
      const sample = enrich(meta);
      engine.addVoice(meta, audioBuffer, { loop: sample.loop });
      out.push(sample);
      if (file) pending.push({ file, id: sample.id });
      set((s) => ({ analyzing: { ...s.analyzing, done: i + 1, current: sample.name }, samples: [...out] }));
      await wait(40);
    }
    const projectKey = get().projectKey || pickProjectKey(out);
    set({ view: "ready", deck: buildDeck(out), selectedId: out[0]?.id ?? null, projectKey, analyzing: { active: false, total: 0, done: 0, current: "" } });
    get()._relock();
    get()._adoptTempo(out); // lock loops to a tempo derived from the loaded loops
    // Pass 2 — background: ask the Python service for tempo/key/type and snap the
    // results in as they arrive. Not awaited, so the UI is never blocked on it.
    get()._enrichRemote(pending);
  },

  // Background refinement: ask the Python service for better tempo/key/type and
  // patch each sample in place as answers land. Concurrent, best-effort (a miss
  // keeps the JS heuristic), and never awaited by ingestion.
  _enrichRemote: async (pending) => {
    if (!pending || !pending.length) return;
    set({ enriching: pending.length });
    await Promise.all(
      pending.map(async ({ file, id }) => {
        const remote = await analyzeRemote(file);
        if (remote) {
          set((s) => ({
            samples: s.samples.map((smp) => (smp.id === id ? applyRemote(smp, remote) : smp)),
          }));
          // Re-stamp the voice so a corrected tempo / loop-status takes effect.
          const smp = get().samples.find((s) => s.id === id);
          if (smp) engine.updateVoiceTiming(id, { baseBpm: smp.bpm || null, loop: smp.loop });
        }
        set((s) => ({ enriching: Math.max(0, s.enriching - 1) }));
      })
    );
    // Server keys are more accurate, so re-pick the project key (unless the user
    // set one by hand) and re-lock everything to it.
    if (get().projectKeyAuto) set({ projectKey: pickProjectKey(get().samples) });
    get()._relock();
    // Refined bpms can shift the shared tempo; re-adopt it, but not mid-playback
    // (that would yank a running loop's speed). User-set tempo is never touched.
    if (!Object.values(get().playing).some(Boolean)) get()._adoptTempo();
  },

  // Adopt a project tempo derived from the loops (unless the user set one), so
  // every loop locks to one shared grid at the least possible stretch.
  _adoptTempo: (samples) => {
    if (!get().projectBpmAuto) return;
    const pb = pickProjectBpm(samples || get().samples);
    if (!pb) return;
    engine.setBpm(pb);
    set({ bpm: pb });
  },

  reset: () => {
    engine.stopAll();
    get().samples.forEach((s) => engine.removeVoice(s.id));
    set({ view: "empty", samples: [], deck: [], selectedId: null, playing: {}, projectKey: null, projectKeyAuto: true, projectBpmAuto: true, enriching: 0 });
  },

  // --- key lock: harmonically match every sample to the project key ---
  // Smart match: samples already compatible (same key, relative major/minor,
  // neighbours) stay put; only out-of-key sounds shift, by the smallest move.
  // A manual per-sample `tune` rides on top so anything can be fixed by hand.
  _relock: () => {
    const { samples, projectKey, keyLock } = get();
    const next = samples.map((s) => {
      // Only shift confident, pitched samples; never transpose drums/fx.
      // suggestPitchShift returns { shift, score, ... }; we only need the semitones.
      const shift =
        keyLock && isTonal(s) && s.key && projectKey && keyTrusted(s)
          ? suggestPitchShift(s.key, projectKey).shift
          : 0;
      engine.setKeyShift(s.id, shift);
      return s.keyShift === shift ? s : { ...s, keyShift: shift };
    });
    set({ samples: next });
  },

  setProjectKey: (key) => {
    set({ projectKey: key, projectKeyAuto: false });
    get()._relock();
  },
  // move the whole project key up/down a semitone (re-locks every sample)
  nudgeProjectKey: (semis) => {
    const pk = get().projectKey;
    if (!pk) return;
    set({ projectKey: transposeKey(pk, semis), projectKeyAuto: false });
    get()._relock();
  },
  toggleKeyMode: () => {
    const pk = get().projectKey;
    if (!pk) return;
    set({ projectKey: { tonic: pk.tonic, mode: pk.mode === "min" ? "maj" : "min" }, projectKeyAuto: false });
    get()._relock();
  },
  toggleKeyLock: () => {
    set({ keyLock: !get().keyLock });
    get()._relock();
  },

  // --- master effects -------------------------------------------------
  setSaturate: (v) => {
    engine.setSaturation(v);
    set((s) => ({ master: { ...s.master, saturate: v } }));
  },
  setCompress: (v) => {
    engine.setCompression(v);
    set((s) => ({ master: { ...s.master, compress: v } }));
  },
  setMakeup: (v) => {
    v = Math.max(-12, Math.min(12, v));
    engine.setMakeup(v);
    set((s) => ({ master: { ...s.master, makeup: v } }));
  },

  // --- interaction ----------------------------------------------------
  select: (id) => set({ selectedId: id }),

  trigger: (id) => {
    const playing = engine.trigger(id);
    const smp = get().samples.find((s) => s.id === id);
    set({ selectedId: id });
    if (smp && smp.loop) {
      set((s) => ({ playing: { ...s.playing, [id]: playing } }));
    } else {
      set((s) => ({ playing: { ...s.playing, [id]: true } }));
      setTimeout(() => set((s) => ({ playing: { ...s.playing, [id]: false } })), 200);
    }
  },

  // Manually correct a sample's type — auto detection is only a starting point.
  // Re-derives loop-status + tags and re-stamps the voice so it takes effect now;
  // userTyped stops a late server result from clobbering the manual choice.
  cycleType: (id) => {
    set((s) => ({
      samples: s.samples.map((smp) => {
        if (smp.id !== id) return smp;
        const i = EDITABLE_TYPES.indexOf(smp.detectedType);
        const detectedType = EDITABLE_TYPES[(i + 1) % EDITABLE_TYPES.length];
        const next = { ...smp, detectedType, userTyped: true };
        next.loop = next.userLooped ? next.loop : isLoop(next);
        next.tags = buildTags({
          detectedType,
          bpm: next.bpm,
          key: next.key,
          energy: next.energy,
          transientDensity: next.transientDensity,
        });
        return next;
      }),
    }));
    const smp = get().samples.find((x) => x.id === id);
    if (smp) engine.updateVoiceTiming(id, { baseBpm: smp.bpm || null, loop: smp.loop });
  },

  // Flip a sample between LOOP (tap-on / tap-off latch) and ONE-SHOT (punches
  // from the top on every press). userLooped pins the choice so auto detection
  // and a late server result won't re-derive over it.
  toggleLoop: (id) => {
    set((s) => ({
      samples: s.samples.map((smp) =>
        smp.id === id ? { ...smp, loop: !smp.loop, userLooped: true } : smp
      ),
    }));
    const smp = get().samples.find((x) => x.id === id);
    if (smp) engine.updateVoiceTiming(id, { baseBpm: smp.bpm || null, loop: smp.loop });
  },

  stopAll: () => {
    engine.stopAll();
    set({ playing: {} });
  },

  setBpm: (bpm) => {
    bpm = Math.max(60, Math.min(200, Math.round(bpm)));
    engine.setBpm(bpm);
    set({ bpm, projectBpmAuto: false }); // user took the wheel; stop auto-deriving
  },

  toggleAlign: () => {
    const align = !get().align;
    engine.setAlign(align);
    set({ align });
  },

  // master transpose — moves every sample together
  setMasterPitch: (semis) => {
    semis = Math.max(-24, Math.min(24, Math.round(semis)));
    engine.setMasterPitch(semis);
    set({ masterPitch: semis });
  },

  // --- per-sample params (operate on selected sample) -----------------
  _patch: (id, patch) =>
    set((s) => ({ samples: s.samples.map((smp) => (smp.id === id ? { ...smp, ...patch } : smp)) })),

  setVolume: (id, v) => {
    engine.setVolume(id, v);
    get()._patch(id, { volume: v });
  },
  setFilter: (id, v) => {
    engine.setFilter(id, v);
    get()._patch(id, { filter: v });
  },
  setSpace: (id, v) => {
    engine.setSpace(id, v);
    get()._patch(id, { space: v });
  },
  setChorus: (id, v) => {
    engine.setChorus(id, v);
    get()._patch(id, { chorus: v });
  },
  setDelay: (id, v) => {
    engine.setDelay(id, v);
    get()._patch(id, { delay: v });
  },
  // manual per-sample tuning — the "fix it if needed" escape hatch on key lock
  setTune: (id, v) => {
    v = Math.max(-12, Math.min(12, Math.round(v)));
    engine.setTune(id, v);
    get()._patch(id, { tune: v });
  },

  toggleMute: (id) => {
    const smp = get().samples.find((s) => s.id === id);
    if (!smp) return;
    engine.setMute(id, !smp.mute);
    get()._patch(id, { mute: !smp.mute });
  },
  toggleSolo: (id) => {
    const smp = get().samples.find((s) => s.id === id);
    if (!smp) return;
    engine.setSolo(id, !smp.solo);
    get()._patch(id, { solo: !smp.solo });
  },

  // --- record + save the take ----------------------------------------
  // One toggle: first press arms the master-bus recorder, second press
  // stops it and hands you a download of exactly what just played.
  toggleRecord: async () => {
    if (get().recording) {
      const blob = await engine.stopRecord();
      set({ recording: false });
      if (!blob) return;
      const ext = (blob.type && blob.type.includes("webm")) ? "webm"
        : (blob.type && blob.type.includes("ogg")) ? "ogg"
        : "audio";
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13); // YYYYMMDDTHHMM
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mosaic-sampler-${stamp}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    const started = await engine.startRecord();
    if (started) set({ recording: true });
  },

  // --- arrangement: drag from library onto deck slots -----------------
  // Drop a library sample onto a slot. If it already sits in another slot it
  // moves (no duplicates on the deck).
  assignSlot: (slot, id) => {
    const deck = get().deck.map((x) => (x === id ? null : x));
    deck[slot] = id;
    set({ deck, selectedId: id });
  },
  // Drag one slot onto another to swap them.
  swapSlots: (a, b) => {
    if (a === b) return;
    const deck = [...get().deck];
    [deck[a], deck[b]] = [deck[b], deck[a]];
    set({ deck });
  },
}));
