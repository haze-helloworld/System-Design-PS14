import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { DEFS, type PortDef } from '../engine/definitions';
import { useLab } from '../store';
import { icon } from '../icons';
import { ms, n0, pc } from '../fmt';

const POS = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };
const HCOL = { healthy: 'var(--good)', degraded: 'var(--warn)', down: 'var(--bad)' };

export const LabNode = memo(function LabNode({ id }: NodeProps) {
  const node = useLab((s) => s.arch.nodes.find((n) => n.id === id));
  const m = useLab((s) => s.snap.nodes[id]);
  const sel = useLab((s) => s.selected.includes(id));
  const bott = useLab((s) => s.snap.bottleneck?.nodeId === id);
  const hl = useLab((s) => s.hlNodes.includes(id));
  if (!node) return null;
  const def = DEFS[node.type]; const Icon = icon(def.icon);
  const sides: Record<string, PortDef[]> = { left: [], right: [], top: [], bottom: [] };
  def.ports.forEach((p) => sides[p.side].push(p));
  const health = m?.health ?? 'healthy';
  let line = '';
  if (m) {
    if (m.crashed) line = 'DOWN';
    else if (def.role === 'source') line = `${n0(m.connected)}/${n0(m.connected + m.pool + m.lost)} CONNECTED | ${n0(m.pool)} CONNECTING`;
    else if (def.role === 'state') line = `${n0(m.entries)} ENTRIES`;
    else line = `${pc(m.util)} BUSY | ${ms(m.p99)} P99 | ${n0(m.waiting + m.waitingEgress)} WAITING`;
  }
  const extra = !m ? '' : def.role === 'gateway' ? `${n0(m.conns)} conns${m.buffered > 0 ? ` | ${n0(m.buffered)} buffered` : ''}` : def.role === 'sink' && node.type === 'subscriber-clients' ? `${n0(m.throughput)} deliveries/s` : '';
  const u = m ? Math.min(1, m.util) : 0;
  return (
    <div className={`node-card ${sel ? 'sel' : ''} ${bott ? 'bott' : ''} ${hl ? 'hl' : ''} ${m?.crashed ? 'down' : ''}`}>
      {(['left', 'right', 'top', 'bottom'] as const).flatMap((side) => sides[side].map((p, i) => {
        const o = `${((i + 1) / (sides[side].length + 1)) * 100}%`;
        const horiz = side === 'left' || side === 'right';
        return [
          <Handle key={p.id} id={p.id} type={p.dir === 'in' ? 'target' : 'source'} position={POS[side]} title={`${p.label} (${p.kind})`} style={horiz ? { top: o } : { left: o }} />,
          horiz ? <span key={p.id + 'l'} className="port-label" style={{ top: `calc(${o} - 6px)`, [side]: 10 }}>{p.label}</span> : null,
        ];
      }))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px 7px' }}>
        <Icon size={16} color="var(--accent)" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</div>
          <div className="lbl" style={{ fontSize: 9.5 }}>{def.label}{extra ? ` · ${extra}` : ''}</div>
        </div>
        <span className="dot" title={health} style={{ background: HCOL[health] }} />
      </div>
      {def.role !== 'source' && def.role !== 'state' && <div className="bar"><i style={{ width: `${u * 100}%`, background: u > 0.9 ? 'var(--bad)' : u > 0.7 ? 'var(--warn)' : 'var(--good)' }} /></div>}
      <div className="node-metrics mono">{line}</div>
    </div>
  );
});
