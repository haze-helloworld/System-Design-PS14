import { describe, it, expect } from 'vitest';
import { Engine } from './engine';
import { defaultArchitecture } from './presets';
import { parseArchitecture, serializeArchitecture, validateArchitecture, validateConnection } from './validate';
import type { Architecture } from './types';

const mk = (load = 100, mut?: (a: Architecture) => void) => {
  const a = defaultArchitecture(); a.settings.offeredLoad = load; mut?.(a); return new Engine(a);
};
const cfg = (a: Architecture, id: string, k: string, v: number | string | boolean) => { a.nodes.find((n) => n.id === id)!.config[k] = v; };

describe('capacity, utilization, throughput', () => {
  it('healthy baseline: no drops, throughput ≈ offered, gateways well below capacity', () => {
    const e = mk(100); e.advance(20); const s = e.snapshot();
    expect(s.global.errorRate).toBeLessThan(0.01);
    expect(s.global.completed).toBeGreaterThan(90);
    expect(s.global.completed).toBeLessThan(110);
    for (const g of ['gw1', 'gw2', 'gw3']) expect(s.nodes[g].utilIngress).toBeLessThan(0.5);
    expect(s.bottleneck).toBeNull();
  });
  it('utilization = served / capacity (≈33 msg/s + 20 heartbeats/s of 150 ≈ 35%)', () => {
    const e = mk(100); e.advance(20); const u = e.snapshot().nodes.gw2.utilIngress;
    expect(u).toBeGreaterThan(0.3); expect(u).toBeLessThan(0.4);
  });
  it('overload: completed throughput plateaus below offered and drops appear', () => {
    const e = mk(600); e.advance(40); const s = e.snapshot();
    expect(s.global.completed).toBeLessThanOrEqual(460);
    expect(s.global.dropped).toBeGreaterThan(50);
    expect(s.global.errorRate).toBeGreaterThan(0.15);
    expect(s.global.completed).toBeLessThan(s.global.offered); // offered is never reported as success
  });
});

describe('queueing and latency', () => {
  it('queue grows to its configured capacity under overload', () => {
    const e = mk(600); e.advance(30); const n = e.snapshot().nodes.gw1;
    expect(n.waiting).toBeGreaterThan(300); expect(n.waiting).toBeLessThanOrEqual(500 + 1e-6);
  });
  it('queue grows monotonically early on', () => {
    const e = mk(600); e.advance(1); const a = e.snapshot().nodes.gw1.waiting; e.advance(1); const b = e.snapshot().nodes.gw1.waiting;
    expect(b).toBeGreaterThan(a);
  });
  it('p99 latency rises when the same load meets less capacity', () => {
    const base = mk(100); base.advance(20);
    const slow = mk(100, (a) => ['gw1', 'gw2', 'gw3'].forEach((g) => cfg(a, g, 'capacity', 36))); slow.advance(20);
    expect(slow.snapshot().nodes.gw2.p99).toBeGreaterThan(base.snapshot().nodes.gw2.p99 * 2);
    expect(slow.snapshot().global.p99).toBeGreaterThan(base.snapshot().global.p99);
  });
  it('edge latency adds to end-to-end latency', () => {
    const a = mk(100); a.advance(15);
    const b = mk(100, (x) => x.edges.forEach((e) => { e.config.latencyMs += 50; })); b.advance(15);
    expect(b.snapshot().global.p50).toBeGreaterThan(a.snapshot().global.p50 + 100);
  });
  it('bounded queue + timeout drops stale work', () => {
    const e = mk(600, (a) => ['gw1', 'gw2', 'gw3'].forEach((g) => { cfg(a, g, 'queueCapacity', 100000); cfg(a, g, 'timeoutMs', 1000); })); e.advance(20);
    expect(e.snapshot().nodes.gw1.reasons.timeout).toBeGreaterThan(0);
  });
});

