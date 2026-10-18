// The recovery architecture as a graph that grows with the run.
//
// The full logical architecture is fixed (demand → gateway → serving units on
// GPUs, network, cooling and power → telemetry → one controller → two tool
// collections → shadow twin → policy gate → act → verify → certificate), but a
// module is only shown once the run reaches it or a real event makes it relevant:
// the failure landing on a component, a tool call reading one, an action changing
// one. Every state comes from the FlowRun (itself built from the backend's events)
// and the incident; nothing here runs on a timer. When the run ends, the modules it
// never used are shown as ghosts, so the whole architecture is visible with the
// path the run actually took lit.
import type { FlowItem, FlowRun, Tone } from './flow';

export type ArchId =
  | 'users' | 'agents' | 'gateway' | 'serving' | 'gpu' | 'network' | 'cooling' | 'power' | 'telemetry'
  | 'controller' | 'tooldoc' | 'infradoc' | 'shadow' | 'policy' | 'act' | 'verify'
  | 'o-verified' | 'o-rolled' | 'o-approval' | 'o-abstain' | 'certificate';

/** context: part of the system, not on the run's path. ghost: never used by this run. */
export type ArchState = 'context' | 'active' | 'done' | 'failed' | 'waiting' | 'fault' | 'ghost';
export type EdgeKind = 'flow' | 'query' | 'act';
export type EdgeState = 'live' | 'done' | 'context' | 'fault' | 'ghost';
export type ReplicaTone = 'ok' | 'warn' | 'bad' | 'info' | 'off';

export interface ArchNode {
  id: ArchId;
  title: string;
  sub: string;
  /** What the module is doing right now, in two or three words. */
  verb: string | null;
  state: ArchState;
  /** An honesty label: SIMULATED, PREDICTED, RECORDED. */
  tag: string | null;
  /** Reveal order; the scene materializes modules in this order. */
  order: number;
  items: FlowItem[];
  replicas?: { id: string; tone: ReplicaTone }[];
}

export interface ArchEdge { id: string; from: ArchId; to: ArchId; kind: EdgeKind; state: EdgeState; order: number }

export interface ArchModel {
  nodes: ArchNode[];
  edges: ArchEdge[];
  /** The module executing now; null when nothing is running. */
  current: ArchId | null;
  /** The component of the twin each tool call or action is touching right now (for the traces). */
  touching: { from: ArchId; resource: string; kind: 'query' | 'act' } | null;
}

export interface ArchContext {
  source: 'twin' | 'fleet';
  faultKind: string | null;
  /** Where the failure landed, by backend id: vllm-1, A4-n2, B3, CRAH-1, UPS-A, target-b. */
  faultTargets: string[];
  replicas: { id: string; tone: ReplicaTone }[];
  controller: string;
  controllerReal: boolean;
}

export const OUTCOME_NODE = { VERIFIED: 'o-verified', ROLLED_BACK: 'o-rolled', REQUIRES_APPROVAL: 'o-approval', ABSTAIN: 'o-abstain' } as const;
const OUTCOMES: ArchId[] = ['o-verified', 'o-rolled', 'o-approval', 'o-abstain'];

const TOOL_VERB: Record<string, string> = {
  run_canary: 'Running canary', read_serving_config: 'Reading config', read_raw_generation: 'Reading raw output', get_change_history: 'Reading change log',
  read_logs: 'Reading logs', list_workers: 'Listing replicas', query_metrics: 'Querying metrics', inspect_gpu: 'Reading DCGM', inspect_facility: 'Checking facility',
  inspect_network: 'Measuring link', retrieve_incident_context: 'Recalling incidents', simulate_action: 'Simulating action',
  describe_environment: 'Mapping environment', list_resources: 'Listing resources', get_configuration: 'Reading config', get_resource_state: 'Reading state', run_probe: 'Running probe',
};
const ACT_VERB: Record<string, string> = {
  restart_worker: 'Restarting', patch_config: 'Applying patch', patch_serving_config: 'Applying patch', drain_worker: 'Draining', set_route_weight: 'Reweighting',
  set_concurrency: 'Capping concurrency', throttle: 'Throttling', set_power_limit: 'Capping power', pause_batch: 'Pausing batch', resume_batch: 'Resuming batch',
  cordon_node: 'Cordoning', uncordon_node: 'Uncordoning', rollback: 'Rolling back',
};

