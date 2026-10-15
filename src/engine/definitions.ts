import type { Category, Config } from './types';

export type Role = 'source' | 'router' | 'gateway' | 'broker' | 'sink' | 'passthrough' | 'state';
export interface PortDef { id: string; dir: 'in' | 'out'; kind: string; label: string; side: 'left' | 'right' | 'top' | 'bottom' }
export interface FieldDef {
  key: string; label: string; type: 'number' | 'boolean' | 'select';
  unit?: string; min?: number; max?: number; step?: number; options?: string[]; help?: string;
}
export interface ComponentDef {
  type: string; label: string; category: Category; description: string; icon: string;
  role: Role; ports: PortDef[]; defaults: Config; fields: FieldDef[]; note?: string;
}
export interface PlannedDef { type: string; label: string; category: Category; description: string; icon: string }

const n = (key: string, label: string, unit: string | undefined, min: number, max: number, step = 1, help?: string): FieldDef =>
  ({ key, label, type: 'number', unit, min, max, step, help });
const b = (key: string, label: string, help?: string): FieldDef => ({ key, label, type: 'boolean', help });
const s = (key: string, label: string, options: string[], help?: string): FieldDef => ({ key, label, type: 'select', options, help });
const P = (id: string, dir: 'in' | 'out', kind: string, label: string, side: PortDef['side']): PortDef => ({ id, dir, kind, label, side });

const proc = [
  n('processingMs', 'Processing latency', 'ms', 0, 5000),
  n('failureProb', 'Failure probability', undefined, 0, 1, 0.01, 'Fraction of work that fails after being served.'),
  n('queueCapacity', 'Queue capacity', 'items', 0, 1000000, 10, 'Work above this is rejected (dropped).'),
  n('timeoutMs', 'Timeout', 'ms', 10, 600000, 50, 'Work waiting longer than this is retried or dropped.'),
  n('retries', 'Retry count', undefined, 0, 5),
];
const common = { processingMs: 5, failureProb: 0, queueCapacity: 1000, timeoutMs: 2000, retries: 0 };

