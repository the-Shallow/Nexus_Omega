// One workflow model for every source. The recovery column renders a FlowRun and
// does not care whether it came from the twin's doctors (simulated) or from a
// recorded Nemotron run on the real fleet. Stages, items and times are derived
// from that source's own events, and a stage exists only once its first event does.
//
//   Detect        the signal and the first confirming observations
//   Diagnose      the controller's first reasoning turn
//   Select Tools  targeted tools that confirm or kill the leading suspect
//   Shadow Test   candidate repairs raced in a fork of the twin (twin runs only)
//   Act           one approved, reversible change set
//   Verify        checks the controller does not grade itself
//   Certificate   the terminal state, whatever it is
//
// Stages only move forward: a later DIAGNOSE pass is shown where it happens.
import { argList } from './format';
import type { AgentEvent, Candidate, DoctorSnapshot, RecordingDetail, RunEvent, Terminal, ToolCallRecord } from './types';

export type StageKey = 'detect' | 'diagnose' | 'tools' | 'shadow' | 'act' | 'verify' | 'certificate';
export type StageStatus = 'active' | 'done' | 'waiting' | 'failed' | 'halted';
export type Tone = 'ok' | 'bad' | 'warn' | 'muted' | 'info';

export interface FlowItem {
  id: string;
  kind: 'signal' | 'tool' | 'evidence' | 'hypothesis' | 'policy' | 'candidate' | 'action' | 'check' | 'note';
  at: string;
  title: string;
  detail?: string;
  reason?: string;
  /** What a tool returned, in one line. */
  result?: string;
  tone?: Tone;
  payload?: unknown;
  /** The tool that was called (tool items) or the action that was applied (action items). */
  tool?: string;
  /** The resource it read or changed, as the backend names it (vllm-1, A4-n2, B3, CRAH-1, target-b). */
  target?: string | null;
}

export interface FlowStage {
  key: StageKey;
  label: string;
  status: StageStatus;
  headline: string;
  at: string;
  items: FlowItem[];
  candidates?: Candidate[];
  chosen?: string | null;
  headlineSeverity?: number;
}

export interface FlowRun {
  key: string;
  source: 'twin' | 'fleet';
  title: string;
  target: string | null;
  doctor: 'tool' | 'infra';
  controller: string;
  controllerReal: boolean;
  startedAt: string;
  stages: FlowStage[];
  terminal: Terminal | null;
  reason: string;
  awaitingApproval: boolean;
  approval: { runId: string; label: string; candidate: Candidate | null } | null;
  certificate: { kind: 'twin' | 'fleet'; id: string } | null;
  counts: { tools: number; evidence: number };
  /** How the outcome should read: the terminal state, corrected by the referee where it disagrees. */
  verdict: { label: string; tone: Tone } | null;
}

export const LABEL: Record<StageKey, string> = {
  detect: 'Detect', diagnose: 'Diagnose', tools: 'Select Tools', shadow: 'Shadow Test', act: 'Act', verify: 'Verify', certificate: 'Certificate',
};
const ORDER: StageKey[] = ['detect', 'diagnose', 'tools', 'shadow', 'act', 'verify', 'certificate'];
const later = (a: StageKey, b: StageKey | undefined) => !b || ORDER.indexOf(a) > ORDER.indexOf(b);

export const OUTCOME: Record<Terminal, { label: string; short: string; tone: Tone; line: string }> = {
  VERIFIED: { label: 'Verified recovery', short: 'Verified', tone: 'ok', line: 'Independent checks passed' },
  ROLLED_BACK: { label: 'Rolled back', short: 'Rolled back', tone: 'bad', line: 'Verification failed; changes restored' },
  REQUIRES_APPROVAL: { label: 'Needs a human', short: 'Needs approval', tone: 'warn', line: 'Outside what software can fix alone' },
  ABSTAIN: { label: 'Abstained', short: 'Abstained', tone: 'muted', line: 'No safe repair was found or proven' },
};

/** REQUIRES_APPROVAL after VERIFY can mean "service verified, facility needs a human". */
export const serviceVerified = (reason: string) => reason.startsWith('service verified');

