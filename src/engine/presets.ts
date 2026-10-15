import type { Architecture, ArchEdge, ArchNode, FaultKind } from './types';
import { DEFAULT_EDGE, DEFS } from './definitions';
import { edgeId } from './validate';

function node(id: string, type: string, name: string, x: number, y: number, config: Record<string, number | boolean | string> = {}): ArchNode {
  return { id, type, name, position: { x, y }, config: { ...DEFS[type].defaults, ...config }, health: 'healthy', executionMode: 'simulation' };
}
function edge(s: string, sp: string, t: string, tp: string, latencyMs = 2): ArchEdge {
  return { id: edgeId(s, sp, t, tp), sourceNodeId: s, sourcePort: sp, targetNodeId: t, targetPort: tp, config: { ...DEFAULT_EDGE, latencyMs } };
}

/** Topic 14 default: Clients → NLB → 3 gateways ⇄ Redis Pub/Sub → subscribers, plus async persistence. */
export function defaultArchitecture(): Architecture {
  const gws = ['gw1', 'gw2', 'gw3'];
  const edges: ArchEdge[] = [edge('client', 'publish', 'nlb', 'in', 25)];
  for (const g of gws) {
    edges.push(edge('nlb', 'out', g, 'conn', 2), edge(g, 'publish', 'redis', 'publish', 1), edge('redis', 'broadcast', g, 'broadcast', 1),
      edge(g, 'deliver', 'subs', 'deliver', 15), edge(g, 'persist', 'worker', 'in', 1), edge(g, 'session', 'presence', 'state', 1), edge(g, 'session', 'registry', 'state', 1));
  }
  edges.push(edge('worker', 'out', 'db', 'write', 2));
  return {
    version: 1, name: 'Mini Discord — Pub/Sub WebSocket Gateway', settings: { offeredLoad: 100, seed: 42 },
    nodes: [
      node('client', 'client', 'Client Generator', -20, 260),
      node('nlb', 'load-balancer', 'Network Load Balancer', 250, 260),
      node('gw1', 'ws-gateway', 'WebSocket Gateway 1', 540, 20),
      node('gw2', 'ws-gateway', 'WebSocket Gateway 2', 540, 260),
      node('gw3', 'ws-gateway', 'WebSocket Gateway 3', 540, 500),
      node('redis', 'redis-pubsub', 'Redis Pub/Sub Backplane', 940, 200),
      node('subs', 'subscriber-clients', 'Subscriber Clients (#general)', 1240, 200),
      node('worker', 'worker', 'Background Worker', 940, 480),
      node('db', 'database', 'Persistent Message DB', 1240, 480),
      node('presence', 'session-store', 'Presence / Session Store', 940, 700),
      node('registry', 'subscription-registry', 'Channel Subscription Registry', 1240, 700),
    ],
    edges,
  };
}

export interface PresetFault { kind: FaultKind; target: string; at: number; duration?: number; amount?: number }
export interface Preset { id: string; name: string; description: string; build: () => Architecture; faults: PresetFault[] }

const withLoad = (load: number, mut?: (a: Architecture) => void) => () => {
  const a = defaultArchitecture(); a.settings.offeredLoad = load; mut?.(a); return a;
};
const setCfg = (a: Architecture, id: string, k: string, v: number | boolean | string) => { a.nodes.find((n) => n.id === id)!.config[k] = v; };

export const PRESETS: Preset[] = [
  { id: 'baseline', name: 'Healthy baseline', description: '100 msg/s across 3 gateways. All components well below capacity.', build: withLoad(100), faults: [] },
  { id: 'gw-overload', name: 'Gateway overload', description: '600 msg/s: each gateway is offered 200 msg/s against 150 capacity. Queues fill, latency climbs, messages drop.', build: withLoad(600), faults: [] },
  { id: 'redis-bottleneck', name: 'Redis bottleneck', description: 'Redis capacity cut to 60 ops/s at 120 msg/s. Redis saturates while gateways idle; cross-node delivery degrades.', build: withLoad(120, (a) => setCfg(a, 'redis', 'capacity', 60)), faults: [] },
  { id: 'redis-outage', name: 'Redis outage', description: 'Redis goes down at t=10s for 15s. Local delivery continues, cross-gateway delivery is lost and not replayed.', build: withLoad(100), faults: [{ kind: 'crash', target: 'redis', at: 10, duration: 15 }] },
  { id: 'redis-outage-buffer', name: 'Redis outage + gateway buffer', description: 'Same outage, but gateways buffer publishes and flush on recovery (late delivery; a gateway feature, not Redis).', build: withLoad(100, (a) => ['gw1', 'gw2', 'gw3'].forEach((g) => setCfg(a, g, 'redisPolicy', 'buffer'))), faults: [{ kind: 'crash', target: 'redis', at: 10, duration: 15 }] },
  { id: 'gw-crash', name: 'One gateway crash', description: 'Gateway 1 crashes at t=10s for 25s. Connections drop, the NLB detects it after its health-check delay, survivors absorb the clients.', build: withLoad(100), faults: [{ kind: 'crash', target: 'gw1', at: 10, duration: 25 }] },
  { id: 'spike', name: 'Traffic spike', description: 'Offered load ×6 for 10s starting at t=10s.', build: withLoad(100), faults: [{ kind: 'spike', target: '', at: 10, duration: 10, amount: 6 }] },
  { id: 'slow-subs', name: 'Slow subscribers', description: 'Subscriber capacity drops to 10% at t=8s. Delivery queues fill and deliveries drop; with high fan-out this hurts quickly.', build: withLoad(150), faults: [{ kind: 'slow-consumer', target: 'subs', at: 8, duration: 20 }] },
];