export const DEFS: Record<string, ComponentDef> = {
  client: {
    type: 'client', label: 'Client Generator', category: 'Traffic', icon: 'Users', role: 'source',
    description: 'Simulated Discord clients. Owns a pool of WebSocket connections and publishes messages at the offered load.',
    ports: [P('publish', 'out', 'ws', 'publish', 'right')],
    defaults: { connections: 600, connectRate: 200, autoReconnect: true, share: 1 },
    fields: [
      n('connections', 'Connected clients', 'clients', 0, 50000, 10),
      n('connectRate', 'Connect / reconnect rate', 'conn/s', 1, 10000, 10),
      b('autoReconnect', 'Auto-reconnect', 'Dropped connections re-enter the connect pool.'),
      n('share', 'Share of offered load', 'weight', 0, 10, 0.1),
    ],
  },
  'load-balancer': {
    type: 'load-balancer', label: 'Network Load Balancer', category: 'Traffic', icon: 'Network', role: 'router',
    description: 'Assigns new connections to healthy gateways and spreads messages by connection count.',
    ports: [P('in', 'in', 'ws', 'in', 'left'), P('out', 'out', 'ws', 'out', 'right')],
    defaults: { capacity: 20000, ...common, processingMs: 1, queueCapacity: 5000, algorithm: 'round-robin', healthCheckDelaySec: 3, rebalanceRate: 50, backpressure: false },
    fields: [
      n('capacity', 'Capacity', 'msg/s', 1, 1000000, 100), ...proc,
      s('algorithm', 'Connection algorithm', ['round-robin', 'least-connections']),
      n('healthCheckDelaySec', 'Health-check detection delay', 's', 0, 60, 0.5, 'A crashed gateway keeps receiving new connections (which fail) until detected.'),
      n('rebalanceRate', 'Rebalance rate', 'conn/s', 0, 5000, 5, 'Models clients periodically reconnecting; 0 disables. Lets new/recovered gateways pick up load.'),
      b('backpressure', 'Backpressure', 'Stop serving when the downstream queue is full instead of dropping.'),
    ],
  },
  'ws-gateway': {
    type: 'ws-gateway', label: 'WebSocket Gateway', category: 'Compute', icon: 'RadioTower', role: 'gateway',
    description: 'Terminates WebSocket connections, validates and publishes messages, and delivers broadcasts to its local subscribers.',
    ports: [
      P('conn', 'in', 'ws', 'conn', 'left'), P('broadcast', 'in', 'broadcast', 'broadcast', 'bottom'),
      P('publish', 'out', 'pubsub', 'publish', 'right'), P('deliver', 'out', 'delivery', 'deliver', 'right'),
      P('persist', 'out', 'persist', 'persist', 'right'), P('session', 'out', 'state', 'session', 'right'),
    ],
    defaults: {
      capacity: 150, egressCapacity: 6000, maxConnections: 300, ...common, processingMs: 4, queueCapacity: 500,
      egressQueueCapacity: 20000, heartbeatSec: 10, heartbeatTimeoutSec: 5, redisPolicy: 'drop', bufferCapacity: 2000,
      persistMessages: true, backpressure: false,
    },
    fields: [
      n('capacity', 'Ingest capacity', 'msg/s', 1, 1000000, 10),
      n('egressCapacity', 'Delivery capacity', 'deliveries/s', 1, 10000000, 100),
      n('maxConnections', 'Max connections', 'conns', 1, 1000000, 10),
      ...proc,
      n('egressQueueCapacity', 'Delivery queue capacity', 'items', 0, 10000000, 100),
      n('heartbeatSec', 'Heartbeat interval', 's', 1, 120, 1, 'Ping/pong load = connections / interval, served from ingest capacity.'),
      n('heartbeatTimeoutSec', 'Heartbeat timeout', 's', 1, 120, 1, 'If ingest wait exceeds this, connections are marked dead, removed from presence and reconnect.'),
      s('redisPolicy', 'If Redis unreachable', ['drop', 'buffer'], 'drop = Pub/Sub semantics (lost). buffer = gateway-side buffer, flushed on recovery (not a Redis feature).'),
      n('bufferCapacity', 'Redis outage buffer', 'msgs', 0, 1000000, 100),
      b('persistMessages', 'Persist messages', 'Send a write down the "persist" port (to a Worker or Database).'),
      b('backpressure', 'Backpressure', 'Stop serving when the downstream queue is full.'),
    ],
  },
  'redis-pubsub': {
    type: 'redis-pubsub', label: 'Redis Pub/Sub', category: 'Messaging', icon: 'Rss', role: 'broker',
    description: 'Transient fan-out backplane. Routes each published event to every other gateway. No durability, no replay.',
    ports: [P('publish', 'in', 'pubsub', 'publish', 'left'), P('broadcast', 'out', 'broadcast', 'broadcast', 'bottom')],
    defaults: { capacity: 500, ...common, processingMs: 1, queueCapacity: 200, timeoutMs: 500 },
    fields: [n('capacity', 'Publish capacity', 'ops/s', 1, 10000000, 50), ...proc],
    note: 'Pub/Sub has no durable queue. "Queue capacity" models a small in-memory buffer; overflow is dropped, never retried by Redis.',
  },
  database: {
    type: 'database', label: 'Persistent Message DB', category: 'Data', icon: 'Database', role: 'sink',
    description: 'Durable message history. Receives persist writes.',
    ports: [P('write', 'in', 'persist', 'write', 'left')],
    defaults: { capacity: 200, ...common, processingMs: 12, queueCapacity: 2000, timeoutMs: 5000 },
    fields: [n('capacity', 'Write capacity', 'writes/s', 1, 1000000, 10), ...proc],
  },
  worker: {
    type: 'worker', label: 'Background Worker', category: 'Compute', icon: 'Cog', role: 'passthrough',
    description: 'Asynchronously persists messages: consumes from gateways and writes to the database.',
    ports: [P('in', 'in', 'persist', 'in', 'left'), P('out', 'out', 'persist', 'out', 'right')],
    defaults: { capacity: 300, ...common, processingMs: 5, queueCapacity: 5000, timeoutMs: 30000, retries: 2, backpressure: false },
    fields: [n('capacity', 'Capacity', 'jobs/s', 1, 1000000, 10), ...proc, b('backpressure', 'Backpressure')],
  },
  queue: {
    type: 'queue', label: 'Queue', category: 'Compute', icon: 'Layers', role: 'passthrough',
    description: 'Generic buffering stage between two components.',
    ports: [P('in', 'in', 'persist', 'in', 'left'), P('out', 'out', 'persist', 'out', 'right')],
    defaults: { capacity: 1000, ...common, processingMs: 1, queueCapacity: 10000, timeoutMs: 30000, backpressure: false },
    fields: [n('capacity', 'Drain rate', 'items/s', 1, 1000000, 10), ...proc, b('backpressure', 'Backpressure')],
  },
  'subscriber-clients': {
    type: 'subscriber-clients', label: 'Subscriber Clients', category: 'Traffic', icon: 'MessagesSquare', role: 'sink',
    description: 'Clients subscribed to #general. Each message fans out to this many recipients, split across gateways by connection share.',
    ports: [P('deliver', 'in', 'delivery', 'deliver', 'left')],
    defaults: { fanout: 20, capacity: 20000, ...common, processingMs: 20, queueCapacity: 5000, timeoutMs: 3000 },
    fields: [
      n('fanout', 'Recipients per message', 'subs', 0, 100000, 1),
      n('capacity', 'Receive capacity', 'deliveries/s', 1, 10000000, 100), ...proc,
    ],
  },
  'session-store': {
    type: 'session-store', label: 'Presence / Session Store', category: 'Data', icon: 'UserCheck', role: 'state',
    description: 'Tracks sessions and presence. Gateways need it to admit new connections.',
    ports: [P('state', 'in', 'state', 'state', 'left')],
    defaults: { requiredForAdmission: true },
    fields: [b('requiredForAdmission', 'Required to admit connections', 'If it is down, linked gateways refuse new connections.')],
  },
  'subscription-registry': {
    type: 'subscription-registry', label: 'Channel Subscription Registry', category: 'Data', icon: 'ListChecks', role: 'state',
    description: 'Maps application channels (#general) to gateways. Required to register subscriptions on join.',
    ports: [P('state', 'in', 'state', 'state', 'left')],
    defaults: { requiredForAdmission: true },
    fields: [b('requiredForAdmission', 'Required to admit connections', 'If it is down, linked gateways cannot register joins.')],
  },
};