function headline(item: FlowItem): string {
  if (item.kind === 'tool') return `${item.title}(${item.detail ?? ''})`;
  return item.detail && item.kind !== 'evidence' && item.kind !== 'note' ? `${item.title} · ${item.detail}` : item.title;
}

const severity = (t?: Tone) => (t === 'bad' ? 2 : t === 'warn' ? 1 : 0);

/** Adds an item; the headline follows the latest item, except that asides never take it and
 *  Detect keeps showing the worst signal it has seen. */
function push(stage: FlowStage, item: FlowItem) {
  stage.items.push(item);
  if (item.tone === 'muted') return;
  if (stage.key === 'detect' && severity(item.tone) < (stage.headlineSeverity ?? 0)) return;
  stage.headline = headline(item);
  stage.headlineSeverity = severity(item.tone);
}

// ------------------------------------------------------------------ twin

const TWIN_STAGE: Record<string, StageKey | undefined> = {
  INGEST: 'detect', DIAGNOSE: 'diagnose', EXPAND_CONTEXT: 'tools', PLAN: 'shadow', PRECHECK: 'shadow', ACT: 'act', VERIFY: 'verify',
};

function twinItem(e: RunEvent): FlowItem | null {
  const id = `e${e.seq}`;
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'state':
      return d.note ? { id, kind: 'note', at: e.clock, title: d.note } : null;
    case 'tool_call': {
      const c = d as ToolCallRecord;
      const a = (c.arguments ?? {}) as Record<string, unknown>;
      return {
        id, kind: 'tool', at: e.clock, title: c.tool, detail: argList(c.arguments ?? {}), reason: c.reason,
        tone: c.status === 'ok' ? 'ok' : 'bad', payload: c.status === 'ok' ? c.result : { error: c.error_code, message: c.error },
        tool: c.tool, target: String(a.service ?? a.node ?? a.rack ?? '') || null,
      };
    }
    case 'evidence':
      return { id, kind: 'evidence', at: e.clock, title: e.title, detail: d.evidence_id, payload: d.data ?? undefined };
    case 'policy':
      return { id, kind: 'policy', at: e.clock, title: e.title, detail: d.reason, tone: d.decision === 'rejected' ? 'bad' : 'ok' };
    case 'precheck':
      return { id, kind: 'candidate', at: e.clock, title: e.title, detail: 'predicted · simulated' };
    case 'approval':
      return { id, kind: 'policy', at: e.clock, title: e.title, tone: 'warn' };
    case 'action': {
      const args = (d.args ?? {}) as Record<string, unknown>;
      const workers = Array.isArray(args.workers) ? (args.workers as string[]).join(', ') : null;
      return {
        id, kind: 'action', at: e.clock, title: e.title, detail: d.token ? `token ${d.token}` : undefined, tone: e.title.startsWith('rollback') ? 'warn' : 'info', payload: d,
        tool: e.title.startsWith('rollback') ? 'rollback' : d.kind, target: String(args.worker ?? args.node ?? args.scope ?? workers ?? '') || null,
      };
    }
    case 'verify': {
      const checks: { passed: boolean }[] = d.checks ?? [];
      return { id, kind: 'check', at: e.clock, title: e.title, tone: checks.every((c) => c.passed) ? 'ok' : 'bad', payload: d.checks };
    }
    case 'terminal':
    case 'certificate':
      return null;
    default:
      return { id, kind: 'note', at: e.clock, title: e.title };
  }
}

