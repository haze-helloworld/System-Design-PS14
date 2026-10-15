import { useReactFlow } from '@xyflow/react';
import { CATEGORIES, DEFS, PLANNED } from '../engine/definitions';
import { icon } from '../icons';
import { useLab } from '../store';

export function Sidebar() {
  const search = useLab((s) => s.search).toLowerCase();
  const rf = useReactFlow();
  const match = (t: string, d: string) => !search || (t + d).toLowerCase().includes(search);
  return (
    <aside className="panel" style={{ width: 232, borderWidth: '0 1px 0 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: 8 }}><input className="inp" style={{ width: '100%' }} placeholder="Search components…" aria-label="Search components" value={useLab.getState().search} onChange={(e) => useLab.setState({ search: e.target.value })} /></div>
      <div className="scroll" style={{ flex: 1, padding: '0 8px 12px' }}>
        {CATEGORIES.map((cat) => {
          const impl = Object.values(DEFS).filter((d) => d.category === cat && match(d.label, d.description));
          const plan = PLANNED.filter((d) => d.category === cat && match(d.label, d.description));
          if (!impl.length && !plan.length) return null;
          return (
            <div key={cat} style={{ marginTop: 8 }}>
              <div className="lbl" style={{ padding: '4px 2px' }}>{cat}</div>
              {impl.map((d) => { const I = icon(d.icon); return (
                <div key={d.type} draggable title={`${d.description}\nDrag onto the canvas, or double-click to add.`}
                  onDragStart={(e) => { e.dataTransfer.setData('application/x-lab-type', d.type); e.dataTransfer.effectAllowed = 'copy'; }}
                  onDoubleClick={() => useLab.getState().addNode(d.type, rf.screenToFlowPosition({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 60 }))}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel2)', margin: '4px 0', cursor: 'grab' }}>
                  <I size={15} color="var(--accent)" /><span>{d.label}</span>
                </div>); })}
              {plan.map((d) => { const I = icon(d.icon); return (
                <div key={d.type} title={`Planned — ${d.description}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', border: '1px dashed var(--line)', borderRadius: 7, margin: '4px 0', opacity: 0.45 }}>
                  <I size={15} /><span style={{ flex: 1 }}>{d.label}</span><span className="lbl" style={{ fontSize: 9 }}>planned</span>
                </div>); })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
