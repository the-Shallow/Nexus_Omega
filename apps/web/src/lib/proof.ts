// The certificate view model. Twin certificates and recorded fleet runs are shaped
// differently; both are reduced to the same Proof so the overlay shows one layout.
// Every value comes from the record; anything missing is shown as missing.
import { api } from './api';
import { describeEvidence, modelName, utc } from './flow';
import { dur, ms as msTxt, pct } from './format';
import type { CertificateSummary, Kpi, RecordingDetail, Terminal, Topology } from './types';

export interface SloRow { metric: string; before: string; after: string; limit?: string; ok: boolean | null; note?: string }
export interface Proof {
  id: string;
  kind: 'twin' | 'fleet';
  title: string;
  target: string | null;
  failureType: string | null;
  knownIssue: string | null;
  terminal: Terminal;
  reason: string;
  data: string;
  controller: string;
  controllerReal: boolean;
  stats: { k: string; v: string; sub?: string; tone?: 'warn' | 'ok' }[];
  slo: SloRow[];
  sloNote: string;
  checks: { name: string; passed: boolean; detail: string }[];
  actions: string[];
  evidence: { id: string; finding: string }[];
  summary: string | null;
  footer: { label: string; value: string };
  jsonUrl: string;
  pdfUrl: string;
  prediction: { points: [number, number, number][]; mae: number; samples: number } | null;
}

const fmtKpi = {
  ttft: (k?: Kpi | null) => (k?.ttft_p95 != null ? msTxt(k.ttft_p95) : '–'),
  err: (k?: Kpi | null) => (k ? pct(k.error_rate, 2) : '–'),
  canary: (k?: Kpi | null) => (k ? pct(k.canary, 0) : '–'),
  cap: (k?: Kpi | null) => (k ? pct(k.capacity, 0) : '–'),
};

export function proofFromTwin(s: CertificateSummary, slo: Topology['slo'] | null): Proof {
  const c = s.certificate;
  const v = c.verification;
  const b = v?.before, a = v?.after;
  const limit = slo ?? { ttft_p95_s: 1, tpot_p95_s: 0.025, error_rate: 0.01 };
  return {
    id: c.certificate_id,
    kind: 'twin',
    title: c.incident.title ?? 'Incident',
    target: c.incident.target ?? (c.incident.targets?.join(', ') || null),
    failureType: c.incident.incident_class ?? null,
    knownIssue: c.incident.candidate_id ?? null,
    terminal: c.terminal_state,
    reason: c.terminal_reason,
    data: 'Simulated · SimPy digital twin',
    controller: c.controller,
    controllerReal: false,
    stats: [
      { k: 'Time to detect', v: dur(c.timeline.time_to_detect_s), sub: c.timeline.detected_clock },
      { k: 'Time to close', v: dur(c.timeline.time_to_recover_s), sub: c.timeline.closed_clock },
      { k: 'Dashboards alerted', v: c.dashboards_alerted ? 'Yes' : 'Never', sub: c.dashboards_alerted ? 'SLO breached in the window' : 'silent to monitoring', tone: c.dashboards_alerted ? undefined : 'warn' },
      { k: 'Tool calls', v: String(c.tool_calls.length), sub: `${new Set(c.tool_calls.map((t) => t.tool)).size} distinct tools` },
    ],
    slo: v ? [
      { metric: 'TTFT p95', before: fmtKpi.ttft(b), after: fmtKpi.ttft(a), limit: `≤ ${limit.ttft_p95_s} s`, ok: a?.ttft_p95 != null ? a.ttft_p95 <= limit.ttft_p95_s : null },
      { metric: 'Error rate', before: fmtKpi.err(b), after: fmtKpi.err(a), limit: `≤ ${pct(limit.error_rate, 0)}`, ok: a ? a.error_rate <= limit.error_rate : null },
      { metric: 'Tool-call canary', before: fmtKpi.canary(b), after: fmtKpi.canary(a), limit: '100%', ok: a ? a.canary >= 0.999 : null },
      { metric: 'Capacity', before: fmtKpi.cap(b), after: fmtKpi.cap(a), ok: a ? a.capacity >= 0.999 : null },
    ] : [],
    sloNote: v ? 'Measured in the simulated twin before the repair and at verification.' : 'The run ended before verification. Nothing was claimed as repaired.',
    checks: v?.checks ?? [],
    actions: [
      ...(c.repair.label ? [c.repair.label] : []),
      ...c.repair.actions.map((x) => `${x.kind}(${Object.entries(x.args ?? {}).map(([k, val]) => `${k}=${typeof val === 'string' ? val : JSON.stringify(val)}`).join(', ')})`),
      ...(c.repair.rollback_token ? [`rollback token ${c.repair.rollback_token}${c.repair.rollback_exercised ? ' · exercised' : ''}`] : []),
    ],
    evidence: c.evidence.slice(0, 5).map((e) => ({ id: e.evidence_id, finding: e.finding })),
    summary: c.diagnosis?.summary ?? null,
    footer: { label: 'sha256', value: c.sha256 },
    jsonUrl: api.certificateUrl(c.certificate_id),
    pdfUrl: api.certificatePdfUrl(c.certificate_id),
    prediction: c.prediction_vs_actual ? { points: c.prediction_vs_actual.points, mae: c.prediction_vs_actual.mae_s, samples: c.prediction_vs_actual.samples } : null,
  };
}

