import { useLab } from '../store';
import { CATEGORIES, DEFS } from '../engine/definitions';

export function StatusBar() {
  const arch = useLab((s) => s.arch); const snap = useLab((s) => s.snap); const running = useLab((s) => s.running); const zoom = useLab((s) => s.zoom); const issues = useLab((s) => s.issues);
  const cats = CATEGORIES.map((c) => [c, arch.nodes.filter((n) => DEFS[n.type]?.category === c).length] as const).filter(([, n]) => n);
  return (
    <footer className="panel mono" style={{ display: 'flex', gap: 16, padding: '3px 12px', fontSize: 11, color: 'var(--mute)', borderWidth: '1px 0 0 0' }}>
      <span>{arch.nodes.length} components</span><span>{arch.edges.length} connections</span>
      <span>{cats.map(([c, n]) => `${c} ${n}`).join(' · ')}</span>
      <span style={{ flex: 1 }} />
      {issues.errors.length > 0 && <span style={{ color: 'var(--bad)' }}>{issues.errors.length} validation errors</span>}
      <span>sim t = {snap.t.toFixed(1)}s</span>
      <span style={{ color: running ? 'var(--good)' : 'var(--warn)' }}>{running ? '● running' : '❚❚ paused'}</span>
      <span>zoom {Math.round(zoom * 100)}%</span>
    </footer>
  );
}
