import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store.js";
import { engine } from "../audio/engine.js";
import { typeMeta } from "../lib/types.js";
import { keyShort } from "../audio/musicTheory.js";
import { meter, resample } from "../lib/ascii.js";
import { fmtSemis } from "../lib/format.js";
import WireframeMesh from "./WireframeMesh.jsx";

export default function Screen() {
  const view = useStore((s) => s.view);
  if (view === "empty") return <Empty />;
  if (view === "analyzing") return <Listening />;
  return <Loaded />;
}

// SS.mmm clock, e.g. 02.117
function fmtClock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const whole = Math.floor(s);
  const ms = Math.min(999, Math.round((s - whole) * 1000));
  return `${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

// ---------------------------------------------------------------- ready
function Loaded() {
  const sample = useStore((s) => s.samples.find((x) => x.id === s.selectedId));
  const playing = useStore((s) => (sample ? s.playing[sample.id] : false));
  const align = useStore((s) => s.align);
  const keyLock = useStore((s) => s.keyLock);
  const projectKey = useStore((s) => s.projectKey);
  const cycleType = useStore((s) => s.cycleType);
  const toggleLoop = useStore((s) => s.toggleLoop);
  const headRef = useRef(null);
  const posRef = useRef(null);

  useEffect(() => {
    let raf;
    const tick = () => {
      const head = headRef.current;
      const dur = sample ? sample.duration : 0;
      if (sample && playing) {
        const frac = engine.voicePosition(sample.id);
        if (head) {
          head.style.opacity = "1";
          head.setAttribute("transform", `translate(${(frac * 720).toFixed(1)},0)`);
        }
        if (posRef.current) posRef.current.textContent = `${fmtClock(frac * dur)} / ${fmtClock(dur)}`;
      } else {
        if (head) head.style.opacity = "0";
        if (posRef.current) posRef.current.textContent = `${fmtClock(0)} / ${fmtClock(dur)}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sample, playing]);

  if (!sample) return null;
  const tm = typeMeta(sample.detectedType);
  const aligned = align && sample.trim > 0.004;

  return (
    <div className="disp">
      <div className="disp-top">
        <span className="disp-name glow">{sample.name}</span>
        <span className="disp-role">
          <span className="role-type edit" title="Click to change type" onClick={() => cycleType(sample.id)}>[{tm.letter}] {tm.full}</span>
          {" · "}
          <span
            className="role-loop edit"
            title={`${sample.loop ? "Loop — latches on/off" : "One-shot — punches on every press"} · click to switch`}
            onClick={() => toggleLoop(sample.id)}
          >{sample.loop ? "LOOP" : "ONE-SHOT"}</span>
        </span>
      </div>

      <div className="disp-mesh">
        <WireframeMesh waveformData={sample.waveformData} playheadRef={headRef} />
        <div className="disp-ticks">
          {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
            <span key={i}>{(f * sample.duration).toFixed(1)}</span>
          ))}
        </div>
      </div>

      <div className="disp-meta">
        <span>{sample.bpm ? <><b>{sample.bpm}</b> BPM</> : <b>ONE-SHOT</b>}</span>
        <span>KEY <b>{sample.key ? keyShort(sample.key).toUpperCase() : "--"}</b></span>
        <span>LEN <b>{sample.duration}S</b></span>
        <span className={aligned ? "lit" : ""}>{aligned ? `TRIM -${Math.round(sample.trim * 1000)}MS` : "@ 0"}</span>
        {keyLock && sample.key && projectKey && (
          <span className={sample.keyShift ? "lit" : ""}>
            {sample.keyShift ? `▸ ${keyShort(projectKey).toUpperCase()} ${fmtSemis(sample.keyShift)}` : "IN KEY"}
          </span>
        )}
        {sample.tune ? <span className="lit">TUNE {fmtSemis(sample.tune)}</span> : null}
        <span className="disp-sp" />
        <span className="disp-pos">POS <b ref={posRef}>{fmtClock(0)} / {fmtClock(sample.duration)}</b></span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- empty
function PerspectiveGrid() {
  const lines = [];
  for (let j = 0; j <= 12; j++) lines.push(`M 360 0 L ${(j / 12) * 720} 360`); // converging verticals
  for (let k = 1; k <= 6; k++) lines.push(`M 0 ${360 * Math.pow(k / 6, 1.8)} L 720 ${360 * Math.pow(k / 6, 1.8)}`);
  return (
    <svg className="drop-grid" viewBox="0 0 720 360" preserveAspectRatio="none" aria-hidden="true">
      {lines.map((d, i) => <path key={i} d={d} className="pg-line" />)}
    </svg>
  );
}