/** Which module a backend resource id belongs to. */
export function nodeForResource(id: string): ArchId | null {
  if (/^(vllm-|target-)/.test(id)) return 'serving';
  if (/^CRAH/i.test(id)) return 'cooling';
  if (/^UPS/i.test(id)) return 'power';
  if (/^[A-Z]\d+-n\d+$/.test(id)) return 'gpu';
  if (/^[A-Z]\d+$/.test(id)) return 'network';
  if (/^(gateway|haproxy)$/i.test(id)) return 'gateway';
  if (/^(row |batch|[A-Z]$)/.test(id)) return 'gpu';
  return null;
}

function faultNodes(ctx: ArchContext): ArchId[] {
  const k = ctx.faultKind ?? '';
  if (/^net-|network_degrade/.test(k)) return ['network'];
  if (/^compound-lat/.test(k)) return ['network', 'serving'];
  if (k === 'compound') return ['cooling', 'gpu'];
  if (k === 'traffic_burst') return ['gateway'];
  if (k === 'crah_failure') return ['cooling'];
  if (k === 'power_feed_loss') return ['power'];
  if (k === 'gpu_xid') return ['gpu'];
  const out = new Set<ArchId>();
  for (const t of ctx.faultTargets) { const n = nodeForResource(t); if (n) out.add(n); }
  if (!out.size && k) out.add('serving');
  return [...out];
}

/** The tool collection a call belongs to. Twin runs are one doctor's run; a recorded
 *  Nemotron run uses one registry, grouped by what each tool inspects. */
function collectionFor(it: FlowItem, flow: FlowRun): ArchId {
  const tool = it.tool ?? it.title;
  if (tool === 'retrieve_incident_context' || tool === 'describe_environment' || tool === 'list_resources') return 'controller';
  if (flow.source === 'twin') return flow.doctor === 'tool' ? 'tooldoc' : 'infradoc';
  if (tool === 'get_configuration') return 'tooldoc';
  if (tool === 'run_probe') return /tool-call/.test(it.detail ?? '') ? 'tooldoc' : 'infradoc';
  return 'infradoc';
}

function queryTarget(it: FlowItem): ArchId | null {
  const tool = it.tool ?? it.title;
  if (tool === 'query_metrics' || tool === 'run_canary' || tool === 'run_probe' || tool === 'get_change_history') return 'telemetry';
  if (tool === 'inspect_facility') return 'cooling';
  if (tool === 'list_workers') return 'serving';
  return it.target ? nodeForResource(it.target) : null;
}

function actTarget(kind: string | undefined, target: string | null | undefined): ArchId | null {
  if (!kind) return null;
  if (kind === 'drain_worker' || kind === 'set_route_weight' || kind === 'throttle') return 'gateway';
  if (kind === 'restart_worker' || kind === 'patch_config' || kind === 'patch_serving_config' || kind === 'set_concurrency') return 'serving';
  if (kind === 'set_power_limit' || kind === 'pause_batch' || kind === 'resume_batch' || kind === 'cordon_node' || kind === 'uncordon_node') return 'gpu';
  return target ? nodeForResource(target) : null;
}

const short = (t: string | null | undefined) => (t ? (t.length > 18 ? `${t.slice(0, 17)}…` : t) : '');

class Builder {
  nodes = new Map<ArchId, ArchNode>();
  edges = new Map<string, ArchEdge>();
  order = 0;
  current: ArchId | null = null;
  path: ArchId[] = [];
  touching: ArchModel['touching'] = null;
  constructor(private meta: Record<ArchId, { title: string; sub: string; tag: string | null }>) {}

