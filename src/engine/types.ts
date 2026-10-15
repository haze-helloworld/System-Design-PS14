export type Category = 'Traffic' | 'Compute' | 'Data' | 'Messaging' | 'Networking' | 'Reliability';
export type Health = 'healthy' | 'degraded' | 'down';
export type ExecutionMode = 'simulation' | 'live';
export type CfgValue = number | boolean | string;
export type Config = Record<string, CfgValue>;

export interface ArchNode {
  id: string;
  type: string;
  name: string;
  position: { x: number; y: number };
  config: Config;
  /** Design-time health. Runtime health lives in simulation metrics, never here. */
  health: Health;
  executionMode: ExecutionMode;
}

export interface EdgeConfig {
  latencyMs: number;
  /** units/second, 0 = unlimited */
  bandwidth: number;
  lossProb: number;
  failureProb: number;
  available: boolean;
}

export interface ArchEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  config: EdgeConfig;
}

export interface Architecture {
  version: 1;
  name: string;
  settings: { offeredLoad: number; seed: number };
  nodes: ArchNode[];
  edges: ArchEdge[];
}

export type FaultKind =
  | 'crash' | 'partition' | 'latency' | 'capacity'
  | 'slow-consumer' | 'queue-overflow' | 'spike' | 'reconnect-storm';

export interface Fault {
  id: number;
  kind: FaultKind;
  target: string;
  startAt: number;
  until?: number;
  amount?: number;
  applied?: boolean;
}
