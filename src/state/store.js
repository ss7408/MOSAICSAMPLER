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

// Produce a sample's metadata. The browser always does the instant, cheap work
// (trim, waveform, loudness) plus a heuristic bpm/key/type. For real uploads we
// then ask the Python service for tempo + key (+confidence); when it answers it
// wins over the heuristic and we re-tag. Demo-pack items carry an authored `hint`
// and no `file`, so they never touch the network and stay fully offline.
async function analyzeItem({ file, filename, audioBuffer, hint }) {
  const meta = analyzeBuffer(audioBuffer, filename, hint);
  if (!file) return meta;
  const remote = await analyzeRemote(file);
  if (!remote) return meta; // offline / no server / timeout -> keep the heuristic
  if ("bpm" in remote) meta.bpm = remote.bpm;
  if ("key" in remote) {
    meta.key = remote.key;
    meta.rootPitch = remote.key ? noteName(remote.key.tonic) : null;
    meta.keyConfidence = remote.keyConfidence ?? null;
  }
  if (remote.detectedType) meta.detectedType = remote.detectedType;
  meta.analyzedBy = "python";
  // bpm / key / type drive the tags, so rebuild them on the server's answer.
  meta.tags = buildTags({
    detectedType: meta.detectedType,
    bpm: meta.bpm,
    key: meta.key,
    energy: meta.energy,
    transientDensity: meta.transientDensity,
  });
  return meta;
}

function isLoop(meta) {
  if (meta.detectedType === "fx") return false;
  if (meta.bpm == null && meta.detectedType !== "texture") return false;
  return true;
}

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
    if (!s.key || !keyTrusted(s)) continue; // ignore low-confidence keys in the vote
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
  masterPitch: 0,
  align: true,
  projectKey: null, // the global key samples lock to
  keyLock: true, // auto harmonic key-matching on/off
  master: { saturate: 0, compress: 0, makeup: 0 }, // master-bus effects
  analyzing: { active: false, total: 0, done: 0, current: "" },

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
    for (const file of files) {
      try {
        const audioBuffer = await decodeFile(file);
        const meta = await analyzeItem({ file, filename: file.name, audioBuffer, hint: {} });
        const sample = enrich(meta);
        engine.addVoice(meta, audioBuffer, { loop: sample.loop });
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
  },

  _ingest: async (items) => {
    set((s) => ({ analyzing: { ...s.analyzing, total: items.length, done: 0 } }));
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const meta = await analyzeItem(items[i]);
      const sample = enrich(meta);
      engine.addVoice(meta, audioBuffer, { loop: sample.loop });
      out.push(sample);
      set((s) => ({ analyzing: { ...s.analyzing, done: i + 1, current: sample.name }, samples: [...out] }));
      await wait(110);
    }
    await wait(360);
    const projectKey = get().projectKey || pickProjectKey(out);
    set({ view: "ready", deck: buildDeck(out), selectedId: out[0]?.id ?? null, projectKey, analyzing: { active: false, total: 0, done: 0, current: "" } });
    get()._relock();
  },

  reset: () => {
    engine.stopAll();
    get().samples.forEach((s) => engine.removeVoice(s.id));
    set({ view: "empty", samples: [], deck: [], selectedId: null, playing: {}, projectKey: null });
  },

  // --- key lock: harmonically match every sample to the project key ---
  // Smart match: samples already compatible (same key, relative major/minor,
  // neighbours) stay put; only out-of-key sounds shift, by the smallest move.
  // A manual per-sample `tune` rides on top so anything can be fixed by hand.
  _relock: () => {
    const { samples, projectKey, keyLock } = get();
    const next = samples.map((s) => {
      const shift = keyLock && s.key && projectKey && keyTrusted(s) ? suggestPitchShift(s.key, projectKey) : 0;
      engine.setKeyShift(s.id, shift);
      return s.keyShift === shift ? s : { ...s, keyShift: shift };
    });
    set({ samples: next });
  },

  setProjectKey: (key) => {
    set({ projectKey: key });
    get()._relock();
  },
  // move the whole project key up/down a semitone (re-locks every sample)
  nudgeProjectKey: (semis) => {
    const pk = get().projectKey;
    if (!pk) return;
    set({ projectKey: transposeKey(pk, semis) });
    get()._relock();
  },
  toggleKeyMode: () => {
    const pk = get().projectKey;
    if (!pk) return;
    set({ projectKey: { tonic: pk.tonic, mode: pk.mode === "min" ? "maj" : "min" } });
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

  stopAll: () => {
    engine.stopAll();
    set({ playing: {} });
  },

  setBpm: (bpm) => {
    bpm = Math.max(60, Math.min(200, Math.round(bpm)));
    engine.setBpm(bpm);
    set({ bpm });
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