  reveal(id: ArchId, state: ArchState = 'context', verb: string | null = null): ArchNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, ...this.meta[id], verb, state, order: this.order++, items: [] };
      this.nodes.set(id, n);
    } else if (n.state === 'ghost' || n.state === 'context') { n.state = state; if (verb) n.verb = verb; }
    return n;
  }

  edge(from: ArchId, to: ArchId, kind: EdgeKind = 'flow', state: EdgeState = 'context'): ArchEdge {
    const id = `${from}>${to}:${kind}`;
    let e = this.edges.get(id);
    if (!e) { e = { id, from, to, kind, state, order: this.order++ }; this.edges.set(id, e); }
    else if (rank(state) > rank(e.state)) e.state = state;
    return e;
  }

  /** Moves the run onto a module: the previous one settles, the edge into this one carries the signal. */
  go(id: ArchId, verb: string | null, from?: ArchId | null) {
    const prev = this.current;
    const src = from === undefined ? prev : from;
    if (src && src !== id) {
      for (const e of this.edges.values()) if (e.state === 'live' && e.kind === 'flow') e.state = 'done';
      this.edge(src, id, 'flow', 'live');
    }
    if (prev && prev !== id) {
      const p = this.nodes.get(prev)!;
      if (p.state === 'active') p.state = 'done';
    }
    const n = this.reveal(id, 'active', verb);
    n.state = 'active';
    if (verb) n.verb = verb;
    this.current = id;
    if (!this.path.includes(id)) this.path.push(id);
    for (const e of this.edges.values()) if (e.state === 'live' && e.kind !== 'flow') e.state = 'done';
    this.touching = null;
  }

  touch(from: ArchId, to: ArchId, kind: 'query' | 'act', resource: string | null | undefined) {
    this.reveal(to, this.nodes.get(to)?.state === 'fault' ? 'fault' : 'context');
    for (const e of this.edges.values()) if (e.state === 'live' && e.kind !== 'flow') e.state = 'done';
    this.edge(from, to, kind, 'live');
    this.touching = resource ? { from, resource, kind } : null;
  }

  item(id: ArchId, it: FlowItem) { this.nodes.get(id)?.items.push(it); }
}

const rank = (s: EdgeState) => ({ ghost: 0, context: 1, done: 2, fault: 3, live: 4 })[s];

function metaFor(ctx: ArchContext): Record<ArchId, { title: string; sub: string; tag: string | null }> {
  const twin = ctx.source === 'twin';
  const n = ctx.replicas.length;
  const count = (t: ReplicaTone[]) => ctx.replicas.filter((r) => t.includes(r.tone)).length;
  const health = [[count(['bad', 'warn']), 'failing'], [count(['info']), 'repairing'], [count(['off']), 'drained']].filter(([k]) => k).map(([k, w]) => `${k} ${w}`).join(' · ') || 'healthy';
  const sim = twin ? 'SIMULATED' : null;
  return {
    users: { title: 'Users & APIs', sub: 'human traffic', tag: null },
    agents: { title: 'AI agents', sub: 'tool-calling clients', tag: null },
    gateway: { title: twin ? 'Gateway' : 'HAProxy', sub: 'route · drain · reweight', tag: null },
    serving: { title: 'vLLM replicas', sub: n ? `${n} replicas · ${health}` : 'serving units', tag: null },
    gpu: { title: 'GPUs', sub: twin ? 'DCGM fields' : '1× H100', tag: sim },
    network: { title: 'Network', sub: twin ? 'ToR links' : 'worker links', tag: sim },
    cooling: { title: 'Cooling', sub: 'CRAH units', tag: 'SIMULATED' },
    power: { title: 'Power', sub: 'UPS feeds', tag: 'SIMULATED' },
    telemetry: { title: 'Telemetry', sub: twin ? 'metrics · DCGM · canaries' : 'route probe · canaries', tag: null },
    controller: { title: 'NEXUS controller', sub: ctx.controllerReal ? `NVIDIA ${ctx.controller}` : 'rule-based stand-in', tag: ctx.controllerReal ? null : 'NEMOTRON NOT CONNECTED' },
    tooldoc: { title: 'Tool-Calling Doctor', sub: 'parser · template · args', tag: null },
    infradoc: { title: 'Infrastructure Doctor', sub: 'workers · GPU · network', tag: null },
    shadow: { title: 'Shadow twin', sub: 'SimPy precheck', tag: 'PREDICTED' },
    policy: { title: 'Policy gate', sub: 'allowlist · rollback ready', tag: null },
    act: { title: twin ? 'Act' : 'Act · executor', sub: 'one bounded change', tag: null },
    verify: { title: 'Verify', sub: twin ? 'independent checks' : 'canary · referee', tag: null },
    'o-verified': { title: 'Verified', sub: '', tag: null },
    'o-rolled': { title: 'Rolled back', sub: '', tag: null },
    'o-approval': { title: 'Needs approval', sub: '', tag: null },
    'o-abstain': { title: 'Abstain', sub: '', tag: null },
    certificate: { title: 'Recovery certificate', sub: 'evidence · before/after', tag: null },
  };
}