export function fromTwin(run: DoctorSnapshot): FlowRun {
  const stages: FlowStage[] = [];
  for (const e of run.events) {
    const key = TWIN_STAGE[e.state];
    if (key && later(key, stages[stages.length - 1]?.key)) stages.push({ key, label: LABEL[key], status: 'done', headline: '', at: e.clock, items: [] });
    const stage = stages[stages.length - 1];
    const item = stage && twinItem(e);
    if (item) push(stage, item);
  }
  const shadow = stages.find((s) => s.key === 'shadow');
  if (shadow && run.precheck) { shadow.candidates = run.precheck.candidates; shadow.chosen = run.chosen; }

  const last = stages[stages.length - 1];
  if (last) {
    if (!run.terminal) last.status = run.awaiting_approval ? 'waiting' : 'active';
    else if (run.terminal === 'VERIFIED') last.status = 'done';
    else if (run.terminal === 'ROLLED_BACK') last.status = 'failed';
    else if (run.terminal === 'REQUIRES_APPROVAL' && last.key === 'verify' && serviceVerified(run.terminal_reason)) last.status = 'done';
    else last.status = 'halted';
  }
  if (run.terminal) {
    const closed = run.states[run.states.length - 1];
    stages.push({
      key: 'certificate', label: LABEL.certificate, at: closed?.clock ?? '', items: [],
      status: run.terminal === 'VERIFIED' ? 'done' : run.terminal === 'ROLLED_BACK' ? 'failed' : 'halted',
      headline: run.terminal_reason,
    });
  }
  const rec = run.precheck?.candidates.find((c) => c.id === run.precheck?.recommended) ?? null;
  const target = run.incident.target ?? (run.incident.targets?.length ? run.incident.targets.join(', ') : null);
  return {
    key: `twin:${run.id}`,
    source: 'twin',
    title: run.incident.title ?? run.title,
    target,
    doctor: run.doctor,
    controller: run.controller,
    controllerReal: false,
    startedAt: run.states[0]?.clock ?? '',
    stages,
    terminal: run.terminal,
    reason: run.terminal_reason,
    awaitingApproval: run.awaiting_approval,
    approval: run.awaiting_approval ? { runId: run.id, label: rec?.label ?? 'the recommended repair', candidate: rec } : null,
    certificate: run.certificate_id ? { kind: 'twin', id: run.certificate_id } : null,
    counts: { tools: run.usage.tool_calls, evidence: run.ledger.length },
    verdict: run.terminal ? { label: run.terminal.replace('_', ' '), tone: OUTCOME[run.terminal].tone } : null,
  };
}

// ------------------------------------------------------------------ real fleet

