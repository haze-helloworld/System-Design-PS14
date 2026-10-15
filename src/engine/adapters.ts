/**
 * Phase 2 seam. The editor and the simulator both talk to components through these interfaces.
 * Phase 1 implements only SimulationAdapter. LiveAdapter is deliberately a stub that refuses to
 * run: live mode must be opted into explicitly and must never fall back to fake metrics.
 */
import type { Architecture, ExecutionMode } from './types';
import type { Snapshot } from './engine';
import { Engine } from './engine';

export interface ExecutionAdapter {
  readonly mode: ExecutionMode;
  /** True only if metrics are real measurements. */
  readonly measured: boolean;
  load(arch: Architecture): void;
  step(): void;
  reset(): void;
  metrics(): Snapshot;
}

export class SimulationAdapter implements ExecutionAdapter {
  readonly mode = 'simulation' as const;
  readonly measured = false;
  readonly engine: Engine;
  constructor(arch: Architecture) { this.engine = new Engine(arch); }
  load(arch: Architecture) { this.engine.sync(arch); }
  step() { this.engine.step(); }
  reset() { this.engine.reset(); }
  metrics() { return this.engine.snapshot(); }
}

export interface LiveConfig { endpoint: string; credentialsRef: string }

/** Placeholder: Phase 2 will implement WebSocket/Redis/DB/Prometheus adapters per component. */
export class LiveAdapter implements ExecutionAdapter {
  readonly mode = 'live' as const;
  readonly measured = true;
  constructor(readonly config: LiveConfig) {}
  private unsupported(): never { throw new Error('Live mode is not implemented in Phase 1. No simulated data is substituted.'); }
  load() { this.unsupported(); }
  step() { this.unsupported(); }
  reset() { this.unsupported(); }
  metrics(): Snapshot { return this.unsupported(); }
}