const INFRA: ArchId[] = ['gpu', 'network', 'cooling', 'power'];
export const NEXUS: ArchId[] = ['controller', 'tooldoc', 'infradoc', 'shadow', 'policy', 'act', 'verify'];

export function buildArch(flow: FlowRun | null, ctx: ArchContext): ArchModel {
  const b = new Builder(metaFor(ctx));
  const twin = ctx.source === 'twin';

  // The system, and where the failure landed.
  const hit = faultNodes(ctx);
  b.reveal('users'); b.reveal('agents');
  b.edge('users', 'gateway'); b.edge('agents', 'gateway');
  b.reveal('gateway', hit.includes('gateway') ? 'fault' : 'context');
  b.edge('gateway', 'serving', 'flow', hit.includes('gateway') ? 'fault' : 'context');
  const serving = b.reveal('serving', hit.includes('serving') ? 'fault' : 'context');
  serving.replicas = ctx.replicas;
  for (const id of hit.filter((h) => INFRA.includes(h))) {
    b.edge('serving', id, 'flow', 'fault');
    b.reveal(id, 'fault');
    b.edge(id, 'telemetry', 'flow', 'fault');
  }
  b.edge('serving', 'telemetry', 'flow', hit.includes('serving') ? 'fault' : 'context');
  b.reveal('telemetry', 'context', 'watching');
  if (!flow) return finish(b, null, ctx);

  let lastColl: ArchId | null = null;
  let acted: ArchId | null = null;
  for (const stage of flow.stages) {
    switch (stage.key) {
      case 'detect': {
        b.go('telemetry', twin ? 'alarm raised' : 'monitoring snapshot', null);
        for (const it of stage.items) b.item('telemetry', it);
        b.go('controller', 'ingesting signal');
        break;
      }
      case 'diagnose':
        b.go('controller', twin ? 'ranking hypotheses' : 'reasoning');
        for (const it of stage.items) {
          b.item('controller', it);
          if (it.kind === 'tool') runTool(it);
        }
        break;
      case 'tools':
        for (const it of stage.items) {
          if (it.kind === 'tool') runTool(it);
          else b.item(lastColl ?? 'controller', it);
        }
        break;
      case 'shadow': {
        b.go('shadow', 'testing candidates', lastColl ?? 'controller');
        for (const it of stage.items) {
          if (it.kind === 'policy') policyItem(it);
          else if (it.kind === 'tool') runTool(it);
          else b.item(b.current ?? 'shadow', it);
        }
        const n = stage.candidates?.length;
        if (n) b.nodes.get('shadow')!.verb = b.current === 'shadow' ? `testing ${n} candidates` : `${n} candidates · predicted`;
        break;
      }
      case 'act':
        for (const it of stage.items) {
          if (it.kind === 'policy') policyItem(it);
          else if (it.kind === 'action' && it.tool === 'plan') {
            b.go('policy', 'checking plan', lastColl ?? 'controller');
            b.item('policy', it);
          } else if (it.kind === 'action' && it.id !== 'x-start' && !ACT_VERB[it.tool ?? '']) {
            // Before-state captured: rollback readiness belongs to the gate.
            b.reveal('policy'); b.item('policy', it);
            if (b.current === 'policy') b.nodes.get('policy')!.verb = 'rollback ready';
          } else if (it.kind === 'action') applyAction(it);
          else b.item(b.current ?? 'act', it);
        }
        if (!stage.items.some((i) => i.kind === 'action' && ACT_VERB[i.tool ?? ''])) {
          // The stage began but no change has been applied yet (twin: before the first action event).
          if (b.current !== 'policy' && !b.nodes.has('act')) b.go('act', 'preparing change', b.nodes.has('policy') ? 'policy' : lastColl ?? 'controller');
        }
        break;
      case 'verify':
        b.go('verify', twin ? 'verifying' : 'executor canary', b.nodes.has('act') ? 'act' : b.current);
        for (const it of stage.items) {
          if (it.kind === 'action' && it.tool === 'rollback') {
            b.nodes.get('act') && (b.nodes.get('act')!.verb = 'rolling back');
            if (acted) b.touch('act', acted, 'act', it.target);
            b.item('act', it);
          } else {
            b.item('verify', it);
            if (it.tool === 'referee') b.nodes.get('verify')!.verb = 'referee scoring';
            else if (it.kind === 'check') b.nodes.get('verify')!.verb = it.title.length < 26 ? it.title : 'checks recorded';
            else if (it.kind === 'action') b.nodes.get('verify')!.verb = 'drain applied';
          }
        }
        if (stage.headline.startsWith('Referee:')) b.nodes.get('verify')!.verb = stage.headline.replace('Referee: ', 'referee ').replace(' checks passed', ' passed');
        break;
      case 'certificate':
        break;
    }
    if (stage.status === 'halted' && b.current && stage.key !== 'certificate') {
      // A recorded agent that failed is a failure; a twin run that stopped (abstained,
      // escalated) stopped on purpose.
      const n = b.nodes.get(b.current)!;
      if (flow.source === 'fleet') { n.state = 'failed'; n.verb = 'agent failed'; } else n.state = 'waiting';
    }
    if (stage.status === 'failed' && stage.key === 'verify') {
      const v = b.nodes.get('verify');
      if (v) v.state = 'failed';
    }
  }
  if (flow.approval && b.nodes.has('policy')) {
    b.go('policy', 'awaiting your approval', b.current === 'policy' ? null : b.current);
    b.nodes.get('policy')!.state = 'waiting';
  }
  return finish(b, flow, ctx);

  function runTool(it: FlowItem) {
    const coll = collectionFor(it, flow!);
    const verb = `${(TOOL_VERB[it.tool ?? ''] ?? it.title).toLowerCase()}${it.target ? ` · ${short(it.target)}` : ''}`;
    if (coll === 'controller') {
      b.go('controller', verb);
      b.item('controller', it);
    } else {
      if (!b.nodes.has('tooldoc') && !b.nodes.has('infradoc')) {
        // The controller chooses between its two collections; both appear, one lights.
        const other: ArchId = coll === 'tooldoc' ? 'infradoc' : 'tooldoc';
        b.edge('controller', other, 'flow', 'context');
        b.reveal(other, 'context');
      }
      b.go(coll, verb, b.current === coll ? null : 'controller');
      b.item(coll, it);
      lastColl = coll;
    }
    const target = queryTarget(it);
    if (target) b.touch(coll === 'controller' ? 'controller' : coll, target, 'query', it.target);
  }

  function policyItem(it: FlowItem) {
    if (b.current !== 'policy') b.go('policy', 'checking policy', b.current);
    b.item('policy', it);
    const p = b.nodes.get('policy')!;
    if (it.tone === 'bad') { p.verb = 'candidate rejected'; p.state = 'active'; }
    if (it.tone === 'ok') { p.verb = 'approved'; p.state = 'active'; }
    if (it.tone === 'warn') { p.verb = 'awaiting approval'; p.state = 'waiting'; }
  }

  function applyAction(it: FlowItem) {
    const kind = it.tool;
    b.go('act', `${(ACT_VERB[kind ?? ''] ?? 'applying').toLowerCase()}${it.target ? ` · ${short(it.target)}` : ''}`, b.nodes.has('policy') ? 'policy' : b.current);
    b.item('act', it);
    const target = actTarget(kind, it.target);
    if (target) { acted = target; b.touch('act', target, 'act', it.target); }
  }
}

