import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useLab } from '../store';
import { rate } from '../fmt';

export function LabEdge(p: EdgeProps) {
  const [path, lx, ly] = getBezierPath(p);
  const m = useLab((s) => s.snap.edges[p.id]);
  const running = useLab((s) => s.running);
  const hl = useLab((s) => s.hlEdges.includes(p.id));
  const state = p.sourceHandleId === 'session';
  const down = m?.down;
  const flowing = running && !down && m && m.rate > 0.05;
  const color = down ? 'var(--bad)' : hl ? 'var(--warn)' : p.selected ? 'var(--accent)' : state ? '#334155' : '#4b5b73';
  const n = flowing ? Math.min(6, Math.max(1, Math.ceil(Math.log10(m!.rate + 1) * 1.6))) : 0;
  const dropping = m && m.dropRate > 0.05;
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={{ stroke: color, strokeWidth: hl || p.selected ? 2.4 : 1.5, strokeDasharray: down ? '6 4' : state ? '2 5' : undefined, opacity: state ? 0.6 : 1 }} />
      {Array.from({ length: n }, (_, i) => (
        <circle key={i} r={3} fill={dropping ? 'var(--warn)' : 'var(--accent)'}>
          <animateMotion dur="1.8s" begin={`${-(i * 1.8) / n}s`} repeatCount="indefinite" path={path} />
        </circle>
      ))}
      {(down || (m && (m.rate > 0.5 || m.dropRate > 0.5) && !state)) && (
        <EdgeLabelRenderer>
          <div className="mono" style={{ position: 'absolute', transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)`, fontSize: 9.5, pointerEvents: 'none', background: '#0a0d13cc', padding: '0 4px', borderRadius: 4, color: down ? 'var(--bad)' : 'var(--mute)' }}>
            {down ? 'LINK DOWN' : rate(m!.rate)}{dropping ? <span style={{ color: 'var(--warn)' }}> −{rate(m!.dropRate)}</span> : null}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
