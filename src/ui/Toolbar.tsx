import { useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Copy, Download, Maximize2, Pause, Play, Redo2, RotateCcw, Save, Settings, SkipForward, Undo2, Upload } from 'lucide-react';
import { useLab } from '../store';
import { ms, n0, pc } from '../fmt';

const PRESETS = [1, 10, 50, 100, 500, 1000, 5000];
const MAXL = 5000;
const toPos = (v: number) => (Math.log10(Math.max(1, v)) / Math.log10(MAXL)) * 100;
const fromPos = (p: number) => Math.round(Math.pow(10, (p / 100) * Math.log10(MAXL)));

export function Toolbar() {
  const s = useLab();
  const rf = useReactFlow();
  const file = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const load = s.arch.settings.offeredLoad; const g = s.snap.global;
  const hc = g.health === 'healthy' ? 'var(--good)' : g.health === 'degraded' ? 'var(--warn)' : 'var(--bad)';
  return (
    <header className="panel" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderWidth: '0 0 1px 0', flexWrap: 'wrap', position: 'relative', zIndex: 20 }}>
      <b style={{ fontSize: 14, marginRight: 4 }}>System Design Virtual Lab </b>
      <h6>Tanvi Jagade D12B-19 </h6><br />
      <h6>Riya Bhatt D12B-07 </h6>
      <button className="btn icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!s.past.length} onClick={s.undo}><Undo2 size={14} /></button>
      <button className="btn icon" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!s.future.length} onClick={s.redo}><Redo2 size={14} /></button>
      <span style={{ width: 1, height: 22, background: 'var(--line)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} title="Offered load: messages published per second by clients">
        <span className="lbl">Offered load</span>
        <input type="range" min={0} max={100} step={0.5} value={toPos(load)} aria-label="Offered load slider" style={{ width: 130 }} onChange={(e) => s.setLoad(fromPos(+e.target.value))} />
        <input className="inp mono" type="number" min={0} max={100000} style={{ width: 74 }} aria-label="Offered load msg/s" value={load} onChange={(e) => s.setLoad(+e.target.value)} />
        <span className="lbl">msg/s</span>
        {PRESETS.map((p) => <button key={p} className="chip" style={{ cursor: 'pointer', borderColor: load === p ? 'var(--accent)' : undefined }} onClick={() => s.setLoad(p)}>{p >= 1000 ? p / 1000 + 'k' : p}</button>)}
      </div>
      <span style={{ width: 1, height: 22, background: 'var(--line)' }} />
      <button className="btn primary" onClick={() => s.setRunning(!s.running)} title="Run / pause (Space)">{s.running ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Run</>}</button>
      <button className="btn" onClick={s.stepOnce} title="Advance 100 ms (.)"><SkipForward size={14} /> Step</button>
      <button className="btn" onClick={s.resetSim} title="Reset simulation state"><RotateCcw size={14} /> Reset</button>
      <select className="inp" aria-label="Speed" value={s.speed} onChange={(e) => s.set({ speed: +e.target.value })}>{[0.25, 0.5, 1, 2, 5, 10].map((v) => <option key={v} value={v}>{v}× speed</option>)}</select>
      <div style={{ flex: 1 }} />
      <span className="chip" title="End-to-end P99 over the last 10 s of simulated time">P99 <b className="mono">{ms(g.p99)}</b></span>
      <span className="chip" title="Messages completed per second">Done <b className="mono">{n0(g.completed)}/s</b></span>
      <span className="chip" title="Dropped or lost work as a share of offered">Errors <b className="mono">{pc(g.errorRate)}</b></span>
      <span className="chip" title="Overall health"><i className="dot" style={{ background: hc }} /><b>{g.health}</b></span>
      <button className="btn icon" aria-label="Fit to screen" title="Fit to screen (F)" onClick={() => rf.fitView({ padding: 0.12, duration: 300 })}><Maximize2 size={14} /></button>
      <button className="btn" onClick={s.save} title="Save to this browser"><Save size={14} /> Save</button>
      <button className="btn icon" aria-label="Export JSON" title="Export JSON file" onClick={s.exportJson}><Download size={14} /></button>
      <button className="btn icon" aria-label="Import JSON" title="Import JSON file" onClick={() => file.current?.click()}><Upload size={14} /></button>
      <button className="btn icon" aria-label="Copy JSON" title="Copy architecture JSON (share)" onClick={s.copyJson}><Copy size={14} /></button>
      <input ref={file} type="file" accept="application/json,.json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) s.importJson(await f.text()); e.target.value = ''; }} />
      <div style={{ position: 'relative' }}>
        <button className="btn icon" aria-label="Settings" onClick={() => setMenu(!menu)}><Settings size={14} /></button>
        {menu && (
          <div className="panel" style={{ position: 'absolute', right: 0, top: 34, width: 250, padding: 10, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 50 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>Random seed <input className="inp mono" type="number" style={{ width: 90 }} value={s.arch.settings.seed} onChange={(e) => s.setSeed(+e.target.value)} /></label>
            <span style={{ color: 'var(--mute)', fontSize: 11 }}>Seed applies on Reset.</span>
            <label><input type="checkbox" checked={s.showMiniMap} onChange={(e) => s.set({ showMiniMap: e.target.checked })} /> Show minimap</label>
            <label><input type="checkbox" checked={s.showBottom} onChange={(e) => s.set({ showBottom: e.target.checked })} /> Show bottom panel</label>
            <button className="btn" onClick={() => { s.loadSaved(); setMenu(false); }}>Load saved architecture</button>
            <button className="btn" onClick={() => { s.resetToDefault(); setMenu(false); }}>Reset to default Mini Discord</button>
          </div>
        )}
      </div>
    </header>
  );
}