export function proofFromFleet(rec: RecordingDetail): Proof {
  const s = rec.summary;
  const ep = rec.episode;
  const v = ep?.verification;
  const x = ep?.executor;
  // Detection-time numbers: the monitoring snapshot the agent started from.
  const docs = rec.evidence_index.map((r) => rec.evidence[r.evidence_id]).filter(Boolean);
  const routeDoc = docs.find((d: any) => d?.content?.data?.probe_id === 'route-probe');
  const route0: Record<string, any> = routeDoc?.content?.data?.workers ?? {};
  const maxP95: number | undefined = routeDoc?.content?.data?.limits?.max_p95_s;
  const canary0 = docs.find((d: any) => d?.content?.data?.probe_id?.startsWith('tool-call') && d.content.data.resource_id === s.target);
  const workerKeys = Array.from(new Set([...Object.keys(route0), ...Object.keys(v?.route ?? {}).map((k) => (k.length === 1 ? `target-${k}` : k))])).sort();
  const after = (k: string) => v?.route?.[k] ?? v?.route?.[k.replace('target-', '')];
  const slo: SloRow[] = workerKeys.flatMap((k) => {
    const b0 = route0[k], a0 = after(k);
    return [
      { metric: `${k} · p95 latency`, before: b0 ? msTxt(b0.p95_s) : '–', after: a0 ? msTxt(a0.p95_s) : '–', limit: maxP95 != null ? `≤ ${msTxt(maxP95)}` : undefined, ok: a0 ? (maxP95 != null ? a0.p95_s <= maxP95 : a0.ok) : null },
      { metric: `${k} · errors`, before: b0 ? pct(b0.error_rate, 1) : '–', after: a0 ? pct(a0.error_rate, 1) : '–', limit: '0%', ok: a0 ? a0.error_rate === 0 : null },
    ];
  });
  if (s.target) {
    const c0 = canary0?.content?.data;
    slo.push({
      metric: `${s.target} · tool calls`,
      before: c0 ? `${c0.structured_tool_call_count} structured · HTTP ${c0.http_status}` : '–',
      after: v ? (v.hidden_passed ? 'hidden canary passed' : 'hidden canary failed') : '–',
      ok: v ? v.hidden_passed : null,
    });
  }
  const plan = ep?.decision?.repair_plan?.action?.arguments ?? rec.events.find((e) => e.event_type === 'decision_validated')?.payload?.repair_plan?.action?.arguments;
  const policy = rec.events.find((e) => e.event_type === 'repair_plan_evaluated')?.payload?.policy;
  const agentSecs = (Date.parse(s.agent_ended_at) - Date.parse(s.started_at)) / 1000;
  return {
    id: s.id,
    kind: 'fleet',
    title: s.title,
    target: s.target,
    failureType: s.fault,
    knownIssue: s.fault?.toUpperCase() ?? null,
    terminal: s.terminal_state ?? 'ABSTAIN',
    reason: s.success
      ? "The executor's hidden canary verified the repair, and the independent referee confirmed users were served and the root cause was fixed."
      : s.failure ? `Agent run failed: ${s.failure}` : 'The referee did not confirm a repair.',
    data: `Recorded on the real fleet · ${s.environment ?? 'Brev'}`,
    controller: modelName(s.controller),
    controllerReal: true,
    stats: [
      { k: 'Diagnosis', v: `${agentSecs.toFixed(1)} s`, sub: `${s.tool_calls} tool calls · ${s.evidence_count} evidence` },
      { k: 'Repair', v: x ? `${x.seconds.toFixed(1)} s` : '–', sub: x ? `executor · ${x.status}` : 'not executed' },
      { k: 'Solve time', v: s.solve_seconds != null ? `${s.solve_seconds.toFixed(1)} s` : '–', sub: 'referee-timed episode' },
      { k: 'Recorded', v: utc(s.started_at), sub: `${s.started_at.slice(0, 10)} UTC` },
    ],
    slo,
    sloNote: 'Before: the monitoring snapshot the agent started from. After: the referee\'s probe through HAProxy once the run closed.',
    checks: v ? [
      { name: 'Users served through HAProxy', passed: v.users_ok, detail: Object.entries(v.route ?? {}).map(([k, r]) => `${k}: ${msTxt(r.p95_s)} p95`).join(' · ') },
      { name: 'Hidden tool-call canary through HAProxy', passed: v.hidden_passed, detail: 'held-out cases' },
      { name: 'Root cause fixed', passed: v.root_fixed, detail: `hidden canary on ${s.target ?? 'the faulty worker'}` },
      { name: x ? 'Repaired worker back in rotation' : 'Faulty worker not left drained', passed: !v.faulty_worker_drained, detail: v.faulty_worker_drained ? 'still drained' : 'serving' },
      { name: 'No false VERIFIED claim', passed: s.false_verified === false, detail: s.success ? 'referee scored a success' : 'referee scored a failure' },
      ...(x?.verification ? [{ name: "Executor's canary", passed: x.verification.passed, detail: `health ${x.verification.health_status} · ${x.verification.failed_cases.length} failed cases` }] : []),
    ] : [],
    actions: [
      ...(plan ? [`Nemotron proposed ${plan.action_id}(${Object.entries(plan.parameters ?? {}).map(([k, val]) => `${k}=${val}`).join(', ')}) on ${plan.target}`] : []),
      ...(policy ? [`Policy ${policy.status}: ${policy.reason}`] : []),
      ...(x ? [`Executor applied ${x.profile ?? x.action} to ${x.service} → ${x.status} in ${x.seconds.toFixed(1)} s`] : []),
      ...(s.failure ? [`No change made: ${s.failure}`] : []),
    ],
    evidence: rec.evidence_index.slice(0, 6).map((e) => {
      const read = describeEvidence(rec.evidence[e.evidence_id]);
      return { id: e.evidence_id, finding: read ? `${read.title}: ${read.detail}` : e.finding };
    }),
    summary: s.summary,
    footer: { label: 'source', value: `evidence/agent/runs/${s.id}` },
    jsonUrl: api.recordingJsonUrl(s.id),
    pdfUrl: api.recordingPdfUrl(s.id),
    prediction: null,
  };
}
