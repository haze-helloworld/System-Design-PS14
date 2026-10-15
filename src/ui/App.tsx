import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useLab } from '../store';
import { Toolbar } from './Toolbar';
import { Sidebar } from './Sidebar';
import { Canvas } from './Canvas';
import { Inspector } from './Inspector';
import { BottomPanel } from './BottomPanel';
import { StatusBar } from './StatusBar';

function Keys() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
      const s = useLab.getState(); const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') s.removeSelection();
      else if (e.key === ' ') { e.preventDefault(); s.setRunning(!s.running); }
      else if (e.key === '.') s.stepOnce();
      else if (e.key.toLowerCase() === 'f' && !mod) s.set({ fitSignal: s.fitSignal + 1 });
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return null;
}

export function App() {
  const toast = useLab((s) => s.toast);
  return (
    <ReactFlowProvider>
      <Keys />
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Toolbar />
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}><Sidebar /><Canvas /><Inspector /></div>
        <BottomPanel />
        <StatusBar />
      </div>
      {toast && <div role="status" style={{ position: 'fixed', bottom: 60, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? '#3b1212' : '#10222f', border: `1px solid ${toast.kind === 'error' ? 'var(--bad)' : 'var(--accent)'}`, padding: '8px 14px', borderRadius: 8, zIndex: 100, maxWidth: 520, whiteSpace: 'pre-line' }}>{toast.text}</div>}
    </ReactFlowProvider>
  );
}
