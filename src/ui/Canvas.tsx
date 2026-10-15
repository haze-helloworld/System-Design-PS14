import { useEffect, useMemo, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, useReactFlow, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import { useLab } from '../store';
import { validateConnection } from '../engine/validate';
import { LabNode } from './LabNode';
import { LabEdge } from './LabEdge';

const nodeTypes = { lab: LabNode };
const edgeTypes = { lab: LabEdge };

export function Canvas() {
  const arch = useLab((s) => s.arch);
  const selected = useLab((s) => s.selected);
  const selEdge = useLab((s) => s.selectedEdge);
  const fit = useLab((s) => s.fitSignal);
  const showMini = useLab((s) => s.showMiniMap);
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);

  // React Flow keeps measured sizes on its nodes; keep them while the architecture stays the source of truth.
  useEffect(() => {
    setNodes((prev) => {
      const pm = new Map(prev.map((n) => [n.id, n]));
      return arch.nodes.map((n) => ({ ...(pm.get(n.id) ?? {}), id: n.id, type: 'lab', position: n.position, data: {}, selected: selected.includes(n.id) }) as Node);
    });
  }, [arch.nodes, selected]);

  useEffect(() => { const t = setTimeout(() => rf.fitView({ padding: 0.12, duration: 300 }), 60); return () => clearTimeout(t); }, [fit, rf]);

  const edges = useMemo<Edge[]>(() => arch.edges.map((e) => ({
    id: e.id, source: e.sourceNodeId, sourceHandle: e.sourcePort, target: e.targetNodeId, targetHandle: e.targetPort,
    type: 'lab', selected: e.id === selEdge, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#4b5b73' },
  })), [arch.edges, selEdge]);

  const onNodesChange = (ch: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(ch, ns));
    const st = useLab.getState();
    for (const c of ch) if (c.type === 'position' && c.position) st.setPosition(c.id, Math.round(c.position.x), Math.round(c.position.y));
    const sc = ch.filter((c) => c.type === 'select');
    if (sc.length) {
      const cur = new Set(st.selected);
      for (const c of sc) if (c.type === 'select') { if (c.selected) cur.add(c.id); else cur.delete(c.id); }
      st.setSelection([...cur], cur.size ? null : st.selectedEdge);
    }
  };
  const onEdgesChange = (ch: EdgeChange[]) => {
    for (const c of ch) if (c.type === 'select') {
      const st = useLab.getState();
      if (c.selected) st.setSelection([], c.id); else if (st.selectedEdge === c.id) st.setSelection(st.selected, null);
    }
  };

  return (
    <div style={{ flex: 1, position: 'relative', minHeight: 0 }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(e) => {
        const type = e.dataTransfer.getData('application/x-lab-type'); if (!type) return;
        e.preventDefault(); useLab.getState().addNode(type, rf.screenToFlowPosition({ x: e.clientX - 100, y: e.clientY - 30 }));
      }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode="dark"
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={(c) => useLab.getState().connect(c.source, c.sourceHandle, c.target, c.targetHandle)}
        isValidConnection={(c) => !validateConnection(arch, c.source!, c.sourceHandle, c.target!, c.targetHandle)}
        onNodeDragStart={() => useLab.getState().pushHistory()}
        onPaneClick={() => useLab.getState().setSelection([], null)}
        onMove={(_, vp) => useLab.setState({ zoom: vp.zoom })}
        deleteKeyCode={null} minZoom={0.15} maxZoom={2.5} fitView proOptions={{ hideAttribution: true }}
        selectionKeyCode="Shift" multiSelectionKeyCode={['Shift', 'Meta', 'Control']}>
        <Background variant={BackgroundVariant.Lines} gap={28} color="#161d2a" />
        <Controls showInteractive={false} />
        {showMini && <MiniMap pannable zoomable nodeColor="#2b3a52" maskColor="#0a0d1399" />}
      </ReactFlow>
    </div>
  );
}