export const ms = (iso: string) => Date.parse(iso);
export const utc = (iso: string | number) => new Date(iso).toISOString().slice(11, 19);
const pctTxt = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 2 : 0)}%`;
const msTxt = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);

/** "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4" → "Nemotron 3.5 Lightning". */
export function modelName(id: string): string {
  const m = /Nemotron-([\d.]+)-([A-Za-z]+)/.exec(id);
  return m ? `Nemotron ${m[1]} ${m[2]}` : id.split('/').pop() ?? id;
}

/** Plain-language reading of one recorded evidence document. */
export function describeEvidence(doc: any): { title: string; detail: string; tone: Tone } | null {
  const c = doc?.content;
  const data = c?.data;
  if (data?.probe_id === 'route-probe') {
    const ws = Object.entries<any>(data.workers ?? {});
    const err = Math.max(0, ...ws.map(([, w]) => w.error_rate ?? 0));
    return {
      title: 'Route probe through HAProxy',
      detail: `${ws.map(([k, w]) => `${k} p95 ${msTxt(w.p95_s)}`).join(' · ')} · ${pctTxt(err)} errors`,
      tone: ws.every(([, w]) => w.ok) ? 'ok' : 'bad',
    };
  }
  if (data?.probe_id?.startsWith('tool-call')) {
    const ok = (data.structured_tool_call_count ?? 0) > 0;
    return { title: `Tool-call canary · ${data.resource_id}`, detail: `${data.verdict} · HTTP ${data.http_status}`, tone: ok ? 'ok' : 'bad' };
  }
  if (c?.configuration) {
    const cfg = c.configuration;
    const down = cfg.container_state && cfg.container_state !== 'running';
    return { title: `Configuration · ${c.resource_id}`, detail: `parser ${cfg.tool_call_parser ?? '–'} · template ${cfg.chat_template ?? '–'}${down ? ` · container ${cfg.container_state}` : ''}`, tone: down ? 'bad' : 'info' };
  }
  if (c?.metric) {
    const v = typeof c.value === 'number' ? (c.unit === 'fraction' ? pctTxt(c.value) : c.unit === 'seconds' ? msTxt(c.value) : String(c.value)) : '–';
    return { title: `Metric · ${c.resource_id}`, detail: `${c.metric} ${v}${c.window ? ` over ${c.window}` : ''}`, tone: 'info' };
  }
  if (c?.state || doc?.source_type === 'resource_state') {
    const st = c?.state ?? c;
    const fields = Object.entries<any>(st?.fields ?? st ?? {}).filter(([k]) => k !== 'resource_id' && k !== 'source').slice(0, 4);
    const down = st?.container_state && st.container_state !== 'running';
    return { title: `State · ${c?.resource_id ?? ''}`, detail: fields.map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || 'collected', tone: down ? 'bad' : 'info' };
  }
  if (doc?.source_type === 'environment_manifest') {
    const n = (k: string) => (Array.isArray(c?.[k]) ? c[k].length : 0);
    return { title: 'Environment manifest', detail: `${n('resources')} resources · ${n('probes')} probes · ${n('actions')} actions`, tone: 'info' };
  }
  return null;
}

/** Arguments the controller passed, without its bookkeeping fields. */
function opArgs(args: Record<string, unknown>): string {
  const skip = new Set(['reason', 'expected_information_gain', 'hypothesis_id']);
  return argList(Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => !skip.has(k))));
}

export interface FleetEntry { t: number; stage?: StageKey; item?: FlowItem; end?: 'failed' | 'terminal'; focus?: string | null; phase?: FleetPhase; headline?: string }
export type FleetPhase = 'detect' | 'investigate' | 'plan' | 'repair' | 'verify' | 'done' | 'failed';

const timelines = new WeakMap<RecordingDetail, FleetEntry[]>();

/** Every moment of a recorded run, in recorded time. Built once per recording. */
export function fleetTimeline(rec: RecordingDetail): FleetEntry[] {
  const cached = timelines.get(rec);
  if (cached) return cached;
  const out: FleetEntry[] = [];
  const ev = [...rec.events].sort((a, b) => a.sequence - b.sequence);
  let diagnosing = false, tooling = false, acting = false, lastT = 0;
  const pendingCall = new Map<string, { tool: string; args: string; reason?: string; target: string | null }>();
  const item = (e: AgentEvent, i: Omit<FlowItem, 'id' | 'at'>): FlowItem => ({ id: `s${e.sequence}`, at: utc(e.timestamp), ...i });

  for (const e of ev) {
    const t = ms(e.timestamp);
    lastT = t;
    const p = e.payload ?? {};
    switch (e.event_type) {
      case 'run_started':
        out.push({ t, stage: 'detect', phase: 'detect', item: item(e, { kind: 'signal', title: 'Monitoring snapshot', detail: p.trigger?.summary ? 'route probe + visible tool-call canaries' : undefined, reason: p.trigger?.summary }) });
        break;
      case 'evidence_recorded': {
        const id = p.evidence?.evidence_id;
        const doc = rec.evidence[id] ?? { content: null, source_type: p.evidence?.source_type };
        const read = describeEvidence({ ...doc, source_type: doc.source_type ?? p.evidence?.source_type });
        const call = p.call_id ? pendingCall.get(p.call_id) : undefined;
        if (call) {
          out.push({ t, focus: doc?.content?.resource_id ?? '@env', item: item(e, { kind: 'tool', title: call.tool, detail: call.args, result: read ? `${read.title}: ${read.detail}` : p.evidence?.finding, tone: 'ok', payload: { evidence_id: id, result: doc?.content }, tool: call.tool, target: call.target }) });
        } else {
          out.push({ t, item: item(e, { kind: 'evidence', title: read?.title ?? p.evidence?.finding ?? id, detail: read?.detail, tone: read?.tone, payload: doc?.content }) });
        }
        break;
      }
      case 'model_turn_validated': {
        const calls: { name: string; arguments: Record<string, unknown> }[] = p.tool_calls ?? [];
        const stage: StageKey | undefined = diagnosing ? undefined : 'diagnose';
        diagnosing = true;
        if (!calls.length) {
          out.push({ t, stage, phase: 'investigate', item: item(e, { kind: 'note', title: 'Nemotron wrote its conclusion' }) });
          break;
        }
        for (const c of calls) {
          if (c.name === 'apply_action') continue; // shown as the plan below
          out.push({ t, stage, phase: 'investigate', item: item(e, { kind: 'hypothesis', title: `Nemotron chose ${c.name}`, detail: opArgs(c.arguments), reason: String(c.arguments?.reason ?? '') || undefined }) });
        }
        break;
      }
      case 'context_requested': {
        pendingCall.set(p.call_id, { tool: p.tool, args: argList(p.operational_arguments ?? {}), reason: p.reason, target: p.operational_arguments?.resource_id ?? null });
        if (!tooling && p.tool !== 'describe_environment') {
          tooling = true;
          out.push({ t, stage: 'tools', phase: 'investigate', focus: p.operational_arguments?.resource_id ?? '@env' });
        } else out.push({ t, focus: p.operational_arguments?.resource_id ?? '@env' });
        break;
      }
      case 'repair_tool_call_redirected':
        out.push({ t, item: item(e, { kind: 'note', title: 'Repair proposed as a tool call; the runtime turned it into a plan (nothing executed)', tone: 'muted' }) });
        break;
      case 'decision_reformat_requested':
        out.push({ t, item: item(e, { kind: 'note', title: 'Final answer failed the decision schema; one guided retry', detail: p.error, tone: 'warn' }) });
        break;
      case 'decision_reformatted':
        out.push({ t, item: item(e, { kind: 'note', title: 'Retry produced a valid decision', tone: 'ok' }) });
        break;
      case 'decision_validated': {
        const plan = p.repair_plan;
        const top = (p.hypotheses ?? [])[0];
        if (plan) {
          acting = true;
          const a = plan.action?.arguments ?? {};
          out.push({ t, stage: 'act', phase: 'plan', focus: a.target ?? null, item: item(e, { kind: 'action', title: `Plan · ${a.action_id ?? plan.action?.tool}`, detail: `${argList(a.parameters ?? {})} → ${a.target ?? '?'}`, reason: plan.expected_effect, tone: 'info', payload: plan, tool: 'plan', target: a.target ?? null }) });
          if (top) out.push({ t, item: item(e, { kind: 'hypothesis', title: `Hypothesis ${top.id}`, detail: `confidence ${pctTxt(top.confidence)} · cites ${(top.supports ?? []).join(', ') || 'nothing'}` }) });
        } else {
          out.push({ t, item: item(e, { kind: 'note', title: p.summary ?? 'Decision recorded', tone: 'muted' }) });
        }
        break;
      }
      case 'repair_plan_evaluated': {
        const pol = p.policy ?? {};
        out.push({ t, item: item(e, { kind: 'policy', title: `Policy ${pol.status ?? '?'}`, detail: pol.reason, tone: pol.status === 'APPROVED' ? 'ok' : 'bad', payload: p.approval }) });
        break;
      }
      case 'before_state_captured': {
        const cfg = p.before_state?.configuration ?? {};
        out.push({ t, item: item(e, { kind: 'action', title: 'Before-state captured', detail: `parser ${cfg.tool_call_parser ?? '–'} · template ${cfg.chat_template ?? '–'} · rollback ${p.rollback_token ?? '–'}`, tone: 'info', payload: p.before_state }) });
        break;
      }
      case 'run_completed':
        out.push({ t, item: item(e, { kind: 'note', title: `Agent done: ${p.tool_calls ?? '?'} tool calls, ${p.context_rounds ?? '?'} context rounds; plan handed to the executor` }) });
        break;
      case 'run_failed':
        out.push({ t, end: 'failed', phase: 'failed', item: item(e, { kind: 'note', title: 'Agent run failed', detail: `${p.error_type}: ${p.message}`, tone: 'bad' }) });
        break;
      default:
        break;
    }
  }

  const ep = rec.episode;
  const x = ep?.executor;
  if (x) {
    const start = Math.max(ms(x.started_at), lastT + 150);
    const end = Math.max(ms(x.ended_at), start + 1000);
    const drain = x.action === 'drain_worker';
    if (!acting) out.push({ t: start, stage: 'act' });
    out.push({ t: start, phase: 'repair', focus: x.service, item: { id: 'x-start', at: utc(start), kind: 'action', title: `Executor · ${x.action} on ${x.service}`, detail: PROTOCOL[x.action]?.(x.profile) ?? 'one approved change, with a rollback path', tone: 'info', payload: x.before ?? x, tool: x.action, target: x.service } });
    out.push({
      t: end, stage: 'verify', phase: 'verify',
      item: drain
        ? { id: 'x-end', at: utc(end), kind: 'action', title: `Drain ${x.status === 'APPLIED' ? 'applied' : x.status.toLowerCase()}`, detail: `${x.service} out of rotation after ${x.seconds.toFixed(1)} s; the link itself needs a human`, tone: x.status === 'APPLIED' ? 'info' : 'bad', payload: x }
        : { id: 'x-end', at: utc(end), kind: 'check', tool: 'executor_canary', target: x.service, title: `Executor's canary ${x.verification?.passed ? 'passed' : 'failed'}`, detail: `${x.status} after ${x.seconds.toFixed(1)} s · health ${x.verification?.health_status ?? '–'} · ${(x.verification?.failed_cases ?? []).length} failed cases`, tone: x.verification?.passed ? 'ok' : 'bad', payload: x.verification },
    });
    lastT = end;
  }
  if (ep) {
    const at = Math.max(ms(ep.at), lastT + 300);
    if (!x) out.push({ t: at, stage: 'verify', phase: 'verify' });
    const checks = refereeChecks(rec);
    checks.forEach((c, i) => out.push({ t: at + i * 140, item: { id: `ref-${i}`, at: utc(at), kind: 'check', tool: 'referee', title: c.name, detail: c.detail || (c.passed ? 'pass' : 'fail'), tone: c.passed ? 'ok' : 'bad' } }));
    if (checks.length) out.push({ t: at + checks.length * 140, headline: `Referee: ${checks.filter((c) => c.passed).length}/${checks.length} checks passed` });
    out.push({ t: at + 900, end: 'terminal', phase: 'done' });
  }
  out.sort((a, b) => a.t - b.t);
  timelines.set(rec, out);
  return out;
}