function Empty() {
  const loadDemo = useStore((s) => s.loadDemo);
  const loadFiles = useStore((s) => s.loadFiles);
  const folderInput = useRef(null);
  const [over, setOver] = useState(false);

  return (
    <div className="scr-empty">
      <div
        className={`drop${over ? " over" : ""}`}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files?.length) loadFiles(e.dataTransfer.files);
        }}
      >
        <PerspectiveGrid />
        <div className="drop-body">
          <div className="drop-session">SESSION 09 · 00:00:00</div>
          <div className="drop-prompt b2">&gt; MOSAIC SAMPLER<span className="cur">█</span></div>
          <div className="drop-sub">DROP A FOLDER OF SAMPLES</div>
          <div className="drop-fmt">WAV · AIFF · MP3 · OGG · UP TO 256 FILES</div>
          <div className="drop-actions">
            <button className="btn-demo" onClick={() => loadDemo()}>[ TRY DEMO ]</button>
            <button className="btn-browse" onClick={() => folderInput.current?.click()}>[ BROWSE… ]</button>
            <button className="btn-browse off" disabled>[ EXAMPLE PACK ]</button>
          </div>
          <div className="drop-privacy">
            <div>▸ ANY FILES YOU DROP STAY IN YOUR BROWSER. NO UPLOAD. NO ACCOUNT.</div>
            <div>▸ MOSAIC SAMPLER ANALYZES BPM · KEY · TYPE · TRIM ON-DEVICE.</div>
          </div>
        </div>
        <input
          ref={folderInput}
          type="file"
          multiple
          webkitdirectory=""
          directory=""
          accept="audio/*"
          hidden
          onChange={(e) => e.target.files?.length && loadFiles(e.target.files)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- scanning
function ScanReveal({ sample, pct }) {
  const bars = resample(sample.waveformData, 72);
  const trimFrac = sample.duration > 0 ? Math.min(1, sample.trim / sample.duration) : 0;
  const W = 600, H = 90, mid = H / 2;
  return (
    <div className="scan-reveal">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {bars.map((v, i) => {
          const x = (i / (bars.length - 1)) * W;
          const h = Math.max(1, v * (H * 0.86));
          const past = i / (bars.length - 1) <= pct;
          return (
            <line key={i} x1={x} y1={mid - h / 2} x2={x} y2={mid + h / 2}
              stroke="var(--phos)" strokeWidth="2" strokeOpacity={past ? 1 : 0.18} />
          );
        })}
        <line x1={trimFrac * W} y1="0" x2={trimFrac * W} y2={H}
          stroke="var(--phos-2)" strokeWidth="1" strokeDasharray="3 2" />
      </svg>
      <span className="scan-trim" style={{ left: `${trimFrac * 100}%` }}>TRIM -{Math.round(sample.trim * 1000)}MS</span>
    </div>
  );
}

function Listening() {
  const { done, total, current } = useStore((s) => s.analyzing);
  const samples = useStore((s) => s.samples);
  const pct = total ? done / total : 0;
  const cur = samples[samples.length - 1] || null;

  return (
    <div className="scan">
      <div className="panel scan-lib">
        <span className="panel-label">Library · {done} / {total}</span>
        <div className="scan-rows">
          {Array.from({ length: total || 0 }).map((_, i) => {
            const s = samples[i];
            const state = i < done ? "done" : i === done ? "now" : "pend";
            const tm = s ? typeMeta(s.detectedType) : null;
            return (
              <div className={`scan-row ${state}`} key={i}>
                <span className="lib-letter">[{tm ? tm.letter : "?"}]</span>
                <span className="lib-name">{s ? s.name : "————"}</span>
                <span className="scan-ind">{state === "done" ? "✓" : state === "now" ? "··" : "·"}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel scan-analyzer">
        <span className="panel-label">Analyzer</span>
        <div className="scan-head b2">SCANNING FOLDER<span className="cur">█</span></div>
        <div className="scan-prog">
          <span className="meter">[{meter(pct, 18)}]</span>
          <span className="b2">{Math.round(pct * 100)}%</span>
        </div>
        <div className="scan-status">
          <span className="b2">{String(done).padStart(2, "0")}</span>
          <span className="dim"> / </span>
          <span>{String(total).padStart(2, "0")}</span>
          <span className="dim"> · </span>
          <span>{current || "…"}</span>
          <span className="dim"> · </span>
          <span className="b2 pulse">analyzing trim…</span>
        </div>
        {cur && <ScanReveal sample={cur} pct={pct} />}
        <div className="scan-fields">
          <span><i>BPM</i> <b>{cur?.bpm ?? "—"}</b></span>
          <span><i>KEY</i> <b>{cur?.key ? keyShort(cur.key).toUpperCase() : "—"}</b></span>
          <span><i>TYPE</i> <b>{cur ? `[${typeMeta(cur.detectedType).letter}] ${typeMeta(cur.detectedType).full}` : "—"}</b></span>
          <span><i>LEN</i> <b>{cur ? `${cur.duration}S` : "—"}</b></span>
        </div>
      </div>
    </div>
  );
}