describe('fan-out', () => {
  it('deliveries ≈ completed messages × fanout, no double counting of the origin gateway', () => {
    const e = mk(100); e.advance(25); const g = e.snapshot().global;
    expect(g.delivered).toBeGreaterThan(100 * 20 * 0.9);
    expect(g.delivered).toBeLessThan(100 * 20 * 1.1);
    expect(g.deliveryRatio).toBeGreaterThan(0.95);
  });
  it('higher fan-out increases delivery load on gateways', () => {
    const lo = mk(100); lo.advance(15);
    const hi = mk(100, (a) => cfg(a, 'subs', 'fanout', 100)); hi.advance(15);
    expect(hi.snapshot().nodes.gw1.utilEgress).toBeGreaterThan(lo.snapshot().nodes.gw1.utilEgress * 3);
  });
  it('connections are spread across gateways', () => {
    const s = mk(100).snapshot();
    expect(s.nodes.gw1.conns + s.nodes.gw2.conns + s.nodes.gw3.conns).toBe(600);
    expect(Math.abs(s.nodes.gw1.conns - s.nodes.gw2.conns)).toBeLessThanOrEqual(1);
  });
  it('a gateway added mid-run picks up connections via rebalancing', () => {
    const e = mk(100); const a = structuredClone(e.arch);
    const g3 = a.nodes.find((n) => n.id === 'gw3')!;
    a.nodes.push({ ...structuredClone(g3), id: 'gw4', name: 'WebSocket Gateway 4' });
    for (const ed of a.edges.filter((x) => x.sourceNodeId === 'gw3' || x.targetNodeId === 'gw3')) {
      const c = structuredClone(ed); c.sourceNodeId = c.sourceNodeId === 'gw3' ? 'gw4' : c.sourceNodeId; c.targetNodeId = c.targetNodeId === 'gw3' ? 'gw4' : c.targetNodeId;
      c.id = `${c.sourceNodeId}.${c.sourcePort}->${c.targetNodeId}.${c.targetPort}`; a.edges.push(c);
    }
    e.sync(a); e.advance(15); const s = e.snapshot();
    expect(s.nodes.gw4.conns).toBeGreaterThan(100);
  });
});