/** What the executor does for each action it is allowed to run. */
const PROTOCOL: Record<string, (profile?: string) => string> = {
  patch_serving_config: (profile) => `drain → apply ${profile ?? 'the reviewed profile'} → hidden canary → undrain`,
  restart_worker: () => 'drain → restart → hidden canary → undrain',
  drain_worker: () => 'drain: traffic moves to the healthy worker',
};

const alias = (k: string) => (k.length === 1 ? `target-${k}` : k);

/** The referee's checks for a recorded episode, scored the way the referee scores that fault:
 *  workers it expects fixed, and links it expects drained for a human. */
export function refereeChecks(rec: RecordingDetail): { name: string; passed: boolean; detail: string }[] {
  const s = rec.summary, ep = rec.episode, v = ep?.verification;
  if (!v) return [];
  const fix = s.remedy?.fix ?? [], drain = s.remedy?.drain ?? [];
  const out = [
    { name: 'Users served through HAProxy', passed: v.users_ok, detail: Object.entries(v.route ?? {}).map(([k, r]) => `${alias(k)} p95 ${msTxt(r.p95_s)} · ${pctTxt(r.error_rate)} err`).join(' · ') },
    { name: 'Hidden tool-call canary through HAProxy', passed: v.hidden_passed, detail: 'held-out cases' },
  ];
  if (v.root && Object.keys(v.root).length) {
    for (const [w, ok] of Object.entries(v.root)) out.push({ name: `Root cause fixed on ${alias(w)}`, passed: ok, detail: 'hidden canary on that worker' });
  } else if (fix.length || !s.remedy) {
    out.push({ name: 'Root cause fixed', passed: v.root_fixed, detail: `hidden canary on ${fix.join(', ') || 'the faulty worker'}` });
  }
  if (drain.length) {
    out.push({ name: `${drain.join(', ')} drained for a human`, passed: v.faulty_worker_drained, detail: 'a degraded link is never fixed by software' });
    out.push({ name: 'Escalated to a human', passed: s.terminal_state === 'REQUIRES_APPROVAL', detail: `terminal state ${s.terminal_state ?? '–'}` });
  } else {
    const back = v.drained_now && fix.length ? !fix.some((w) => v.drained_now!.includes(w.replace('target-', ''))) : !v.faulty_worker_drained;
    out.push({ name: ep?.executor ? 'Repaired worker back in rotation' : 'Faulty worker not left drained', passed: back, detail: back ? 'serving' : 'left drained' });
  }
  if (typeof s.false_verified === 'boolean') out.push({ name: 'No false VERIFIED claim', passed: !s.false_verified, detail: s.success ? 'referee scored a success' : 'referee scored a failure' });
  return out;
}

