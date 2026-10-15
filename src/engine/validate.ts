import type { Architecture, ArchEdge, ArchNode } from './types';
import { DEFAULT_EDGE, DEFS } from './definitions';

export function edgeId(s: string, sp: string, t: string, tp: string) { return `${s}.${sp}->${t}.${tp}`; }

/** Returns an error message if the connection is invalid, otherwise null. */
export function validateConnection(arch: Architecture, s: string, sp: string | null | undefined, t: string, tp: string | null | undefined): string | null {
  const sn = arch.nodes.find((n) => n.id === s), tn = arch.nodes.find((n) => n.id === t);
  if (!sn || !tn) return 'Unknown component.';
  if (s === t) return 'A component cannot connect to itself.';
  const spd = DEFS[sn.type]?.ports.find((p) => p.id === sp), tpd = DEFS[tn.type]?.ports.find((p) => p.id === tp);
  if (!spd || !tpd) return 'Unknown port.';
  if (spd.dir !== 'out' || tpd.dir !== 'in') return 'Connect an output port to an input port.';
  if (spd.kind !== tpd.kind) return `Incompatible ports: "${spd.label}" (${spd.kind}) cannot feed "${tpd.label}" (${tpd.kind}).`;
  if (arch.edges.some((e) => e.id === edgeId(s, sp!, t, tp!))) return 'These ports are already connected.';
  return null;
}

export interface Validation { errors: string[]; warnings: string[] }

export function validateArchitecture(a: unknown): Validation {
  const errors: string[] = [], warnings: string[] = [];
  const x = a as Architecture;
  if (!x || typeof x !== 'object') return { errors: ['Architecture must be an object.'], warnings };
  if (x.version !== 1) errors.push('Unsupported architecture version (expected 1).');
  if (!Array.isArray(x.nodes) || !Array.isArray(x.edges)) return { errors: [...errors, 'nodes and edges must be arrays.'], warnings };
  const ids = new Set<string>();
  for (const n of x.nodes) {
    if (!n.id || typeof n.id !== 'string') { errors.push('A node is missing its id.'); continue; }
    if (ids.has(n.id)) errors.push(`Duplicate node id "${n.id}".`);
    ids.add(n.id);
    const def = DEFS[n.type];
    if (!def) { errors.push(`Node "${n.id}" has unknown type "${n.type}".`); continue; }
    if (!n.position || typeof n.position.x !== 'number' || typeof n.position.y !== 'number') errors.push(`Node "${n.id}" has an invalid position.`);
    for (const f of def.fields) {
      const v = n.config?.[f.key];
      if (v === undefined) continue;
      if (f.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) errors.push(`${n.name}: "${f.label}" must be a number.`);
      else if (f.type === 'number' && ((f.min !== undefined && (v as number) < f.min) || (f.max !== undefined && (v as number) > f.max))) errors.push(`${n.name}: "${f.label}" must be between ${f.min} and ${f.max}.`);
      if (f.type === 'select' && !f.options!.includes(String(v))) errors.push(`${n.name}: invalid value for "${f.label}".`);
    }
  }
  const seen = new Set<string>();
  for (const e of x.edges) {
    if (seen.has(e.id)) errors.push(`Duplicate connection id "${e.id}".`);
    seen.add(e.id);
    const rest: Architecture = { ...x, edges: [] };
    const err = validateConnection(rest, e.sourceNodeId, e.sourcePort, e.targetNodeId, e.targetPort);
    if (err) errors.push(`Connection ${e.id}: ${err}`);
    const c = e.config;
    if (!c || typeof c.latencyMs !== 'number' || c.latencyMs < 0) errors.push(`Connection ${e.id}: invalid latency.`);
    else if (c.lossProb < 0 || c.lossProb > 1 || c.failureProb < 0 || c.failureProb > 1) errors.push(`Connection ${e.id}: probabilities must be within 0..1.`);
  }
  if (!x.settings || typeof x.settings.offeredLoad !== 'number') errors.push('settings.offeredLoad is required.');
  if (errors.length) return { errors, warnings };
  const types = (t: string) => x.nodes.filter((n) => n.type === t);
  if (!types('client').length) warnings.push('No Client Generator: nothing will generate traffic.');
  if (!types('ws-gateway').length) warnings.push('No WebSocket Gateway: clients have nowhere to connect.');
  for (const c of types('client')) if (!x.edges.some((e) => e.sourceNodeId === c.id)) warnings.push(`${c.name} has no outgoing connection.`);
  for (const g of types('ws-gateway')) {
    if (!x.edges.some((e) => e.targetNodeId === g.id && e.targetPort === 'conn')) warnings.push(`${g.name} receives no client connections.`);
    if (!x.edges.some((e) => e.sourceNodeId === g.id && e.sourcePort === 'deliver')) warnings.push(`${g.name} has no delivery path to subscribers.`);
  }
  return { errors, warnings };
}

/** Fill defaults for anything missing so older/partial files still load. */
export function normalize(a: Architecture): Architecture {
  return {
    version: 1, name: a.name ?? 'Untitled', settings: { offeredLoad: a.settings?.offeredLoad ?? 100, seed: a.settings?.seed ?? 1 },
    nodes: (a.nodes ?? []).map((n: ArchNode) => ({
      id: n.id, type: n.type, name: n.name ?? DEFS[n.type]?.label ?? n.type, position: n.position ?? { x: 0, y: 0 },
      config: { ...(DEFS[n.type]?.defaults ?? {}), ...(n.config ?? {}) }, health: n.health ?? 'healthy', executionMode: n.executionMode ?? 'simulation',
    })),
    edges: (a.edges ?? []).map((e: ArchEdge) => ({ ...e, config: { ...DEFAULT_EDGE, ...(e.config ?? {}) } })),
  };
}

export function serializeArchitecture(a: Architecture): string { return JSON.stringify(a, null, 2); }

export function parseArchitecture(text: string): Architecture {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('File is not valid JSON.'); }
  const arch = normalize(raw as Architecture);
  const v = validateArchitecture(arch);
  if (v.errors.length) throw new Error(v.errors.slice(0, 5).join('\n'));
  return arch;
}