describe('failures', () => {
  it('gateway crash: connections drop, NLB detects after delay, survivors absorb, recovery rebalances', () => {
    const e = mk(100); e.advance(5);
    e.inject({ kind: 'crash', target: 'gw1', startAt: e.t, until: e.t + 20 });
    e.advance(0.2); expect(e.snapshot().nodes.gw1.conns).toBe(0); expect(e.snapshot().nodes.gw1.health).toBe('down');
    e.advance(8); const mid = e.snapshot();
    expect(mid.nodes.gw1.conns).toBe(0);
    expect(mid.nodes.gw2.conns + mid.nodes.gw3.conns).toBe(600);
    expect(mid.nodes.gw2.util).toBeGreaterThan(0);
    e.advance(40); const end = e.snapshot();
    expect(end.nodes.gw1.health).not.toBe('down'); expect(end.nodes.gw1.conns).toBeGreaterThan(100);
  });
  it('undetected crash blackholes new connections until the health-check delay passes', () => {
    const e = mk(100, (a) => cfg(a, 'nlb', 'healthCheckDelaySec', 5)); e.advance(2);
    e.inject({ kind: 'crash', target: 'gw1', startAt: e.t });
    e.advance(0.3); const s = e.snapshot();
    expect(s.global.pending).toBeGreaterThan(0); // refused connects still waiting
    expect(s.nodes.client.reasons['connect-refused']).toBeGreaterThan(0);
  });
  it('without auto-reconnect, crashed connections are lost', () => {
    const e = mk(100, (a) => cfg(a, 'client', 'autoReconnect', false)); e.advance(2);
    e.inject({ kind: 'crash', target: 'gw1', startAt: e.t }); e.advance(2);
    expect(e.snapshot().global.lost).toBe(200);
  });
  it('Redis outage: local delivery continues, cross-node delivery is lost and not replayed', () => {
    const e = mk(100); e.advance(10);
    const id = e.inject({ kind: 'crash', target: 'redis', startAt: e.t }); e.advance(8);
    const out = e.snapshot();
    expect(out.global.deliveryRatio).toBeLessThan(0.5);
    expect(out.global.deliveryRatio).toBeGreaterThan(0.2); // ≈ local 1/3 share
    expect(out.global.completed).toBeGreaterThan(80); // local path still completes
    expect(out.global.errorRate).toBeGreaterThan(0.2);
    expect(out.nodes.redis.health).toBe('down');
    e.clearFault(id); e.advance(15);
    const rec = e.snapshot();
    expect(rec.global.deliveryRatio).toBeGreaterThan(0.95);
    expect(rec.global.dropped).toBeLessThan(5);
  });
  it('gateway buffer policy delays instead of losing cross-node events', () => {
    const run = (policy: string) => {
      const e = mk(100, (a) => ['gw1', 'gw2', 'gw3'].forEach((g) => cfg(a, g, 'redisPolicy', policy))); e.advance(5);
      const id = e.inject({ kind: 'crash', target: 'redis', startAt: e.t }); e.advance(5); e.clearFault(id); e.advance(10);
      return e.snapshot();
    };
    expect(run('buffer').nodes.gw1.buffered).toBeLessThan(500);
    const drop = run('drop'), buf = run('buffer');
    expect(buf.global.p99).toBeGreaterThan(drop.global.p99); // replayed late
  });
  it('network partition cuts one gateway from Redis only', () => {
    const e = mk(100); e.advance(5);
    e.inject({ kind: 'partition', target: 'gw1', startAt: e.t }); e.advance(6); const s = e.snapshot();
    expect(s.nodes.gw1.health).toBe('degraded');
    expect(s.nodes.gw2.health).toBe('healthy');
    expect(s.global.deliveryRatio).toBeLessThan(0.95);
    expect(s.global.completed).toBeGreaterThan(80);
  });
  it('database outage fails persistence but not delivery', () => {
    const e = mk(100); e.advance(5);
    e.inject({ kind: 'crash', target: 'db', startAt: e.t }); e.advance(8); const s = e.snapshot();
    expect(s.global.persistFailures).toBeGreaterThan(0);
    expect(s.global.deliveryRatio).toBeGreaterThan(0.95);
  });
  it('traffic spike raises offered load and then recovers', () => {
    const e = mk(100); e.advance(5);
    e.inject({ kind: 'spike', target: '', startAt: e.t, until: e.t + 5, amount: 5 }); e.advance(3);
    expect(e.snapshot().global.offered).toBeGreaterThan(400);
    e.advance(20); expect(e.snapshot().global.offered).toBeLessThan(120);
  });
  it('reduced capacity raises utilization at the same load', () => {
    const a = mk(100); a.advance(15);
    const b = mk(100); b.inject({ kind: 'capacity', target: 'gw1', startAt: 0, amount: 0.25 }); b.advance(15);
    expect(b.snapshot().nodes.gw1.utilIngress).toBeGreaterThan(a.snapshot().nodes.gw1.utilIngress * 2.5);
  });
  it('queue overflow fault shrinks the queue and increases drops', () => {
    const e = mk(300); e.inject({ kind: 'queue-overflow', target: 'gw1', startAt: 0, amount: 0.02 }); e.advance(15);
    expect(e.snapshot().nodes.gw1.reasons['queue-full']).toBeGreaterThan(0);
  });
  it('slow consumers back up the delivery path', () => {
    const e = mk(150); e.inject({ kind: 'slow-consumer', target: 'subs', startAt: 5 }); e.advance(25); const s = e.snapshot();
    expect(s.nodes.subs.waiting).toBeGreaterThan(1000);
    expect(s.global.deliveryRatio).toBeLessThan(0.9);
  });
  it('reconnect storm drops and re-establishes connections', () => {
    const e = mk(100); e.advance(2);
    e.inject({ kind: 'reconnect-storm', target: '', startAt: e.t, amount: 0.5 }); e.advance(0.2);
    expect(e.snapshot().global.pending).toBeGreaterThan(100);
    e.advance(10); expect(e.snapshot().global.pending).toBe(0);
  });
  it('heartbeat timeout kills connections when the gateway cannot answer pongs', () => {
    const e = mk(600, (a) => { cfg(a, 'gw1', 'queueCapacity', 100000); cfg(a, 'gw1', 'timeoutMs', 600000); cfg(a, 'gw1', 'heartbeatTimeoutSec', 2); }); e.advance(20);
    expect(e.snapshot().nodes.gw1.reasons['heartbeat-timeout']).toBeGreaterThan(0);
  });
});