const pl = (type: string, label: string, category: Category, icon: string, description: string): PlannedDef => ({ type, label, category, icon, description });
export const PLANNED: PlannedDef[] = [
  pl('cdn', 'CDN', 'Traffic', 'Globe', 'Edge cache for static assets.'),
  pl('edge-compute', 'Edge Compute', 'Traffic', 'Cpu', 'Compute close to clients.'),
  pl('api-server', 'API Server', 'Compute', 'Server', 'Request/response service.'),
  pl('retry-queue', 'Retry Queue', 'Compute', 'RefreshCw', 'Delayed retries.'),
  pl('cache', 'Cache', 'Data', 'Zap', 'Read-through cache.'),
  pl('write-behind-cache', 'Write-Behind Cache', 'Data', 'HardDriveDownload', 'Batched async writes.'),
  pl('read-replica', 'Read Replica', 'Data', 'Copy', 'Replicated read path.'),
  pl('sharded-store', 'Sharded Store', 'Data', 'Boxes', 'Partitioned storage.'),
  pl('durable-broker', 'Durable Message Broker', 'Messaging', 'Inbox', 'Persistent log with replay.'),
  pl('topic', 'Topic / Channel', 'Messaging', 'Hash', 'Explicit channel nodes.'),
  pl('consumer', 'Message Consumer', 'Messaging', 'Download', 'Consumer group.'),
  pl('network-link', 'Network Link', 'Networking', 'Link2', 'Already available: select any connection to edit latency, bandwidth, loss.'),
  pl('api-gateway', 'API Gateway', 'Networking', 'Shield', 'Routing, auth and throttling.'),
  pl('service-discovery', 'Service Discovery', 'Networking', 'Compass', 'Dynamic endpoints.'),
  pl('circuit-breaker', 'Circuit Breaker', 'Reliability', 'ShieldAlert', 'Fail fast on unhealthy dependencies.'),
  pl('retry-policy', 'Retry Policy', 'Reliability', 'Repeat', 'Backoff and jitter.'),
  pl('health-checker', 'Health Checker', 'Reliability', 'HeartPulse', 'Active probes.'),
  pl('dlq', 'Dead-Letter Queue', 'Reliability', 'Skull', 'Parking lot for failed work.'),
];

export const CATEGORIES: Category[] = ['Traffic', 'Compute', 'Data', 'Messaging', 'Networking', 'Reliability'];

export const DEFAULT_EDGE = { latencyMs: 2, bandwidth: 0, lossProb: 0, failureProb: 0, available: true };
