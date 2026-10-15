/**
 * Discrete-time fluid simulation engine (no React, no DOM).
 *
 * Model summary (see README "Simulation model"):
 *  - Fixed time step DT = 100 ms of simulated time. Fully deterministic; the only randomness is a seeded
 *    PRNG used for small per-hop service-time jitter.
 *  - Work is moved as "cohorts" (batches carrying a fractional message count `n`, birth time and a stage).
 *    Counts are real numbers (expected values), not individual packets.
 *  - Every processing component is a FIFO queue served at a fixed rate (capacity units/second). Queue
 *    capacity bounds waiting work; overflow is dropped. Waiting time is the real FIFO delay.
 *  - Latency is measured per cohort (queue wait + processing + network) and percentiles are computed
 *    over a weighted rolling 10 s window.
 *  - Utilization = units served in the last 2 s / (current capacity * 2 s).
 *  - Illustrative defaults only; the model is not calibrated against real AWS/Redis measurements.
 */
import type { Architecture, ArchNode, Config, EdgeConfig, Fault, Health } from './types';
import { DEFS, type Role } from './definitions';
import { mulberry32 } from './rng';

export const DT = 0.1;
const WIN = 20; // rate window in ticks (2 s)
const LAT_WIN = 10; // latency window in seconds

type Stage = 'publish' | 'broadcast' | 'deliver' | 'persist' | 'heartbeat';
export interface Hop { node: string; t: number; wait: number; note?: string }
export interface Trace { id: number; root: number; status: 'inflight' | 'delivered' | 'dropped'; bornAt: number; e2eMs?: number; hops: Hop[] }
/** `age` = accumulated modeled latency in ms (edge + queue wait + processing). Independent of tick quantization. */
interface Cohort { stage: Stage; n: number; msgs: number; born: number; age: number; origin: string; dest?: string; enq: number; attempt: number; trace?: Trace }
interface Sample { t: number; ms: number; w: number }
interface Proc { q: Cohort[]; len: number }

class Ring {
  b = new Float64Array(WIN); i = 0;
  push(v: number) { this.b[this.i] += v; }
  next() { this.i = (this.i + 1) % WIN; this.b[this.i] = 0; }
  sum() { let s = 0; for (let k = 0; k < WIN; k++) s += this.b[k]; return s; }
}

interface NodeRT {
  id: string; type: string; role: Role; name: string; cfg: Config;
  ing: Proc; egr: Proc; crashedAt: number | null;
  byGw: Record<string, number>; pool: number; lost: number; admitCarry: number; rr: number; rebalCarry: number;
  buf: Cohort[]; bufLen: number; conns: number; fan: number;
  arrived: Ring; arrivedE: Ring; served: Ring; servedE: Ring; dropped: Ring; ovf: Ring; completed: Ring;
  lat: Sample[]; reasons: Record<string, number>;
}
interface EdgeRT {
  id: string; src: string; sp: string; dst: string; tp: string; cfg: EdgeConfig;
  inflight: { c: Cohort; at: number }[]; sent: Ring; dropped: Ring; used: number;
}
interface Mods {
  capM: Map<string, number>; qM: Map<string, number>; extraMs: Map<string, number>;
  edgeExtra: Map<string, number>; edgeDown: Set<string>; spike: number;
}

export interface NodeMetrics {
  health: Health; util: number; utilIngress: number; utilEgress: number; p50: number; p99: number;
  waiting: number; waitingEgress: number; arrival: number; throughput: number; dropRate: number;
  capacity: number; conns: number; pool: number; lost: number; buffered: number;
  reasons: Record<string, number>; crashed: boolean; entries: number; connected: number;
}
export interface EdgeMetrics { rate: number; dropRate: number; down: boolean }
export interface GlobalMetrics {
  offered: number; accepted: number; completed: number; delivered: number; expectedDeliveries: number;
  dropped: number; persistFailures: number; errorRate: number; deliveryRatio: number;
  p50: number; p95: number; p99: number; queueDepth: number; connected: number; pending: number; lost: number;
  health: 'healthy' | 'degraded' | 'critical'; spike: number;
}
export interface HistPoint { t: number; offered: number; completed: number; dropped: number; p50: number; p95: number; p99: number; errorPct: number; queue: number }
export interface TraceView { id: number; root: number; status: Trace['status']; e2eMs?: number; bornAt: number; path: string[]; hops: Hop[] }
export interface Snapshot {
  t: number; global: GlobalMetrics; nodes: Record<string, NodeMetrics>; edges: Record<string, EdgeMetrics>;
  bottleneck: { nodeId: string; text: string } | null; traces: TraceView[]; faults: Fault[]; history: HistPoint[];
}