/** How a recorded outcome should read once the referee has had its say. */
export function fleetVerdict(s: RecordingDetail['summary']): { label: string; tone: Tone; headline: string; falseVerified: boolean } {
  const t = s.terminal_state;
  if (t === 'VERIFIED' && s.false_verified) return { label: 'FALSE VERIFIED', tone: 'bad', falseVerified: true, headline: 'The executor said VERIFIED; the independent referee found the fault unresolved' };
  if (t === 'VERIFIED') return { label: 'VERIFIED', tone: s.success ? 'ok' : 'warn', falseVerified: false, headline: s.success ? 'Referee confirmed users served and the root cause fixed' : 'Verified by the executor; the referee did not score a success' };
  if (t === 'REQUIRES_APPROVAL') {
    const drained = s.remedy?.drain?.join(', ');
    return { label: 'REQUIRES APPROVAL', tone: s.success ? 'warn' : 'bad', falseVerified: false, headline: s.success ? `Users served; ${drained || 'the faulty worker'} drained and handed to a human` : 'Escalated, but the referee scored a failure' };
  }
  if (t === 'ROLLED_BACK') return { label: 'ROLLED BACK', tone: 'bad', falseVerified: false, headline: 'Verification failed; the change was rolled back' };
  return { label: t ? t.replace('_', ' ') : 'NO VERDICT', tone: 'muted', falseVerified: false, headline: s.failure ? `Agent failed: ${s.failure}` : 'No repair was proposed or proven' };
}

export function fleetBounds(rec: RecordingDetail): { start: number; end: number } {
  const tl = fleetTimeline(rec);
  return { start: (tl[0]?.t ?? 0) - 1500, end: (tl[tl.length - 1]?.t ?? 0) + 600 };
}

export function fromFleet(rec: RecordingDetail, cursor: number): FlowRun {
  const s = rec.summary;
  const stages: FlowStage[] = [];
  let failedAt: StageKey | null = null, ended = false, tools = 0, evidence = 0;
  for (const en of fleetTimeline(rec)) {
    if (en.t > cursor) break;
    if (en.stage && later(en.stage, stages[stages.length - 1]?.key)) stages.push({ key: en.stage, label: LABEL[en.stage], status: 'done', headline: '', at: utc(en.t), items: [] });
    const stage = stages[stages.length - 1];
    if (en.item && stage) {
      push(stage, en.item);
      if (en.item.kind === 'tool') tools++;
      if (en.item.kind === 'tool' || en.item.kind === 'evidence') evidence++;
    }
    if (en.headline && stage) stage.headline = en.headline;
    if (en.end === 'failed') failedAt = stage?.key ?? null;
    if (en.end === 'terminal') ended = true;
  }
  const terminal = ended ? s.terminal_state : null;
  const verdict = fleetVerdict(s);
  for (const st of stages) if (st.key === failedAt) st.status = 'halted';
  const last = stages[stages.length - 1];
  if (last && !ended) last.status = failedAt === last.key ? 'halted' : 'active';
  if (ended && terminal && !s.success) {
    const verify = stages.find((x) => x.key === 'verify');
    if (verify) verify.status = 'failed';
  }
  if (ended && terminal) {
    stages.push({
      key: 'certificate', label: LABEL.certificate, at: s.ended_at ? utc(s.ended_at) : '', items: [],
      status: verdict.tone === 'ok' ? 'done' : verdict.tone === 'bad' ? 'failed' : 'halted',
      headline: verdict.headline,
    });
  }
  return {
    key: `fleet:${s.id}`,
    source: 'fleet',
    title: s.title,
    target: s.target,
    doctor: /vllm|tool/i.test(s.fault ?? '') ? 'tool' : 'infra',
    controller: modelName(s.controller),
    controllerReal: true,
    startedAt: utc(s.started_at),
    stages,
    terminal,
    reason: s.summary ?? s.failure ?? '',
    awaitingApproval: false,
    approval: null,
    certificate: terminal ? { kind: 'fleet', id: s.id } : null,
    counts: { tools, evidence },
    verdict: terminal ? { label: verdict.label, tone: verdict.tone } : null,
  };
}