function finish(b: Builder, flow: FlowRun | null, ctx: ArchContext): ArchModel {
  const twin = ctx.source === 'twin';
  if (flow?.terminal) {
    const out = OUTCOME_NODE[flow.terminal] as ArchId;
    const tone: Tone = flow.verdict?.tone ?? 'muted';
    const from: ArchId = b.nodes.has('verify') ? 'verify' : b.current ?? 'controller';
    // The run ends: the possible outcomes branch from where it stopped, one of them lit.
    for (const o of OUTCOMES) {
      if (o === out) continue;
      b.edge(from, o, 'flow', 'ghost');
      b.reveal(o, 'ghost');
    }
    b.go(out, null, from);
    b.nodes.get(out)!.state = tone === 'ok' ? 'done' : tone === 'bad' ? 'failed' : tone === 'warn' ? 'waiting' : 'done';
    b.nodes.get(out)!.title = flow.verdict?.label === 'FALSE VERIFIED' ? 'False VERIFIED' : b.nodes.get(out)!.title;
    b.go('certificate', flow.verdict?.label.toLowerCase() ?? null);
    const cert = b.nodes.get('certificate')!;
    cert.state = tone === 'ok' ? 'done' : tone === 'bad' ? 'failed' : tone === 'warn' ? 'waiting' : 'done';
    for (const e of b.edges.values()) if (e.state === 'live') e.state = 'done';
    b.current = null;
    b.touching = null;
    // Where the failure landed reads as the outcome says: repaired, handed to a human, or still broken.
    for (const n of b.nodes.values()) if (n.state === 'fault') { if (tone === 'ok') n.state = 'done'; else if (tone === 'warn') n.state = 'waiting'; }
    for (const e of b.edges.values()) if (e.state === 'fault' && tone === 'ok') e.state = 'context';

    // A collection or stage the controller had but never used is a ghost now that the run is over.
    for (const n of b.nodes.values()) if (n.state === 'context' && NEXUS.includes(n.id)) n.state = 'ghost';
    // Whatever the run never touched is shown, dimmed, so the whole architecture reads.
    const ghost = (id: ArchId, from?: ArchId, to?: ArchId) => {
      if (!b.nodes.has(id)) b.reveal(id, 'ghost');
      if (from) b.edge(from, id, 'flow', 'ghost');
      if (to) b.edge(id, to, 'flow', 'ghost');
    };
    ghost('controller', 'telemetry');
    ghost('tooldoc', 'controller'); ghost('infradoc', 'controller');
    if (twin) { ghost('shadow'); b.edge('tooldoc', 'shadow', 'flow', 'ghost'); b.edge('infradoc', 'shadow', 'flow', 'ghost'); }
    ghost('policy', twin ? 'shadow' : undefined); ghost('act', 'policy'); ghost('verify', 'act');
    if (!twin) { b.edge(b.nodes.get('infradoc')!.state === 'ghost' ? 'tooldoc' : 'infradoc', 'policy', 'flow', 'ghost'); }
    for (const id of INFRA) if (twin || id === 'gpu' || id === 'network') ghost(id, 'serving', 'telemetry');
  }
  // Order: modules first appear in event order; edges sort with them.
  const nodes = [...b.nodes.values()].sort((x, y) => x.order - y.order);
  const edges = [...b.edges.values()].filter((e) => b.nodes.has(e.from) && b.nodes.has(e.to)).sort((x, y) => x.order - y.order);
  return { nodes, edges, current: b.current, touching: b.touching };
}

/** Short, verb-first label of the active module, for the panel header. */
export function nowDoing(m: ArchModel): string | null {
  if (!m.current) return null;
  const n = m.nodes.find((x) => x.id === m.current);
  return n ? `${n.title}${n.verb ? ` · ${n.verb}` : ''}` : null;
}
