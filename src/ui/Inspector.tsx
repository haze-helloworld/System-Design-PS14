import { DEFS, type FieldDef } from '../engine/definitions';
import { useLab } from '../store';
import { icon } from '../icons';
import { ms, n0, pc, rate } from '../fmt';

function Field({ f, value, onChange }: { f: FieldDef; value: unknown; onChange: (v: number | boolean | string) => void }) {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '1fr 96px', gap: 8, alignItems: 'center', padding: '4px 0' }} title={f.help}>
      <span>{f.label}{f.unit ? <span style={{ color: 'var(--mute)' }}> ({f.unit})</span> : null}</span>
      {f.type === 'boolean' ? <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        : f.type === 'select' ? <select className="inp" value={String(value)} onChange={(e) => onChange(e.target.value)}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>
        : <input className="inp mono" type="number" min={f.min} max={f.max} step={f.step} value={Number(value)}
            onChange={(e) => { const v = +e.target.value; if (Number.isFinite(v)) onChange(Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v))); }} />}
    </label>
  );
}
const Stat = ({ k, v, warn }: { k: string; v: string; warn?: boolean }) => (
  <div style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 8px' }}><div className="lbl">{k}</div><div className="mono" style={{ color: warn ? 'var(--bad)' : undefined }}>{v}</div></div>
);

