import { create } from 'zustand';
import { Engine, DT, type Snapshot } from './engine/engine';
import { DEFS, DEFAULT_EDGE } from './engine/definitions';
import { defaultArchitecture, PRESETS } from './engine/presets';
import { edgeId, parseArchitecture, serializeArchitecture, validateArchitecture, validateConnection } from './engine/validate';
import type { Architecture, ArchEdge, EdgeConfig, FaultKind } from './engine/types';

const DRAFT = 'dslab.draft.v1', SAVED = 'dslab.saved.v1';
function loadFrom(key: string): Architecture | null {
  try { const t = localStorage.getItem(key); return t ? parseArchitecture(t) : null; } catch { return null; }
}

export const engine = new Engine(loadFrom(DRAFT) ?? defaultArchitecture());

export type BottomTab = 'metrics' | 'failures' | 'experiments' | 'traces' | 'model';
interface Lab {
  arch: Architecture; selected: string[]; selectedEdge: string | null;
  past: Architecture[]; future: Architecture[];
  running: boolean; speed: number; snap: Snapshot; zoom: number; fitSignal: number;
  hlNodes: string[]; hlEdges: string[]; hlTrace: number | null;
  bottomTab: BottomTab; showBottom: boolean; showMiniMap: boolean; search: string;
  toast: { text: string; kind: 'info' | 'error' } | null; issues: { errors: string[]; warnings: string[] };
  mutate(fn: (a: Architecture) => void, o?: { history?: boolean; coalesce?: string }): void;
  pushHistory(): void; undo(): void; redo(): void;
  addNode(type: string, pos: { x: number; y: number }): void;
  removeSelection(): void; connect(s: string, sp: string | null | undefined, t: string, tp: string | null | undefined): void;
  rename(id: string, name: string): void; setConfig(id: string, key: string, v: number | boolean | string): void;
  setEdgeConfig(id: string, patch: Partial<EdgeConfig>): void; setPosition(id: string, x: number, y: number): void;
  setLoad(v: number): void; setSeed(v: number): void;
  setSelection(ids: string[], edge?: string | null): void;
  setRunning(b: boolean): void; stepOnce(): void; resetSim(): void;
  inject(kind: FaultKind, target: string, duration: number, amount?: number): void; clearFault(id: number): void; clearFaults(): void;
  runPreset(id: string): void; highlightTrace(id: number | null): void;
  save(): void; loadSaved(): void; resetToDefault(): void; exportJson(): void; importJson(text: string): void; copyJson(): void;
  say(text: string, kind?: 'info' | 'error'): void;
  set(p: Partial<Lab>): void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let lastCoalesce = { key: '', t: 0 };

export const useLab = create<Lab>((set, get) => ({
  arch: engine.arch, selected: [], selectedEdge: null, past: [], future: [],
  running: false, speed: 1, snap: engine.snapshot(), zoom: 1, fitSignal: 0,
  hlNodes: [], hlEdges: [], hlTrace: null, bottomTab: 'metrics', showBottom: true, showMiniMap: true, search: '',
  toast: null, issues: validateArchitecture(engine.arch),

  set: (p) => set(p),
  say(text, kind = 'info') {
    clearTimeout(toastTimer); set({ toast: { text, kind } });
    toastTimer = setTimeout(() => set({ toast: null }), 3500);
  },
  mutate(fn, o = {}) {
    const prev = get().arch; const next = structuredClone(prev); fn(next);
    const hist = o.history !== false;
    let skip = false;
    if (o.coalesce) { const now = Date.now(); skip = lastCoalesce.key === o.coalesce && now - lastCoalesce.t < 1200; lastCoalesce = { key: o.coalesce, t: now }; }
    set(hist && !skip ? { arch: next, past: [...get().past.slice(-99), prev], future: [] } : { arch: next });
  },
  pushHistory() { set({ past: [...get().past.slice(-99), get().arch], future: [] }); },
  undo() {
    const { past, arch, future } = get(); if (!past.length) return;
    set({ arch: past[past.length - 1], past: past.slice(0, -1), future: [arch, ...future], selected: [], selectedEdge: null });
  },
  redo() {
    const { past, arch, future } = get(); if (!future.length) return;
    set({ arch: future[0], future: future.slice(1), past: [...past, arch], selected: [], selectedEdge: null });
  },
  addNode(type, pos) {
    const def = DEFS[type]; if (!def) return;
    const a = get().arch; let k = 1; const same = a.nodes.filter((n) => n.type === type).length;
    while (a.nodes.some((n) => n.id === `${type}-${k}`)) k++;
    const id = `${type}-${k}`;
    get().mutate((x) => x.nodes.push({
      id, type, name: same ? `${def.label} ${same + 1}` : def.label, position: { x: Math.round(pos.x), y: Math.round(pos.y) },
      config: { ...def.defaults }, health: 'healthy', executionMode: 'simulation',
    }));
    set({ selected: [id], selectedEdge: null });
  },
  removeSelection() {
    const { selected, selectedEdge } = get();
    if (!selected.length && !selectedEdge) return;
    get().mutate((a) => {
      a.nodes = a.nodes.filter((n) => !selected.includes(n.id));
      a.edges = a.edges.filter((e) => e.id !== selectedEdge && !selected.includes(e.sourceNodeId) && !selected.includes(e.targetNodeId));
    });
    set({ selected: [], selectedEdge: null });
  },
  connect(s, sp, t, tp) {
    const err = validateConnection(get().arch, s, sp, t, tp);
    if (err) { get().say(err, 'error'); return; }
    const lat = DEFS[get().arch.nodes.find((n) => n.id === s)!.type].role === 'source' ? 25 : DEFAULT_EDGE.latencyMs;
    const e: ArchEdge = { id: edgeId(s, sp!, t, tp!), sourceNodeId: s, sourcePort: sp!, targetNodeId: t, targetPort: tp!, config: { ...DEFAULT_EDGE, latencyMs: lat } };
    get().mutate((a) => { a.edges.push(e); });
  },
  rename(id, name) { get().mutate((a) => { const n = a.nodes.find((x) => x.id === id); if (n) n.name = name; }, { coalesce: 'name:' + id }); },
  setConfig(id, key, v) { get().mutate((a) => { const n = a.nodes.find((x) => x.id === id); if (n) n.config[key] = v; }, { coalesce: `cfg:${id}:${key}` }); },
  setEdgeConfig(id, patch) { get().mutate((a) => { const e = a.edges.find((x) => x.id === id); if (e) Object.assign(e.config, patch); }, { coalesce: 'edge:' + id + Object.keys(patch).join() }); },
  setPosition(id, x, y) { get().mutate((a) => { const n = a.nodes.find((q) => q.id === id); if (n) n.position = { x, y }; }, { history: false }); },
  setLoad(v) { get().mutate((a) => { a.settings.offeredLoad = Math.max(0, Math.round(v)); }, { history: false }); },
  setSeed(v) { get().mutate((a) => { a.settings.seed = Math.max(0, Math.floor(v) || 0); }, { history: false }); },
  setSelection(ids, edge = null) { set({ selected: ids, selectedEdge: edge }); },

  setRunning(b) { set({ running: b }); if (b) startLoop(); },
  stepOnce() { set({ running: false }); engine.step(); set({ snap: engine.snapshot() }); },
  resetSim() { engine.reset(); set({ snap: engine.snapshot(), hlNodes: [], hlEdges: [], hlTrace: null }); },
  inject(kind, target, duration, amount) {
    engine.inject({ kind, target, startAt: engine.t, until: duration > 0 ? engine.t + duration : undefined, amount });
    set({ snap: engine.snapshot() });
    if (!get().running) get().say('Fault armed. Press Run to see its effect.');
  },
  clearFault(id) { engine.clearFault(id); set({ snap: engine.snapshot() }); },
  clearFaults() { engine.clearFaults(); set({ snap: engine.snapshot() }); },
  runPreset(id) {
    const p = PRESETS.find((x) => x.id === id); if (!p) return;
    const arch = p.build();
    set({ arch, past: [...get().past.slice(-99), get().arch], future: [], selected: [], selectedEdge: null });
    engine.sync(arch); engine.reset();
    for (const f of p.faults) engine.inject({ kind: f.kind, target: f.target, startAt: f.at, until: f.duration ? f.at + f.duration : undefined, amount: f.amount });
    set({ snap: engine.snapshot(), fitSignal: get().fitSignal + 1, hlNodes: [], hlEdges: [] });
    get().setRunning(true); get().say(`Experiment: ${p.name}`);
  },
  highlightTrace(id) {
    if (id == null || get().hlTrace === id) { set({ hlTrace: null, hlNodes: [], hlEdges: [] }); return; }
    const tr = get().snap.traces.find((t) => t.id === id); if (!tr) return;
    const edges = get().arch.edges.filter((e) => { const i = tr.path.indexOf(e.sourceNodeId); return i >= 0 && tr.path[i + 1] === e.targetNodeId; }).map((e) => e.id);
    set({ hlTrace: id, hlNodes: tr.path, hlEdges: edges });
  },
  save() { try { localStorage.setItem(SAVED, serializeArchitecture(get().arch)); get().say('Architecture saved to this browser.'); } catch { get().say('Could not save (storage unavailable).', 'error'); } },
  loadSaved() {
    const a = loadFrom(SAVED);
    if (!a) { get().say('No saved architecture found in this browser.', 'error'); return; }
    set({ arch: a, past: [...get().past, get().arch], future: [], selected: [], selectedEdge: null }); engine.sync(a); engine.reset(); set({ snap: engine.snapshot(), fitSignal: get().fitSignal + 1 }); get().say('Loaded saved architecture.');
  },
  resetToDefault() {
    const a = defaultArchitecture();
    set({ arch: a, past: [...get().past, get().arch], future: [], selected: [], selectedEdge: null, running: false }); engine.sync(a); engine.reset(); set({ snap: engine.snapshot(), fitSignal: get().fitSignal + 1 });
  },
  exportJson() {
    const url = URL.createObjectURL(new Blob([serializeArchitecture(get().arch)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'architecture.json'; a.click(); URL.revokeObjectURL(url);
  },
  copyJson() {
    navigator.clipboard.writeText(serializeArchitecture(get().arch)).then(() => get().say('Architecture JSON copied to clipboard.'), () => get().say('Clipboard unavailable.', 'error'));
  },
  importJson(text) {
    try {
      const a = parseArchitecture(text);
      set({ arch: a, past: [...get().past, get().arch], future: [], selected: [], selectedEdge: null }); engine.sync(a); engine.reset(); set({ snap: engine.snapshot(), fitSignal: get().fitSignal + 1 }); get().say('Architecture imported.');
    } catch (e) { get().say((e as Error).message, 'error'); }
  },
}));

// ── keep engine + validation + draft in sync with the architecture ──
let draftTimer: ReturnType<typeof setTimeout> | undefined;
useLab.subscribe((s, p) => {
  if (s.arch === p.arch) return;
  engine.sync(s.arch);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    useLab.setState({ issues: validateArchitecture(useLab.getState().arch), snap: engine.snapshot() });
    try { localStorage.setItem(DRAFT, serializeArchitecture(useLab.getState().arch)); } catch { /* ignore */ }
  }, 250);
});

// ── simulation loop: fixed-step engine, wall-clock paced, time-budgeted per frame ──
let raf = 0, last = 0, acc = 0, lastSnap = 0;
function loop(ts: number) {
  const s = useLab.getState();
  if (!s.running) { raf = 0; return; }
  const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
  acc += dt * s.speed;
  const t0 = performance.now();
  while (acc >= DT && performance.now() - t0 < 10) { engine.step(); acc -= DT; }
  if (acc > DT * 30) acc = 0; // can't keep up: drop backlog instead of spiralling
  if (ts - lastSnap > 150) { lastSnap = ts; useLab.setState({ snap: engine.snapshot() }); }
  raf = requestAnimationFrame(loop);
}
function startLoop() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } }
