import { useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle } from 'lucide-react';
import { useLab, type BottomTab } from '../store';
import { PRESETS } from '../engine/presets';
import { DEFS } from '../engine/definitions';
import type { FaultKind } from '../engine/types';
import { ms, n0, pc, rate } from '../fmt';

function Chart({ title, keys, unit }: { title: string; keys: [string, string, string][]; unit?: string }) {
  const data = useLab((s) => s.snap.history);
  return (
    <div style={{ flex: 1, minWidth: 220, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="lbl">{title}</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="#1b2331" /><XAxis dataKey="t" tick={{ fontSize: 10, fill: '#7a8799' }} tickFormatter={(v) => v + 's'} /><YAxis tick={{ fontSize: 10, fill: '#7a8799' }} unit={unit} />
            <Tooltip contentStyle={{ background: '#10141c', border: '1px solid #222b3a', fontSize: 11 }} formatter={(v) => (typeof v === 'number' ? v.toFixed(1) : v)} labelFormatter={(v) => `t=${v}s`} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {keys.map(([k, name, c]) => <Line key={k} dataKey={k} name={name} stroke={c} dot={false} strokeWidth={1.8} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const FAULTS: { kind: FaultKind; label: string; types: string[] | 'any' | 'none'; amount?: number; explain: string }[] = [
  { kind: 'crash', label: 'Gateway crash', types: ['ws-gateway'], explain: 'Gateway stops; its connections drop; the NLB keeps sending new connections to it until health-check detection; clients then reconnect to survivors.' },
  { kind: 'crash', label: 'Redis outage', types: ['redis-pubsub'], explain: 'Cross-gateway propagation stops. Local delivery continues. Missed events are NOT replayed on recovery (unless a gateway buffers them).' },
  { kind: 'crash', label: 'Database outage', types: ['database'], explain: 'Persistence writes fail (or back up in the worker). Live delivery is unaffected.' },
  { kind: 'partition', label: 'Network partition', types: ['ws-gateway', 'redis-pubsub'], explain: 'Cuts the selected gateway from Redis (or Redis from everyone). Other links keep working.' },
  { kind: 'latency', label: 'Increased network latency (+250 ms)', types: 'any', amount: 250, explain: 'Adds latency to every link touching the component.' },
  { kind: 'capacity', label: 'Reduced capacity (25%)', types: 'any', amount: 0.25, explain: 'Component serves at 25% of configured capacity.' },
  { kind: 'spike', label: 'Traffic spike (×5)', types: 'none', amount: 5, explain: 'Multiplies offered load for the duration.' },
  { kind: 'slow-consumer', label: 'Slow consumer', types: ['subscriber-clients'], explain: 'Subscribers receive at 10% rate with extra latency, backing up delivery queues.' },
  { kind: 'queue-overflow', label: 'Queue overflow (5% queue)', types: 'any', amount: 0.05, explain: 'Shrinks the component queue to 5% so bursts are rejected.' },
  { kind: 'reconnect-storm', label: 'Repeated client reconnects', types: ['ws-gateway'], amount: 0.5, explain: 'Drops 50% of the gateway’s connections at once; they reconnect at the connect rate.' },
];

function Failures() {
  const s = useLab(); const [i, setI] = useState(0); const [target, setTarget] = useState(''); const [dur, setDur] = useState(15);
  const f = FAULTS[i];
  const cands = s.arch.nodes.filter((n) => f.types === 'any' ? ['gateway', 'router', 'broker', 'sink', 'passthrough'].includes(DEFS[n.type].role) : f.types !== 'none' && f.types.includes(n.type));
  const tgt = cands.find((n) => n.id === target)?.id ?? cands[0]?.id ?? '';
  const name = (id: string) => s.arch.nodes.find((n) => n.id === id)?.name ?? (id || 'global');
  return (
    <div style={{ display: 'flex', gap: 20, height: '100%' }}>
      <div style={{ width: 340, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <select className="inp" aria-label="Failure type" value={i} onChange={(e) => setI(+e.target.value)}>{FAULTS.map((x, k) => <option key={k} value={k}>{x.label}</option>)}</select>
        {f.types !== 'none' && <select className="inp" aria-label="Target" value={tgt} onChange={(e) => setTarget(e.target.value)}>{cands.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>Duration (s, 0 = until cleared) <input className="inp mono" type="number" min={0} style={{ width: 70 }} value={dur} onChange={(e) => setDur(+e.target.value)} /></label>
        <button className="btn primary" disabled={f.types !== 'none' && !tgt} onClick={() => s.inject(f.kind, f.types === 'none' ? '' : tgt, dur, f.amount)}>Inject failure now</button>
        <div style={{ color: 'var(--mute)', fontSize: 12 }}>{f.explain} <i>(Simulated behaviour.)</i></div>
      </div>
      <div className="scroll" style={{ flex: 1 }}>
        <div className="lbl">Active / scheduled faults</div>
        {!s.snap.faults.length && <div style={{ color: 'var(--mute)', padding: '6px 0' }}>None. The system is running without injected failures.</div>}
        {s.snap.faults.map((x) => {
          const active = x.startAt <= s.snap.t && (x.until == null || s.snap.t < x.until);
          return <div key={x.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
            <span className="dot" style={{ background: active ? 'var(--bad)' : 'var(--warn)' }} /><span style={{ flex: 1 }}>{x.kind} → {name(x.target)}{x.amount ? ` (${x.amount})` : ''}</span>
            <span className="mono" style={{ color: 'var(--mute)' }}>{active ? 'active' : `starts ${x.startAt}s`}{x.until != null ? ` · ends ${x.until.toFixed(0)}s` : ''}</span>
            <button className="btn" onClick={() => s.clearFault(x.id)}>Clear</button></div>;
        })}
        {s.snap.faults.length > 0 && <button className="btn" style={{ marginTop: 8 }} onClick={s.clearFaults}>Clear all (recover)</button>}
      </div>
    </div>
  );
}

function Traces() {
  const s = useLab(); const name = (id: string) => s.arch.nodes.find((n) => n.id === id)?.name.replace('WebSocket ', '') ?? id;
  return (
    <div className="scroll" style={{ height: '100%' }}>
      <div style={{ color: 'var(--mute)', fontSize: 12, marginBottom: 4 }}>Sampled messages (one every 0.5 s of simulated time). A publish forks into branches (↳): local delivery, each remote gateway via Redis. Click one to highlight its path on the canvas.</div>
      {!s.snap.traces.length && <div style={{ color: 'var(--mute)' }}>No traces yet — press Run.</div>}
      {s.snap.traces.map((t) => (
        <div key={t.id} onClick={() => s.highlightTrace(t.id)} style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 5, display: 'flex', gap: 10, background: s.hlTrace === t.id ? '#2a2410' : undefined, borderBottom: '1px solid var(--line)' }}>
          <span className="mono" style={{ width: 64 }}>#{t.root}{t.id !== t.root ? ` ↳${t.id}` : ''}</span>
          <span style={{ width: 70, color: t.status === 'delivered' ? 'var(--good)' : t.status === 'dropped' ? 'var(--bad)' : 'var(--warn)' }}>{t.status}</span>
          <span className="mono" style={{ width: 70 }}>{t.e2eMs != null ? ms(t.e2eMs) : '—'}</span>
          <span style={{ flex: 1 }}>{t.path.map(name).join(' → ')}{t.status === 'dropped' ? ` ✕ ${t.hops[t.hops.length - 1]?.note ?? ''}` : ''}</span>
        </div>))}
    </div>
  );
}

const MODEL = [
  'Discrete-time fluid model: fixed 100 ms steps; work moves as batches with fractional message counts (expected values), not individual packets.',
  'Each processing component is a FIFO queue served at a fixed rate (its capacity). Waiting time is the real FIFO delay; a full queue rejects work; waiting past the timeout retries or drops it.',
  'Latency = edge latency + queue wait + processing time (±20% seeded jitter). Percentiles are weighted over a rolling 10 s window. Utilization = served ÷ capacity over the last 2 s.',
  'Message flow: client → NLB (weighted by connections) → gateway ingest → local delivery AND Redis publish → Redis broadcasts to every OTHER gateway → their local subscribers. The origin is excluded from the broadcast, so nothing is delivered twice.',
  'Redis Pub/Sub is transient: no durable queue, no replay. Messages missed during an outage are lost unless the gateway buffer policy is enabled (a gateway feature, modelled as such).',
  'Connections are counts assigned to gateways until disconnect/crash. A crashed gateway is detected by the NLB only after the health-check delay.',
  'All numbers are illustrative defaults, not calibrated to real AWS/Redis behaviour. Do not read them as production predictions.',
];

export function BottomPanel() {
  const s = useLab(); const g = s.snap.global; const b = s.snap.bottleneck;
  const tabs: [BottomTab, string][] = [['metrics', 'Metrics'], ['failures', 'Failure lab'], ['experiments', 'Experiments'], ['traces', 'Message traces'], ['model', 'Model notes']];
  if (!s.showBottom) return null;
  return (
    <section className="panel" style={{ height: 250, borderWidth: '1px 0 0 0', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
        {tabs.map(([k, l]) => <div key={k} className={`tab ${s.bottomTab === k ? 'on' : ''}`} onClick={() => s.set({ bottomTab: k })}>{l}</div>)}
        <div style={{ flex: 1 }} />
        {b && <div style={{ color: 'var(--bad)', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', padding: '0 12px', maxWidth: '65%' }}><AlertTriangle size={14} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.text}>{b.text}</span></div>}
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 10 }} className="scroll">
        {s.bottomTab === 'metrics' && (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {([['Offered', rate(g.offered)], ['Accepted', rate(g.accepted)], ['Completed', rate(g.completed)], ['Deliveries', rate(g.delivered)], ['Delivery ratio', pc(g.deliveryRatio)], ['P50', ms(g.p50)], ['P95', ms(g.p95)], ['P99', ms(g.p99)], ['Error rate', pc(g.errorRate)], ['Dropped', rate(g.dropped)], ['Persist fails', rate(g.persistFailures)], ['Queue depth', n0(g.queueDepth)], ['Connected', `${n0(g.connected)} (+${n0(g.pending)} pending)`]] as const).map(([k, v]) => <span key={k} className="chip"><span style={{ color: 'var(--mute)' }}>{k}</span><b className="mono">{v}</b></span>)}
            </div>
            <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
              <Chart title="Throughput (msg/s)" keys={[['offered', 'offered', '#7a8799'], ['completed', 'completed', '#34d399'], ['dropped', 'dropped', '#f87171']]} />
              <Chart title="End-to-end latency (ms)" keys={[['p50', 'P50', '#38bdf8'], ['p95', 'P95', '#fbbf24'], ['p99', 'P99', '#f87171']]} />
              <Chart title="Queue depth & error %" keys={[['queue', 'queued', '#a78bfa'], ['errorPct', 'error %', '#f87171']]} />
            </div>
          </div>)}
        {s.bottomTab === 'failures' && <Failures />}
        {s.bottomTab === 'traces' && <Traces />}
        {s.bottomTab === 'model' && <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--mute)' }}>{MODEL.map((m) => <li key={m} style={{ marginBottom: 4 }}>{m}</li>)}</ul>}
        {s.bottomTab === 'experiments' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 8 }}>
            {PRESETS.map((p) => <div key={p.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, background: 'var(--panel2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <b>{p.name}</b><span style={{ color: 'var(--mute)', fontSize: 12, flex: 1 }}>{p.description}</span>
              <button className="btn primary" onClick={() => s.runPreset(p.id)}>Load &amp; run</button></div>)}
          </div>)}
      </div>
    </section>
  );
}