describe('bottleneck analysis', () => {
  it('identifies Redis when it is undersized', () => {
    const e = mk(120, (a) => cfg(a, 'redis', 'capacity', 60)); e.advance(25); const s = e.snapshot();
    expect(s.bottleneck?.nodeId).toBe('redis');
    expect(s.bottleneck?.text).toContain('limiting component');
    expect(s.nodes.redis.util).toBeGreaterThan(0.9);
  });
  it('identifies the gateway under gateway overload', () => {
    const e = mk(600); e.advance(25); expect(['gw1', 'gw2', 'gw3']).toContain(e.snapshot().bottleneck?.nodeId);
  });
  it('more gateways raise the ceiling (1 vs 3 gateways)', () => {
    const run = (n: number) => { const e = mk(300, (a) => { for (const g of ['gw2', 'gw3'].slice(n - 1)) { a.nodes = a.nodes.filter((x) => x.id !== g); a.edges = a.edges.filter((x) => x.sourceNodeId !== g && x.targetNodeId !== g); } cfg(a, 'client', 'connections', 200); }); e.advance(30); return e.snapshot().global.completed; };
    expect(run(3)).toBeGreaterThan(run(1) * 1.8);
  });
  it('backpressure stops upstream from dropping at the cost of queueing', () => {
    const e = mk(120, (a) => { cfg(a, 'redis', 'capacity', 60); ['gw1', 'gw2', 'gw3'].forEach((g) => cfg(a, g, 'backpressure', true)); }); e.advance(25);
    expect(e.snapshot().nodes.redis.reasons['queue-full'] ?? 0).toBeLessThan(5);
  });
});

describe('determinism', () => {
  it('same seed ⇒ identical results', () => {
    const run = () => { const e = mk(300); e.inject({ kind: 'crash', target: 'gw2', startAt: 5, until: 15 }); e.advance(30); return JSON.stringify(e.snapshot().global); };
    expect(run()).toBe(run());
  });
  it('reset reproduces the run', () => {
    const e = mk(300); e.advance(10); const a = JSON.stringify(e.snapshot().global); e.reset(); e.advance(10);
    expect(JSON.stringify(e.snapshot().global)).toBe(a);
  });
  it('changing config mid-run affects subsequent traffic', () => {
    const e = mk(100); e.advance(10); const before = e.snapshot().nodes.gw1.utilIngress;
    const a = structuredClone(e.arch); cfg(a, 'gw1', 'capacity', 40); e.sync(a); e.advance(10);
    expect(e.snapshot().nodes.gw1.utilIngress).toBeGreaterThan(before * 2);
  });
});

describe('architecture save/load and validation', () => {
  it('round-trips through JSON', () => {
    const a = defaultArchitecture(); const b = parseArchitecture(serializeArchitecture(a));
    expect(b).toEqual(a);
  });
  it('default architecture is valid', () => {
    const v = validateArchitecture(defaultArchitecture()); expect(v.errors).toEqual([]); expect(v.warnings).toEqual([]);
  });
  it('rejects unknown types, bad ports and incompatible connections', () => {
    const a = defaultArchitecture();
    expect(validateConnection(a, 'gw1', 'deliver', 'redis', 'publish')).toMatch(/Incompatible/);
    expect(validateConnection(a, 'redis', 'publish', 'gw1', 'conn')).toMatch(/output port to an input/);
    expect(validateConnection(a, 'gw1', 'nope', 'redis', 'publish')).toMatch(/Unknown port/);
    expect(validateConnection(a, 'gw1', 'publish', 'gw1', 'conn')).toMatch(/itself/);
    expect(validateConnection(a, 'gw1', 'publish', 'redis', 'publish')).toMatch(/already/);
    a.nodes[0].type = 'bogus';
    expect(validateArchitecture(a).errors.join()).toMatch(/unknown type/);
  });
  it('rejects out-of-range config and malformed json on import', () => {
    const a = defaultArchitecture(); a.nodes.find((n) => n.id === 'gw1')!.config.capacity = -5;
    expect(() => parseArchitecture(JSON.stringify(a))).toThrow(/between/);
    expect(() => parseArchitecture('{not json')).toThrow(/valid JSON/);
  });
  it('serialized JSON contains no runtime state', () => {
    const e = mk(100); e.advance(5); const text = serializeArchitecture(e.arch);
    expect(text).not.toMatch(/inflight|queue":|rng/);
  });
});
