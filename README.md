# Distributed Systems Lab — Mini Discord (Topic 14)

Interactive, browser-based virtual lab for distributed architectures. Case study: **Real-Time Pub/Sub WebSocket Gateway** (a simulated Mini Discord). Phase 1 runs entirely in the browser: no cloud account, backend or paid service.

## Run it
```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 37 engine tests
npm run build    # typecheck + production build
```

## What you can do
- Default architecture loads on first open: Client Generator → NLB → 3 WebSocket Gateways ⇄ Redis Pub/Sub → Subscribers, plus Presence store, Subscription registry, async persistence (Worker → DB).
- Drag components from the sidebar (or double-click), connect output handles to compatible input handles, rename, delete, multi-select (Shift), pan/zoom, minimap, undo/redo, fit (F).
- Offered-load slider and presets (1…5k msg/s) actually drive the engine. Run / Pause / Step / Reset / speed.
- Select a component or connection to edit capacity, latency, queue, timeout, retries, failure probability, etc. Changes affect subsequent traffic immediately.
- Failure lab: gateway crash, Redis outage, DB outage, partition, latency, reduced capacity, traffic spike, slow consumer, queue overflow, reconnect storm.
- Experiments tab: reproducible presets (baseline, gateway overload, Redis bottleneck, Redis outage ± gateway buffer, gateway crash, spike, slow subscribers).
- Message traces: sampled messages with their path; click to highlight it on the canvas (branches show local vs. cross-gateway delivery).
- Bottleneck detection with explanation; node cards show `% BUSY | P99 | WAITING` from the engine.
- Save (browser localStorage), auto-draft, JSON export/import/copy.

Shortcuts: Space run/pause, `.` step, Ctrl+Z / Ctrl+Y, Delete, F fit.

## Architecture
```
src/engine/   framework-free simulation (no React)
  types.ts        serializable architecture model (nodes, edges, faults)
  definitions.ts  component registry: ports, defaults, inspector fields, planned components
  engine.ts       discrete-time engine + snapshot()
  validate.ts     connection/architecture validation, import/export
  presets.ts      default Mini Discord + experiment presets
  adapters.ts     ExecutionAdapter interface; SimulationAdapter; LiveAdapter stub
src/store.ts  zustand store (architecture, undo/redo, sim loop). Runtime metrics live in the engine, never in saved JSON.
src/ui/       React components (React Flow canvas, inspector, toolbar, panels)
```
Saved architecture = `{version, name, settings, nodes[{id,type,name,position,config,health,executionMode}], edges[{id,sourceNodeId,sourcePort,targetNodeId,targetPort,config}]}`.

## Simulation model and assumptions
- **Discrete-time**, fixed 100 ms step, deterministic. The only randomness is ±20% per-hop service jitter from a seeded PRNG (mulberry32; seed in Settings).
- **Fluid cohorts**: work moves as batches with fractional message counts (expected values), not individual packets. Counts are therefore smooth and reproducible.
- **Queueing**: each processor is a FIFO queue served at a fixed rate (capacity units/s). Bounded queue → overflow dropped. Waiting beyond the timeout is retried (if retries > 0) or dropped. Optional backpressure makes upstream stop serving instead of dropping.
- **Latency** per batch = edge latency + queue wait + processing. P50/P95/P99 are weighted over a rolling 10 s window; per-node and end-to-end are tracked separately.
- **Utilization** = units served over last 2 s ÷ (current capacity × 2 s). Below-capacity traffic never shows as overloaded.
- **Throughput** is split into offered, accepted (admitted by a gateway), completed (origin gateway delivered), deliveries, and dropped. Error rate ≈ lost message-equivalents ÷ offered (cross-node losses weighted by the share of subscribers affected). Persistence failures are reported separately.
- **Message path**: gateway ingest → local delivery *and* Redis publish → Redis broadcasts to every *other* gateway → their local subscribers. The origin is excluded so nothing is delivered twice. Fan-out per message = Subscriber node `fanout`, split by connection share.
- **Connections**: counts assigned to gateways; kept until disconnect/crash/heartbeat timeout. Max connections per gateway enforced. NLB detects a crashed gateway only after its health-check delay (new connections to it fail meanwhile). "Rebalance rate" models periodic client reconnects so new/recovered gateways take load.
- **Heartbeats** load ingest capacity; if ingest wait exceeds the heartbeat timeout, connections are marked dead and reconnect.
- **Redis Pub/Sub** is transient: tiny buffer, no replay. During an outage cross-node events are dropped; the optional gateway-side buffer (`redisPolicy = buffer`) re-sends later, delayed, and is labelled as a gateway feature.
- Presence/Registry nodes are state stores: if a linked one is down and "required for admission" is on, that gateway refuses new connections. Edges into them carry no traffic.

## Known limitations
- Defaults are illustrative, not calibrated against real AWS/Redis/WebSocket measurements; don't treat outputs as production predictions.
- Fluid model: no per-packet ordering, no tail effects beyond what queueing and jitter produce. Only one channel (#general) is modelled, with a single Redis topic.
- Persistence is asynchronous via topology (gateway → Worker → DB or direct); no synchronous "persist before broadcast" mode yet.
- Planned components in the sidebar (CDN, caches, circuit breaker, …) are shown disabled; they are not simulated.
- The UI was type-checked and built, and the engine is covered by tests, but the interface itself has not been exercised in an automated browser test.
- Comparison mode (side-by-side runs) is not implemented; use Experiments presets or Reset + change a setting.

## Roadmap to real infrastructure (Phase 2)
1. Implement `ExecutionAdapter` per component type (WebSocket gateway, Redis/ElastiCache, Postgres, metrics via Prometheus) behind `executionMode: 'live'`.
2. A small authenticated control-plane backend holds credentials (never in the browser) and exposes a read-only metrics stream; the UI only talks to it.
3. Live mode must be explicitly enabled per component and must never fall back to simulated numbers (`LiveAdapter` currently throws to guarantee this). Mark every metric as measured vs simulated in the UI.
4. Calibrate engine defaults with measured capacity/latency from live runs, then compare simulated vs measured.