export function Inspector() {
  const s = useLab();
  const node = s.selected.length === 1 ? s.arch.nodes.find((n) => n.id === s.selected[0]) : undefined;
  const edge = !s.selected.length && s.selectedEdge ? s.arch.edges.find((e) => e.id === s.selectedEdge) : undefined;
  const wrap = (c: React.ReactNode) => <aside className="panel scroll" style={{ width: 300, borderWidth: '0 0 0 1px', padding: 12 }}>{c}</aside>;

  if (edge) {
    const m = s.snap.edges[edge.id]; const set = (p: Partial<typeof edge.config>) => s.setEdgeConfig(edge.id, p);
    const nm = (id: string) => s.arch.nodes.find((n) => n.id === id)?.name ?? id;
    const c = edge.config;
    const num = (label: string, key: 'latencyMs' | 'bandwidth' | 'lossProb' | 'failureProb', unit: string, step: number, max: number) => (
      <label style={{ display: 'grid', gridTemplateColumns: '1fr 96px', gap: 8, alignItems: 'center', padding: '4px 0' }}><span>{label} <span style={{ color: 'var(--mute)' }}>({unit})</span></span>
        <input className="inp mono" type="number" min={0} max={max} step={step} value={c[key]} onChange={(e) => { const v = +e.target.value; if (Number.isFinite(v)) set({ [key]: Math.min(max, Math.max(0, v)) }); }} /></label>);
    return wrap(<>
      <div className="lbl">Network link</div>
      <h3 style={{ margin: '4px 0 2px', fontSize: 14 }}>{nm(edge.sourceNodeId)} → {nm(edge.targetNodeId)}</h3>
      <div style={{ color: 'var(--mute)', marginBottom: 8 }}>{edge.sourcePort} → {edge.targetPort}</div>
      {m && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}><Stat k="Throughput" v={rate(m.rate)} /><Stat k="Dropped" v={rate(m.dropRate)} warn={m.dropRate > 0.05} /></div>}
      {num('Latency', 'latencyMs', 'ms', 1, 10000)}
      {num('Bandwidth (0 = unlimited)', 'bandwidth', 'units/s', 10, 1e7)}
      {num('Message loss', 'lossProb', '0–1', 0.01, 1)}
      {num('Failure probability', 'failureProb', '0–1', 0.01, 1)}
      <label style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>Available <input type="checkbox" checked={c.available} onChange={(e) => set({ available: e.target.checked })} /></label>
      <button className="btn" style={{ marginTop: 10 }} onClick={s.removeSelection}>Delete connection</button>
    </>);
  }
  if (s.selected.length > 1) return wrap(<><h3 style={{ marginTop: 0 }}>{s.selected.length} components selected</h3><p style={{ color: 'var(--mute)' }}>Drag to move together. Press Delete to remove them.</p><button className="btn" onClick={s.removeSelection}>Delete selection</button></>);
  if (!node) return wrap(<>
    <h3 style={{ marginTop: 0 }}>Inspector</h3>
    <p style={{ color: 'var(--mute)' }}>Select a component or connection to edit it. Changes apply to subsequent traffic immediately.</p>
    <p style={{ color: 'var(--mute)' }}>Drag from an output handle (right/bottom) to a compatible input handle to connect. Handle colours highlight when a connection is valid.</p>
    <div className="lbl" style={{ marginTop: 14 }}>Validation</div>
    {s.issues.errors.map((e) => <div key={e} style={{ color: 'var(--bad)' }}>✕ {e}</div>)}
    {s.issues.warnings.map((e) => <div key={e} style={{ color: 'var(--warn)' }}>! {e}</div>)}
    {!s.issues.errors.length && !s.issues.warnings.length && <div style={{ color: 'var(--good)' }}>Architecture is valid.</div>}
  </>);

  const def = DEFS[node.type]; const m = s.snap.nodes[node.id]; const Icon = icon(def.icon);
  const gw = def.role === 'gateway';
  return wrap(<>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Icon size={18} color="var(--accent)" /><div className="lbl">{def.label}</div><div style={{ flex: 1 }} /><span className="chip">{m?.health ?? 'healthy'}</span></div>
    <input className="inp" style={{ width: '100%', margin: '8px 0', fontWeight: 600 }} aria-label="Component name" value={node.name} onChange={(e) => s.rename(node.id, e.target.value)} />
    <p style={{ color: 'var(--mute)', margin: '0 0 10px' }}>{def.description}</p>
    {def.note && <p style={{ color: 'var(--warn)', margin: '0 0 10px', fontSize: 12 }}>{def.note}</p>}
    {m && <>
      <div className="lbl" style={{ marginBottom: 4 }}>Live metrics (simulated)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
        {def.role === 'source' && <><Stat k="Connected" v={n0(m.connected)} /><Stat k="Connecting" v={n0(m.pool)} /><Stat k="Lost" v={n0(m.lost)} warn={m.lost > 0} /><Stat k="Refused" v={n0(m.reasons['connect-refused'] ?? 0)} /></>}
        {def.role !== 'source' && def.role !== 'state' && <>
          <Stat k={gw ? 'Ingest util' : 'Utilization'} v={pc(gw ? m.utilIngress : m.util)} warn={m.util > 0.9} />
          {gw && <Stat k="Delivery util" v={pc(m.utilEgress)} warn={m.utilEgress > 0.9} />}
          <Stat k="Arrivals" v={rate(m.arrival)} /><Stat k="Throughput" v={rate(m.throughput)} />
          <Stat k="P50 / P99" v={`${ms(m.p50)} / ${ms(m.p99)}`} /><Stat k="Waiting" v={n0(m.waiting + m.waitingEgress)} />
          <Stat k="Dropped" v={rate(m.dropRate)} warn={m.dropRate > 0.05} /><Stat k="Effective capacity" v={rate(m.capacity)} />
        </>}
        {gw && <><Stat k="Connections" v={n0(m.conns)} /><Stat k="Buffered" v={n0(m.buffered)} /></>}
        {def.role === 'state' && <Stat k="Entries" v={n0(m.entries)} />}
      </div>
      {Object.keys(m.reasons).length > 0 && <div style={{ marginBottom: 12, fontSize: 11.5, color: 'var(--mute)' }}>Cumulative: {Object.entries(m.reasons).map(([k, v]) => `${k} ${n0(v)}`).join(' · ')}</div>}
    </>}
    <div className="lbl" style={{ marginBottom: 2 }}>Configuration</div>
    {def.fields.map((f) => <Field key={f.key} f={f} value={node.config[f.key] ?? def.defaults[f.key]} onChange={(v) => s.setConfig(node.id, f.key, v)} />)}
    <div className="lbl" style={{ margin: '12px 0 4px' }}>Execution mode</div>
    <select className="inp" disabled title="Live mode arrives in Phase 2" value={node.executionMode}><option value="simulation">simulation</option><option value="live" disabled>live (Phase 2)</option></select>
    <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
      {node.type !== 'client' && <button className="btn" onClick={() => m?.crashed ? s.clearFaults() : s.inject('crash', node.id, 0)} title="Inject a crash fault on this component">{m?.crashed ? 'Restore (clear faults)' : 'Crash'}</button>}
      <button className="btn" onClick={s.removeSelection}>Delete</button>
    </div>
  </>);
}