const num = (rt: NodeRT, key: string): number => {
  const v = rt.cfg[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const d = DEFS[rt.type]?.defaults[key];
  return typeof d === 'number' ? d : 0;
};
const str = (rt: NodeRT, key: string): string => String(rt.cfg[key] ?? DEFS[rt.type]?.defaults[key] ?? '');
const bool = (rt: NodeRT, key: string): boolean => {
  const v = rt.cfg[key] ?? DEFS[rt.type]?.defaults[key];
  return v === true;
};

function pct(s: Sample[], ps: number[]): number[] {
  let tot = 0;
  for (const x of s) tot += x.w;
  if (tot <= 0) return ps.map(() => 0);
  const a = [...s].sort((x, y) => x.ms - y.ms);
  const res: number[] = [];
  let cum = 0, i = 0;
  for (const p of ps) {
    const target = p * tot;
    while (i < a.length - 1 && cum + a[i].w < target) { cum += a[i].w; i++; }
    res.push(a[i].ms);
  }
  return res;
}

const newG = () => ({
  offered: new Ring(), accepted: new Ring(), completed: new Ring(), delivered: new Ring(),
  expected: new Ring(), errors: new Ring(), persistErr: new Ring(),
});
const newMods = (): Mods => ({ capM: new Map(), qM: new Map(), extraMs: new Map(), edgeExtra: new Map(), edgeDown: new Set(), spike: 1 });
const EMPTY: EdgeRT[] = [];

export class Engine {
  arch!: Architecture;
  t = 0; tick = 0; offered = 100; rng = mulberry32(1);
  nodes = new Map<string, NodeRT>(); edges = new Map<string, EdgeRT>(); order: NodeRT[] = [];
  faults: Fault[] = [];
  private out = new Map<string, EdgeRT[]>(); private fseq = 0;
  private g = newG(); private e2e: Sample[] = []; private hist: HistPoint[] = []; private lastHist = 0;
  private traces: Trace[] = []; private tseq = 0; private lastTraceT = -1;
  private totalConns = 0; private expPerMsg = 0;
  private m: Mods = newMods();

  constructor(arch: Architecture) { this.arch = arch; this.reset(); }

  // ───────────── lifecycle ─────────────
  reset() {
    this.rng = mulberry32(this.arch.settings.seed);
    this.t = 0; this.tick = 0; this.nodes.clear(); this.edges.clear(); this.faults = []; this.fseq = 0;
    this.g = newG(); this.e2e = []; this.hist = []; this.lastHist = 0; this.traces = []; this.tseq = 0; this.lastTraceT = -1;
    this.m = newMods();
    this.sync(this.arch);
    this.refresh();
    for (const c of this.order) if (c.role === 'source') { this.admit(c, Math.floor(c.pool)); c.reasons = {}; }
    this.refresh();
  }

  /** Apply an edited architecture without losing runtime state of unchanged components. */
  sync(arch: Architecture) {
    this.arch = arch; this.offered = arch.settings.offeredLoad;
    const ids = new Set(arch.nodes.map((n) => n.id));
    for (const id of [...this.nodes.keys()]) if (!ids.has(id)) this.nodes.delete(id);
    for (const n of arch.nodes) {
      const ex = this.nodes.get(n.id);
      if (ex && ex.type === n.type) { ex.cfg = n.config; ex.name = n.name; } else this.nodes.set(n.id, this.mk(n));
    }
    const eids = new Set(arch.edges.map((e) => e.id));
    for (const id of [...this.edges.keys()]) if (!eids.has(id)) this.edges.delete(id);
    for (const e of arch.edges) {
      const ex = this.edges.get(e.id);
      if (ex) ex.cfg = e.config;
      else this.edges.set(e.id, { id: e.id, src: e.sourceNodeId, sp: e.sourcePort, dst: e.targetNodeId, tp: e.targetPort, cfg: e.config, inflight: [], sent: new Ring(), dropped: new Ring(), used: 0 });
    }
    this.order = arch.nodes.map((n) => this.nodes.get(n.id)!);
    this.out.clear();
    for (const e of this.edges.values()) {
      const k = e.src + '|' + e.sp;
      const l = this.out.get(k); if (l) l.push(e); else this.out.set(k, [e]);
    }
  }

  private mk(n: ArchNode): NodeRT {
    const def = DEFS[n.type];
    const rt: NodeRT = {
      id: n.id, type: n.type, role: def.role, name: n.name, cfg: n.config,
      ing: { q: [], len: 0 }, egr: { q: [], len: 0 }, crashedAt: null,
      byGw: {}, pool: 0, lost: 0, admitCarry: 0, rr: 0, rebalCarry: 0, buf: [], bufLen: 0, conns: 0, fan: 0,
      arrived: new Ring(), arrivedE: new Ring(), served: new Ring(), servedE: new Ring(), dropped: new Ring(), ovf: new Ring(), completed: new Ring(),
      lat: [], reasons: {},
    };
    if (def.role === 'source') rt.pool = num(rt, 'connections');
    return rt;
  }

  // ───────────── public controls ─────────────
  advance(seconds: number) { const k = Math.round(seconds / DT); for (let i = 0; i < k; i++) this.step(); }

  inject(f: Omit<Fault, 'id'>): number { const id = ++this.fseq; this.faults.push({ ...f, id }); return id; }
  clearFault(id: number) { this.faults = this.faults.filter((f) => f.id !== id); }
  clearFaults() { this.faults = []; }

  // ───────────── helpers ─────────────
  private outEdges(id: string, port: string) { return this.out.get(id + '|' + port) ?? EMPTY; }
  private edgeUp(e: EdgeRT) { return e.cfg.available && !this.m.edgeDown.has(e.id); }
  private cap(rt: NodeRT, kind: 'ing' | 'egr') {
    if (rt.crashedAt != null) return 0;
    return (kind === 'egr' ? num(rt, 'egressCapacity') : num(rt, 'capacity')) * (this.m.capM.get(rt.id) ?? 1);
  }
  private qcap(rt: NodeRT, kind: 'ing' | 'egr') {
    return (kind === 'egr' ? num(rt, 'egressQueueCapacity') : num(rt, 'queueCapacity')) * (this.m.qM.get(rt.id) ?? 1);
  }
  private share(rt: NodeRT | undefined) { return rt && this.totalConns > 0 ? rt.conns / this.totalConns : 0; }
  private connected(c: NodeRT) { let s = 0; for (const k in c.byGw) s += c.byGw[k]; return s; }
  private sample(arr: Sample[], t: number, ms: number, w: number) { if (w > 1e-9) arr.push({ t, ms, w }); }
  private win() { return (Math.min(this.tick, WIN) * DT) || DT; }

  private errEq(c: Cohort, n: number): number {
    switch (c.stage) {
      case 'deliver': return this.expPerMsg > 0 ? n / this.expPerMsg : n;
      case 'publish': return c.msgs > 0 ? n : n * (1 - this.share(this.nodes.get(c.origin)));
      case 'broadcast': return n * this.share(this.nodes.get(c.dest ?? ''));
      default: return 0;
    }
  }
  private drop(rt: NodeRT | null, c: Cohort, n: number, reason: string) {
    if (n <= 1e-9) return;
    if (rt) {
      rt.dropped.push(n); rt.reasons[reason] = (rt.reasons[reason] || 0) + n;
      if (reason === 'queue-full' || reason === 'timeout' || reason === 'buffer-full') rt.ovf.push(n);
    }
    if (c.stage === 'persist') this.g.persistErr.push(n);
    else if (c.stage !== 'heartbeat') this.g.errors.push(this.errEq(c, n));
    if (c.trace && c.stage !== 'heartbeat') { c.trace.status = 'dropped'; c.trace.hops.push({ node: rt?.id ?? '', t: this.t, wait: 0, note: reason }); }
  }

  private newTrace(c: Cohort, now: number): Trace {
    const id = ++this.tseq;
    const tr: Trace = { id, root: id, status: 'inflight', bornAt: now, hops: [{ node: c.origin, t: now, wait: 0 }] };
    this.traces.push(tr); if (this.traces.length > 40) this.traces.shift();
    return tr;
  }
  private branch(t?: Trace): Trace | undefined {
    if (!t) return undefined;
    const b: Trace = { id: ++this.tseq, root: t.root, status: 'inflight', bornAt: t.bornAt, hops: [...t.hops] };
    this.traces.push(b); if (this.traces.length > 40) this.traces.shift();
    return b;
  }
  private endTrace(c: Cohort) {
    const tr = c.trace;
    if (tr && tr.status === 'inflight') { tr.status = 'delivered'; tr.e2eMs = c.age; }
  }

  // ───────────── faults ─────────────
  private computeMods(now: number) {
    const m = this.m;
    m.capM.clear(); m.qM.clear(); m.extraMs.clear(); m.edgeExtra.clear(); m.edgeDown.clear(); m.spike = 1;
    const crash = new Set<string>();
    for (const f of this.faults) {
      if (f.startAt > now + 1e-9) continue;
      if (f.until != null && now >= f.until) continue;
      switch (f.kind) {
        case 'crash': crash.add(f.target); break;
        case 'partition': {
          const tn = this.nodes.get(f.target);
          for (const e of this.edges.values()) {
            if (e.src !== f.target && e.dst !== f.target) continue;
            const other = this.nodes.get(e.src === f.target ? e.dst : e.src);
            if (tn?.role === 'gateway' && other?.role !== 'broker') continue; // gateway partition = cut from Redis
            m.edgeDown.add(e.id);
          }
          break;
        }
        case 'latency':
          for (const e of this.edges.values()) if (e.src === f.target || e.dst === f.target) m.edgeExtra.set(e.id, (m.edgeExtra.get(e.id) ?? 0) + (f.amount ?? 250));
          break;
        case 'capacity': m.capM.set(f.target, (m.capM.get(f.target) ?? 1) * (f.amount ?? 0.25)); break;
        case 'slow-consumer':
          m.capM.set(f.target, (m.capM.get(f.target) ?? 1) * (f.amount ?? 0.1));
          m.extraMs.set(f.target, (m.extraMs.get(f.target) ?? 0) + 150);
          break;
        case 'queue-overflow': m.qM.set(f.target, Math.min(m.qM.get(f.target) ?? 1, f.amount ?? 0.05)); break;
        case 'spike': m.spike = Math.max(m.spike, f.amount ?? 5); break;
        case 'reconnect-storm':
          if (!f.applied) {
            f.applied = true;
            for (const rt of this.order) if (rt.role === 'gateway' && (!f.target || f.target === rt.id)) this.disconnect(rt.id, f.amount ?? 0.4, 'reconnect-storm');
          }
          break;
      }
    }
    for (const rt of this.order) {
      const should = crash.has(rt.id);
      if (should && rt.crashedAt == null) this.crashNode(rt, now);
      else if (!should && rt.crashedAt != null) rt.crashedAt = null;
    }
  }

  private crashNode(rt: NodeRT, now: number) {
    rt.crashedAt = now;
    for (const p of [rt.ing, rt.egr]) { for (const c of p.q) this.drop(rt, c, c.n, 'crash'); p.q = []; p.len = 0; }
    for (const c of rt.buf) this.drop(rt, c, c.n, 'crash');
    rt.buf = []; rt.bufLen = 0;
    if (rt.role === 'gateway') this.disconnect(rt.id, 1, 'crash');
  }

  // ───────────── connections ─────────────
  private refresh() {
    for (const rt of this.order) if (rt.role === 'gateway') rt.conns = 0;
    for (const c of this.order) {
      if (c.role !== 'source') continue;
      for (const gid of Object.keys(c.byGw)) {
        const gw = this.nodes.get(gid);
        if (!gw || gw.role !== 'gateway') { c.pool += c.byGw[gid]; delete c.byGw[gid]; } else gw.conns += c.byGw[gid];
      }
    }
    this.totalConns = 0;
    for (const rt of this.order) if (rt.role === 'gateway') this.totalConns += rt.conns;
    this.expPerMsg = 0;
    for (const gw of this.order) {
      if (gw.role !== 'gateway') continue;
      gw.fan = 0;
      for (const e of this.outEdges(gw.id, 'deliver')) {
        const t = this.nodes.get(e.dst);
        if (t && t.type === 'subscriber-clients') gw.fan += num(t, 'fanout');
      }
      this.expPerMsg += gw.fan * this.share(gw);
    }
  }

  private reach(startId: string): { gws: NodeRT[]; delay: number; alg: string } {
    const seen = new Set([startId]); const q = [startId]; const gws: NodeRT[] = [];
    let delay = Infinity; let alg = 'round-robin';
    while (q.length) {
      const id = q.shift()!;
      for (const e of this.edges.values()) {
        if (e.src !== id || !this.edgeUp(e)) continue;
        const t = this.nodes.get(e.dst);
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        if (t.role === 'gateway') gws.push(t);
        else if (t.role === 'router' && t.crashedAt == null) {
          if (num(t, 'healthCheckDelaySec') < delay) { delay = num(t, 'healthCheckDelaySec'); alg = str(t, 'algorithm'); }
          q.push(t.id);
        }
      }
    }
    return { gws, delay: Number.isFinite(delay) ? delay : 0, alg };
  }

  private admissible(g: NodeRT) {
    for (const e of this.outEdges(g.id, 'session')) {
      const t = this.nodes.get(e.dst);
      if (t && t.crashedAt != null && t.cfg.requiredForAdmission !== false) return false;
    }
    return true;
  }

  private admit(c: NodeRT, k: number) {
    if (c.crashedAt != null || k <= 0) return 0;
    const { gws, delay, alg } = this.reach(c.id);
    const routable = gws.filter((g) => g.crashedAt == null || this.t - g.crashedAt < delay);
    let done = 0;
    for (let i = 0; i < k; i++) {
      const cand = routable.filter((g) => g.crashedAt != null || g.conns < num(g, 'maxConnections'));
      if (!cand.length) break;
      const g = alg === 'least-connections' ? cand.reduce((a, b) => (b.conns < a.conns ? b : a)) : cand[c.rr++ % cand.length];
      if (g.crashedAt != null || !this.admissible(g)) { c.reasons['connect-refused'] = (c.reasons['connect-refused'] || 0) + 1; continue; }
      c.byGw[g.id] = (c.byGw[g.id] || 0) + 1; g.conns++; c.pool--; done++;
    }
    return done;
  }

  private disconnect(gid: string, frac: number, reason: string) {
    let killed = 0;
    for (const c of this.order) {
      if (c.role !== 'source') continue;
      const by = c.byGw[gid] || 0;
      if (by <= 0) continue;
      let m = by;
      if (frac < 1) { const x = by * frac; m = Math.floor(x); if (this.rng() < x - m) m++; m = Math.min(m, by); }
      c.byGw[gid] = by - m;
      if (c.cfg.autoReconnect !== false) c.pool += m; else c.lost += m;
      killed += m;
    }
    const gw = this.nodes.get(gid);
    if (gw) { gw.conns = Math.max(0, gw.conns - killed); gw.reasons[reason] = (gw.reasons[reason] || 0) + killed; }
    return killed;
  }

  private rebalance(lb: NodeRT) {
    const rate = num(lb, 'rebalanceRate');
    if (rate <= 0 || lb.crashedAt != null) return;
    lb.rebalCarry += rate * DT; let m = Math.floor(lb.rebalCarry); lb.rebalCarry -= m;
    if (m <= 0) return;
    const ok = this.reach(lb.id).gws.filter((g) => g.crashedAt == null && this.admissible(g));
    if (ok.length < 2) return;
    while (m-- > 0) {
      let hi = ok[0], lo = ok[0];
      for (const g of ok) { if (g.conns > hi.conns) hi = g; if (g.conns < lo.conns) lo = g; }
      if (hi.conns - lo.conns < 2 || lo.conns >= num(lo, 'maxConnections')) break;
      const cl = this.order.find((x) => x.role === 'source' && (x.byGw[hi.id] || 0) > 0);
      if (!cl) break;
      cl.byGw[hi.id]--; cl.byGw[lo.id] = (cl.byGw[lo.id] || 0) + 1; hi.conns--; lo.conns++;
    }
  }

  private manageConnections(now: number) {
    this.refresh();
    for (const gw of this.order) {
      if (gw.role !== 'gateway' || gw.crashedAt != null || gw.conns <= 0) continue;
      // heartbeat: ping/pong load shares ingest capacity; a long wait means pongs time out
      const wait = gw.ing.len / Math.max(this.cap(gw, 'ing'), 1e-9);
      if (wait > num(gw, 'heartbeatTimeoutSec')) this.disconnect(gw.id, 1 - Math.pow(0.75, DT), 'heartbeat-timeout');
      const hb = (gw.conns / Math.max(1, num(gw, 'heartbeatSec'))) * DT;
      this.enq(gw, gw.ing, 'ing', { stage: 'heartbeat', n: hb, msgs: 0, born: now, age: 0, origin: gw.id, enq: now, attempt: 0 }, now);
    }
    for (const c of this.order) {
      if (c.role !== 'source') continue;
      const target = Math.floor(num(c, 'connections'));
      const total = this.connected(c) + c.pool + c.lost;
      if (target > total) c.pool += target - total;
      else if (target < total) {
        let ex = total - target;
        const fp = Math.min(ex, c.pool); c.pool -= fp; ex -= fp;
        for (const gid of Object.keys(c.byGw)) { const t = Math.min(ex, c.byGw[gid]); c.byGw[gid] -= t; ex -= t; }
        c.lost = Math.max(0, c.lost - ex);
      }
      if (c.pool > 0 && c.crashedAt == null) {
        c.admitCarry += num(c, 'connectRate') * DT;
        const want = Math.floor(c.admitCarry);
        if (want > 0) { c.admitCarry -= want; this.admit(c, Math.min(want, Math.floor(c.pool))); }
      } else c.admitCarry = 0;
    }
    for (const lb of this.order) if (lb.role === 'router') this.rebalance(lb);
    this.refresh();
  }

  // ───────────── data path ─────────────
  private transmit(e: EdgeRT, c: Cohort, at: number) {
    if (!this.edgeUp(e)) { e.dropped.push(c.n); this.drop(null, c, c.n, 'link-down'); return; }
    let n = c.n;
    const bw = e.cfg.bandwidth;
    if (bw > 0) {
      const room = Math.max(0, bw * DT - e.used);
      if (room < n) { const lost = n - room; e.dropped.push(lost); this.drop(null, { ...c, n: lost, msgs: c.msgs * (lost / c.n), trace: room <= 1e-9 ? c.trace : undefined }, lost, 'bandwidth'); n = room; }
    }
    if (n <= 1e-9) return;
    const loss = Math.min(1, e.cfg.lossProb + e.cfg.failureProb);
    if (loss > 0) { const lost = n * loss; e.dropped.push(lost); this.drop(null, { ...c, n: lost, msgs: c.msgs * loss, trace: undefined }, lost, 'link-loss'); n -= lost; }
    if (n <= 1e-9) return;
    e.used += n; e.sent.push(n);
    const f = n / c.n;
    const ok = f < 1 - 1e-12 ? { ...c, n, msgs: c.msgs * f } : c;
    const lat = e.cfg.latencyMs + (this.m.edgeExtra.get(e.id) ?? 0);
    ok.age += lat;
    e.inflight.push({ c: ok, at: at + lat / 1000 });
  }

  private spread(es: EdgeRT[], c: Cohort, at: number, w?: (e: EdgeRT) => number) {
    const ws = es.map((e) => (w ? w(e) : 1));
    const sum = ws.reduce((a, b) => a + b, 0);
    if (sum <= 0) { this.drop(null, c, c.n, 'no-route'); return; }
    let used = false;
    es.forEach((e, i) => {
      const f = ws[i] / sum; if (f <= 0) return;
      const part = es.length === 1 ? c : { ...c, n: c.n * f, msgs: c.msgs * f, trace: used ? undefined : c.trace };
      used = true; this.transmit(e, part, at);
    });
  }

  private route(rt: NodeRT, port: string, c: Cohort, at: number, w?: (t: NodeRT) => number): boolean {
    const es = this.outEdges(rt.id, port);
    if (!es.length) return false;
    this.spread(es, c, at, w ? (e) => { const t = this.nodes.get(e.dst); return t ? w(t) : 0; } : undefined);
    return true;
  }

  private deliverEdges(now: number) {
    for (const e of this.edges.values()) {
      if (!e.inflight.length) continue;
      const keep: EdgeRT['inflight'] = [];
      for (const it of e.inflight) {
        if (it.at <= now + 1e-9) { const t = this.nodes.get(e.dst); if (t) this.arrive(t, it.c, now); } else keep.push(it);
      }
      e.inflight = keep;
    }
  }

  private arrive(rt: NodeRT, c: Cohort, now: number) {
    if (rt.crashedAt != null) { this.drop(rt, c, c.n, 'node-down'); return; }
    if (rt.role === 'source' || rt.role === 'state') return;
    if (rt.role === 'gateway' && c.stage === 'broadcast') {
      const n = c.n * rt.fan * this.share(rt);
      if (n < 1e-9) return;
      this.enq(rt, rt.egr, 'egr', { ...c, stage: 'deliver', n, msgs: 0 }, now);
      return;
    }
    this.enq(rt, rt.ing, 'ing', c, now);
  }

  private enq(rt: NodeRT, p: Proc, kind: 'ing' | 'egr', c: Cohort, now: number) {
    if (c.n <= 1e-9) return;
    (kind === 'ing' ? rt.arrived : rt.arrivedE).push(c.n);
    const room = Math.max(0, this.qcap(rt, kind) - p.len);
    const acc = Math.min(c.n, room);
    if (acc < c.n - 1e-9) this.drop(rt, { ...c, n: c.n - acc, msgs: c.msgs * (1 - acc / c.n), trace: acc <= 1e-9 ? c.trace : undefined }, c.n - acc, 'queue-full');
    if (acc > 1e-9) {
      const part = acc < c.n - 1e-9 ? { ...c, n: acc, msgs: c.msgs * (acc / c.n) } : c;
      part.enq = now; p.q.push(part); p.len += acc;
      if (kind === 'ing' && rt.role === 'gateway' && part.stage === 'publish' && part.msgs > 0) this.g.accepted.push(acc);
    }
  }

  private emit(now: number) {
    const clients = this.order.filter((r) => r.role === 'source');
    const shareSum = clients.reduce((a, c) => a + num(c, 'share'), 0) || 1;
    for (const c of clients) {
      const count = (this.offered * this.m.spike * num(c, 'share')) / shareSum * DT;
      if (count <= 0) continue;
      this.g.offered.push(count);
      const conn = this.connected(c); const total = conn + c.pool + c.lost;
      const f = c.crashedAt != null || total <= 0 ? 0 : conn / total;
      const sent = count * f; const sup = count - sent;
      if (sup > 1e-9) this.drop(c, { stage: 'publish', n: sup, msgs: sup, born: now, age: 0, origin: c.id, enq: now, attempt: 0 }, sup, 'client-disconnected');
      if (sent <= 1e-9) continue;
      const co: Cohort = { stage: 'publish', n: sent, msgs: sent, born: now, age: 0, origin: c.id, enq: now, attempt: 0 };
      if (now - this.lastTraceT >= 0.5) { this.lastTraceT = now; co.trace = this.newTrace(co, now); }
      if (!this.route(c, 'publish', co, now)) this.drop(c, co, co.n, 'no-route');
    }
  }

  private room(rt: NodeRT, kind: 'ing' | 'egr') {
    const ports = kind === 'egr' ? ['deliver'] : rt.role === 'gateway' ? ['publish'] : ['out'];
    let r = Infinity;
    for (const p of ports) for (const e of this.outEdges(rt.id, p)) {
      const t = this.nodes.get(e.dst);
      if (!t || t.role === 'state') continue;
      r = Math.min(r, Math.max(0, this.qcap(t, 'ing') - t.ing.len));
    }
    return r;
  }

  private serveNode(rt: NodeRT, now: number) {
    if (rt.crashedAt != null || rt.role === 'source' || rt.role === 'state') return;
    this.serve(rt, rt.ing, 'ing', now);
    if (rt.role === 'gateway') this.serve(rt, rt.egr, 'egr', now);
  }

  private serve(rt: NodeRT, p: Proc, kind: 'ing' | 'egr', now: number) {
    const tmo = num(rt, 'timeoutMs') / 1000, retries = num(rt, 'retries');
    while (p.q.length && now - p.q[0].enq > tmo) {
      const h = p.q.shift()!;
      if (h.attempt < retries && h.stage !== 'heartbeat') { h.attempt++; h.enq = now; p.q.push(h); rt.reasons.retry = (rt.reasons.retry || 0) + h.n; }
      else { p.len -= h.n; this.drop(rt, h, h.n, 'timeout'); }
    }
    let budget = this.cap(rt, kind) * DT;
    if (bool(rt, 'backpressure')) budget = Math.min(budget, this.room(rt, kind));
    let used = 0; const parts: Cohort[] = [];
    while (budget > 1e-9 && p.q.length) {
      const h = p.q[0]; const take = Math.min(h.n, budget);
      budget -= take; used += take;
      let sv: Cohort;
      if (take >= h.n - 1e-9) { p.q.shift(); sv = h; }
      else { const f = take / h.n; sv = { ...h, n: take, msgs: h.msgs * f }; h.n -= take; h.msgs -= sv.msgs; h.trace = undefined; }
      p.len -= take; parts.push(sv);
    }
    if (p.len < 1e-9) p.len = 0;
    (kind === 'ing' ? rt.served : rt.servedE).push(used);
    for (const sv of parts) this.complete(rt, sv, kind, now);
  }

  private complete(rt: NodeRT, sv: Cohort, kind: 'ing' | 'egr', now: number) {
    if (sv.stage === 'heartbeat') return;
    const L = ((num(rt, 'processingMs') + (this.m.extraMs.get(rt.id) ?? 0)) / 1000) * (0.8 + 0.4 * this.rng());
    const wait = now - sv.enq;
    this.sample(rt.lat, now, (wait + L) * 1000, sv.n);
    rt.completed.push(sv.n);
    sv.age += (wait + L) * 1000;
    if (sv.trace) sv.trace.hops.push({ node: rt.id, t: now, wait });
    let c = sv;
    const fp = num(rt, 'failureProb');
    if (fp > 0) {
      const bad = sv.n * fp;
      this.drop(rt, { ...sv, n: bad, msgs: sv.msgs * fp, trace: undefined }, bad, 'error');
      c = { ...sv, n: sv.n - bad, msgs: sv.msgs * (1 - fp) };
    }
    if (c.n <= 1e-9) return;
    const at = now + L;
    switch (rt.role) {
      case 'router':
        if (!this.route(rt, 'out', c, at, (t) => (t.role === 'gateway' ? t.conns : 1))) this.drop(rt, c, c.n, 'no-route');
        break;
      case 'passthrough': this.route(rt, 'out', c, at); break;
      case 'gateway':
        if (kind === 'ing') this.gwIngress(rt, c, at, now);
        else if (!this.route(rt, 'deliver', c, at)) this.delivered(c, now);
        break;
      case 'broker':
        for (const e of this.outEdges(rt.id, 'broadcast')) {
          const t = this.nodes.get(e.dst);
          if (!t || t.id === c.origin || t.role !== 'gateway' || t.conns <= 0) continue; // origin already delivered locally
          this.transmit(e, { stage: 'broadcast', n: c.n, msgs: 0, born: c.born, age: c.age, origin: c.origin, dest: t.id, enq: at, attempt: 0, trace: this.branch(c.trace) }, at);
        }
        break;
      case 'sink': if (rt.type === 'subscriber-clients') this.delivered(c, now); break;
      default: break;
    }
  }

  private gwIngress(rt: NodeRT, c: Cohort, at: number, now: number) {
    if (c.stage !== 'publish') return;
    this.g.expected.push(c.n * this.expPerMsg);
    const localN = c.n * rt.fan * this.share(rt);
    const hasRedis = this.outEdges(rt.id, 'publish').length > 0;
    const copyTrace = hasRedis ? this.branch(c.trace) : undefined;
    if (localN > 1e-9) this.enq(rt, rt.egr, 'egr', { stage: 'deliver', n: localN, msgs: c.msgs, born: c.born, age: c.age, origin: rt.id, enq: at, attempt: 0, trace: c.trace }, now);
    else if (c.msgs > 0) this.finish(c, now);
    if (hasRedis) this.publishRedis(rt, { stage: 'publish', n: c.n, msgs: 0, born: c.born, age: c.age, origin: rt.id, enq: at, attempt: 0, trace: copyTrace }, at);
    if (bool(rt, 'persistMessages')) this.route(rt, 'persist', { stage: 'persist', n: c.n, msgs: 0, born: c.born, age: c.age, origin: rt.id, enq: at, attempt: 0 }, at);
  }

  private redisUp(rt: NodeRT) {
    return this.outEdges(rt.id, 'publish').filter((e) => { const t = this.nodes.get(e.dst); return t && t.crashedAt == null && this.edgeUp(e); });
  }

  private publishRedis(rt: NodeRT, c: Cohort, at: number) {
    const up = this.redisUp(rt);
    if (up.length) { this.spread(up, c, at); return; }
    if (str(rt, 'redisPolicy') === 'buffer') {
      const room = Math.max(0, num(rt, 'bufferCapacity') - rt.bufLen);
      const acc = Math.min(c.n, room);
      if (acc > 1e-9) { rt.buf.push({ ...c, n: acc }); rt.bufLen += acc; rt.reasons.buffered = (rt.reasons.buffered || 0) + acc; }
      if (acc < c.n - 1e-9) this.drop(rt, { ...c, n: c.n - acc, trace: acc <= 1e-9 ? c.trace : undefined }, c.n - acc, 'buffer-full');
    } else this.drop(rt, c, c.n, 'redis-unreachable');
  }

  private flushBuffers(now: number) {
    for (const rt of this.order) {
      if (rt.role !== 'gateway' || rt.bufLen <= 1e-9 || rt.crashedAt != null) continue;
      const up = this.redisUp(rt);
      if (!up.length) continue;
      let budget = up.reduce((a, e) => a + num(this.nodes.get(e.dst)!, 'capacity') * DT * 0.5, 0);
      while (budget > 1e-9 && rt.buf.length) {
        const h = rt.buf[0]; const take = Math.min(h.n, budget);
        budget -= take; rt.bufLen -= take;
        let part: Cohort;
        if (take >= h.n - 1e-9) part = rt.buf.shift()!; else { part = { ...h, n: take }; h.n -= take; h.trace = undefined; }
        this.spread(up, { ...part, enq: now }, now);
      }
      if (rt.bufLen < 1e-9) rt.bufLen = 0;
    }
  }

  private delivered(c: Cohort, now: number) {
    this.g.delivered.push(c.n);
    this.sample(this.e2e, now, c.age, c.n);
    if (c.msgs > 0) this.g.completed.push(c.msgs);
    this.endTrace(c);
  }
  private finish(c: Cohort, now: number) {
    this.g.completed.push(c.msgs);
    this.sample(this.e2e, now, c.age, c.msgs);
    this.endTrace(c);
  }

  // ───────────── main loop ─────────────
  step() {
    this.tick++;
    const now = (this.t = +(this.tick * DT).toFixed(6));
    for (const r of Object.values(this.g)) r.next();
    for (const rt of this.order) { rt.arrived.next(); rt.arrivedE.next(); rt.served.next(); rt.servedE.next(); rt.dropped.next(); rt.ovf.next(); rt.completed.next(); }
    for (const e of this.edges.values()) { e.sent.next(); e.dropped.next(); e.used = 0; }
    this.computeMods(now);
    this.manageConnections(now);
    this.deliverEdges(now);
    this.emit(now);
    for (const rt of this.order) this.serveNode(rt, now);
    this.flushBuffers(now);
    const cut = now - LAT_WIN;
    while (this.e2e.length && this.e2e[0].t < cut) this.e2e.shift();
    for (const rt of this.order) while (rt.lat.length && rt.lat[0].t < cut) rt.lat.shift();
    if (now - this.lastHist >= 0.5 - 1e-9) {
      this.lastHist = now;
      const [p50, p95, p99] = pct(this.e2e, [0.5, 0.95, 0.99]);
      const w = this.win(); const off = this.g.offered.sum() / w; const err = this.g.errors.sum() / w;
      this.hist.push({ t: now, offered: off, completed: this.g.completed.sum() / w, dropped: err, p50, p95, p99, errorPct: off > 0 ? Math.min(100, (err / off) * 100) : 0, queue: this.queueDepth() });
      if (this.hist.length > 240) this.hist.shift();
    }
  }

  private queueDepth() { let q = 0; for (const rt of this.order) q += rt.ing.len + rt.egr.len; return q; }

  // ───────────── observation ─────────────
  snapshot(): Snapshot {
    const w = this.win();
    const nodes: Record<string, NodeMetrics> = {};
    let bott: { id: string; score: number; text: string } | null = null;
    const partitioned = new Set<string>();
    for (const id of this.m.edgeDown) { const e = this.edges.get(id); if (e) { partitioned.add(e.src); partitioned.add(e.dst); } }
    for (const rt of this.order) {
      const capI = this.cap(rt, 'ing'), capE = this.cap(rt, 'egr');
      const uI = capI > 0 ? Math.min(1, rt.served.sum() / (capI * w)) : 0;
      const uE = rt.role === 'gateway' && capE > 0 ? Math.min(1, rt.servedE.sum() / (capE * w)) : 0;
      const util = Math.max(uI, uE);
      const qfI = this.qcap(rt, 'ing') > 0 ? rt.ing.len / this.qcap(rt, 'ing') : 0;
      const qfE = rt.role === 'gateway' && this.qcap(rt, 'egr') > 0 ? rt.egr.len / this.qcap(rt, 'egr') : 0;
      const [p50, p99] = pct(rt.lat, [0.5, 0.99]);
      const ovf = rt.ovf.sum() / w;
      const crashed = rt.crashedAt != null;
      const faulted = this.m.capM.has(rt.id) || this.m.extraMs.has(rt.id) || this.m.qM.has(rt.id) || partitioned.has(rt.id);
      let health: Health = 'healthy';
      if (crashed) health = 'down'; else if (faulted || util > 0.85 || Math.max(qfI, qfE) > 0.5 || ovf > 0) health = 'degraded';
      let entries = 0;
      if (rt.role === 'state') for (const e of this.edges.values()) if (e.dst === rt.id) entries += this.nodes.get(e.src)?.conns ?? 0;
      nodes[rt.id] = {
        health, util, utilIngress: uI, utilEgress: uE, p50, p99, waiting: rt.ing.len, waitingEgress: rt.egr.len,
        arrival: rt.arrived.sum() / w, throughput: rt.completed.sum() / w, dropRate: rt.dropped.sum() / w,
        capacity: capI, conns: rt.conns, pool: rt.pool, lost: rt.lost, buffered: rt.bufLen, reasons: { ...rt.reasons },
        crashed, entries, connected: this.connected(rt),
      };
      if (!crashed && ['gateway', 'router', 'broker', 'sink', 'passthrough'].includes(rt.role)) {
        const score = util + Math.max(qfI, qfE) + (ovf > 0 ? 1 : 0);
        if (score >= 0.9 && (!bott || score > bott.score + 1e-9)) {
          const egress = uE > uI;
          const arr = (egress ? rt.arrivedE : rt.arrived).sum() / w;
          const cap = egress ? capE : capI;
          const unit = egress ? 'deliveries/s' : rt.type === 'redis-pubsub' ? 'ops/s' : 'units/s';
          let text = `${rt.name}${egress ? ' (delivery path)' : ''} is currently the limiting component. Arrival rate ${arr.toFixed(0)} ${unit} vs configured capacity ${cap.toFixed(0)} ${unit}; utilization ${(util * 100).toFixed(0)}%, ${(egress ? rt.egr.len : rt.ing.len).toFixed(0)} waiting.`;
          if (rt.type === 'redis-pubsub') text += ' Redis Pub/Sub has no durable queue, so excess publishes are dropped rather than retried.';
          bott = { id: rt.id, score, text };
        }
      }
    }
    const edges: Record<string, EdgeMetrics> = {};
    for (const e of this.edges.values()) edges[e.id] = { rate: e.sent.sum() / w, dropRate: e.dropped.sum() / w, down: !this.edgeUp(e) };
    const off = this.g.offered.sum() / w, comp = this.g.completed.sum() / w, err = this.g.errors.sum() / w;
    const [p50, p95, p99] = pct(this.e2e, [0.5, 0.95, 0.99]);
    const exp = this.g.expected.sum() / w, del = this.g.delivered.sum() / w;
    const errorRate = off > 0 ? Math.min(1, err / off) : 0;
    const anyDown = this.order.some((r) => r.crashedAt != null);
    let connected = 0, pending = 0, lost = 0;
    for (const c of this.order) if (c.role === 'source') { connected += this.connected(c); pending += c.pool; lost += c.lost; }
    const health = errorRate > 0.2 || (off > 1 && comp < off * 0.5) ? 'critical' : errorRate > 0.02 || anyDown || bott ? 'degraded' : 'healthy';
    const traces: TraceView[] = this.traces.slice(-14).reverse().map((t) => {
      const path: string[] = [];
      for (const h of t.hops) if (h.node && path[path.length - 1] !== h.node) path.push(h.node);
      return { id: t.id, root: t.root, status: t.status, e2eMs: t.e2eMs, bornAt: t.bornAt, path, hops: t.hops.map((h) => ({ ...h })) };
    });
    return {
      t: this.t,
      global: {
        offered: off, accepted: this.g.accepted.sum() / w, completed: comp, delivered: del, expectedDeliveries: exp, dropped: err,
        persistFailures: this.g.persistErr.sum() / w, errorRate, deliveryRatio: exp > 0 ? Math.min(1, del / exp) : 1,
        p50, p95, p99, queueDepth: this.queueDepth(), connected, pending, lost, health, spike: this.m.spike,
      },
      nodes, edges, bottleneck: bott ? { nodeId: bott.id, text: bott.text } : null, traces,
      faults: this.faults.map((f) => ({ ...f })), history: this.hist.slice(-180),
    };
  }
}
