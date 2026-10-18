// A recorded agent run, replayed as a story. Everything shown comes from the run's
// trail (`/api/results/runs/{id}`), its opening probes (`…/evidence/{ev}`) and its
// episode record. Nothing is invented: where the data is silent, the tile says so.
import { api } from '../../lib/api';
import type { EpisodeSummary, RealRunSnapshot, RunEvent } from '../../lib/types';
import { STATUS } from '../../twin/palette';
import type { CertRecord } from '../blocks/nexus';
import type { World } from '../world/world';
import type { Beat, Hop, Reality, Snapshot, Story } from './types';

interface RouteWorker { error_rate?: number; p95_s?: number; median_s?: number; ok?: boolean; requests?: number }
interface Probes {
  route: Record<string, RouteWorker>;
  limits: { max_p95_s?: number; max_error_rate?: number };
  canary: Record<string, { count: number | null; verdict: string; status: number | null }>;
}

const WORKERS = ['target-a', 'target-b'];
const short = (w: string) => w.replace('target-', '');
const other = (w: string) => (w === 'target-a' ? 'target-b' : 'target-a');
const pct = (x?: number) => (x === undefined || x === null ? '–' : `${(x * 100).toFixed(x < 0.01 ? 1 : 0)}%`);
const sec = (x?: number | null) => (x === undefined || x === null ? '–' : `${x < 1 ? x.toFixed(2) : x.toFixed(1)} s`);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Fetch everything a replay needs. Throws with a readable message if the run can't be loaded. */
export async function loadRealStory(runId: string): Promise<Story> {
  const snap = await api.run(runId);
  const episodes = await api.episodes({ solver: 'agent' }).catch(() => [] as EpisodeSummary[]);
  const episode = episodes.find((e) => e.run_id === runId) ?? null;
  const probes: Probes = { route: {}, limits: {}, canary: {} };
  // The run opens with the monitoring snapshot the agent was given: a route probe and one canary per worker.
  const opening = snap.events.filter((e) => e.kind === 'evidence' && String(e.detail?.source ?? '').startsWith('probe:')).slice(0, 4);
  await Promise.all(opening.map(async (e) => {
    const ev = await api.runEvidence(runId, e.detail.evidence_id).catch(() => null);
    const data = ev?.content?.data;
    if (!data) return;
    if (data.probe_id === 'route-probe') { probes.route = data.workers ?? {}; probes.limits = data.limits ?? {}; }
    if (data.probe_id === 'tool-call-visible' && data.resource_id) {
      probes.canary[data.resource_id] = { count: data.structured_tool_call_count ?? null, verdict: data.verdict ?? '', status: data.http_status ?? null };
    }
  }));
  return buildRealStory(snap, probes, episode);
}

type Look = 'ok' | 'silent' | 'bad';

/** How each worker looked at the start, from the opening probes alone. */
function openingLooks(p: Probes): Record<string, Look> {
  const looks: Record<string, Look> = {};
  for (const w of WORKERS) {
    const r = p.route[w], c = p.canary[w];
    if (r && r.ok === false) looks[w] = 'bad';
    else if (c && c.count === 0) looks[w] = 'silent';
    else looks[w] = 'ok';
  }
  return looks;
}

function argText(args: Record<string, unknown> | undefined) {
  if (!args || !Object.keys(args).length) return '';
  return cut(Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '), 90);
}

function probeLine(w: string, p: Probes) {
  const r = p.route[w], c = p.canary[w];
  const parts = [];
  if (r) parts.push(`p95 ${sec(r.p95_s)} · errors ${pct(r.error_rate)}`);
  if (c) parts.push(`canary ${c.count ?? '?'} tool call${c.count === 1 ? '' : 's'} (HTTP ${c.status ?? '?'})`);
  return `${w}: ${parts.join(' · ') || 'no probe data'}`;
}

export function buildRealStory(snap: RealRunSnapshot, probes: Probes, episode: EpisodeSummary | null): Story {
  const ev = (kind: string) => snap.events.filter((e) => e.kind === kind);
  const first = (kind: string) => ev(kind)[0] as RunEvent | undefined;
  const fault = snap.incident?.title ?? episode?.fault ?? 'unknown fault';
  const docId = snap.doctor === 'tool' ? 'doc-tool' : 'doc-infra';
  const docName = snap.doctor === 'tool' ? 'Tool-Calling' : 'Infrastructure';
  const looks = openingLooks(probes);
  const plan = first('plan');
  const planTarget: string | undefined = plan?.detail?.action?.arguments?.target;
  // The faulty worker: whichever looked wrong at the start, else the plan's target, else the fault's -a/-b suffix.
  const faulty = WORKERS.find((w) => looks[w] !== 'ok') ?? planTarget ?? (fault.endsWith('-a') ? 'target-a' : fault.endsWith('-b') ? 'target-b' : null);
  const faultyIdx = faulty ? WORKERS.indexOf(faulty) : -1;
  const faultLook: Look = faulty ? (looks[faulty] !== 'ok' ? looks[faulty] : 'bad') : 'ok';
  const action = first('action');
  const exec = action?.detail?.executor ?? {};
  const verify = first('verify');
  const checks: { name: string; passed: boolean }[] = verify?.detail?.checks ?? [];
  const vr = verify?.detail?.verification ?? {};
  const terminalEvents = ev('terminal');
  const crash = terminalEvents.find((e) => e.detail?.error_type);
  const final = terminalEvents[terminalEvents.length - 1];
  const terminal: string = snap.terminal ?? episode?.terminal_state ?? 'UNKNOWN';
  const success: boolean = final?.detail?.success ?? episode?.success ?? false;
  const falseVerified: boolean = final?.detail?.false_verified ?? episode?.false_verified ?? false;
  const routeAllOk = WORKERS.every((w) => probes.route[w]?.ok !== false);
  const clock0 = snap.events[0]?.clock ?? '';
  const runId = snap.id;
  const date = episode?.at ? episode.at.slice(0, 10) : '';

  const base: Snapshot = {
    'agent-0': 'ok', 'agent-1': 'ok', 'agent-2': 'ok', 'agent-3': 'ok', 'human-0': 'ok', 'human-1': 'ok', 'human-2': 'ok',
    gateway: 'ok', floor: 'ok', dash: 'ok', canary: 'probe', 'target-a': 'ok', 'target-b': 'ok',
    mgr: 'idle', 'doc-tool': 'idle', 'doc-infra': 'idle', gate: 'idle', twin: 'idle',
  };
  const dashLie = faultLook === 'silent' && routeAllOk;
  const opening: Reality = {
    dash: routeAllOk ? `Entry point ${probes.route[WORKERS[0]] ? 'healthy, latency within limit' : 'healthy'}` : 'Latency or error alarm',
    real: faulty ? `${faulty} ${faultLook === 'silent' ? 'returns no tool calls' : 'is failing'}` : 'No worker clearly broken',
    tone: dashLie ? 'lie' : faulty ? 'caught' : 'ok',
  };

  const hops: Hop[] = [];

  hops.push({
    id: 'start', room: null, cam: 'wide', title: 'A recorded run', clock: clock0, dur: 6,
    plain: `A real run from the Brev fleet: two vLLM workers behind HAProxy on one H100. The harness injected “${fault}”, then Nemotron was asked to find and fix it.`,
    tech: `${runId}${date ? ` · ${date}` : ''} · solver: agent (Nemotron)`,
    engineer: [`incident: ${fault}`, `episode: ${snap.episode_id ?? 'none'}`, 'Replayed from the recorded trail; timings are compressed.'],
  });

  hops.push({
    id: 'fault', room: 'gpu', cam: 'gpu', clock: clock0, dur: 7.5,
    title: faultLook === 'silent' ? 'A silent break' : faulty ? 'A worker breaks' : 'Nothing obvious',
    plain: !faulty ? 'The opening probes show nothing clearly wrong on either worker.'
      : faultLook === 'silent' ? `${faulty} still answers 200 OK, but its answers carry no tool calls.`
        : `${faulty} is struggling: ${pct(probes.route[faulty]?.error_rate)} errors, p95 ${sec(probes.route[faulty]?.p95_s)}.`,
    tech: faulty ? probeLine(faulty, probes) : WORKERS.map((w) => probeLine(w, probes)).join(' · '),
    engineer: ['The fault was injected by the harness; its start time isn’t recorded.', ...WORKERS.map((w) => probeLine(w, probes))],
    beats: faulty ? [{ at: 1.2, set: { [faulty]: faultLook } }] : [],
    paths: { 'callers-door': 'fault', 'door-gpu': 'fault' },
    reality: opening,
  });

  const canaryFail = faulty ? probes.canary[faulty]?.count === 0 || probes.route[faulty]?.ok === false : false;
  hops.push({
    id: 'detect', room: 'signals', cam: 'signals-wide', title: 'What the agent is handed', clock: clock0, dur: 8.5,
    plain: 'Before it starts, Nemotron gets a monitoring snapshot: a probe through HAProxy and a tool-call canary on each worker.',
    tech: WORKERS.map((w) => `${short(w)}: ${probes.canary[w]?.verdict || (probes.route[w]?.ok === false ? 'route failing' : 'ok')}`).join(' · '),
    engineer: WORKERS.map((w) => probeLine(w, probes)),
    set: { dash: dashLie ? 'silent' : routeAllOk ? 'ok' : 'bad' },
    beats: [
      { at: 0.4, fx: (w) => w.canaryRun(Math.max(0, faultyIdx), canaryFail ? 'fail' : 'pass', 4.4) },
      { at: 4.9, set: { canary: canaryFail ? 'fail' : 'pass', ...(faulty && faultLook === 'silent' ? { [faulty]: 'caught' } : {}) } },
    ],
    paths: { 'gpu-signals': 'fault' },
    reality: opening,
  });

  // Investigation: the real tool calls, in order, a few per hop.
  const calls = ev('tool_call');
  const per = 4;
  for (let i = 0; i < calls.length; i += per) {
    const group = calls.slice(i, i + per);
    const firstHop = i === 0;
    hops.push({
      id: `investigate-${i}`, room: 'doctors', cam: 'doctors', clock: group[0].clock, dur: 1.4 + group.length * 1.9,
      title: firstHop ? `${docName} Doctor investigates` : `Investigation, continued`,
      plain: firstHop
        ? `The manager hands it to the ${docName} Doctor. Nemotron gathers evidence one tool call at a time; every claim has to cite a result.`
        : 'It keeps narrowing it down.',
      tech: `${group.map((c) => c.detail?.tool ?? c.title).join(' · ')}  (${i + 1}–${i + group.length} of ${calls.length})`,
      engineer: group.map((c) => `${c.detail?.tool}(${argText(c.detail?.arguments)}) → ${cut(String(c.detail?.result?.finding ?? c.detail?.status ?? ''), 80)}`),
      set: { mgr: snap.doctor === 'tool' ? 'tool' : 'infra', [docId]: 'investigate' },
      beats: group.map((c, k) => ({ at: 0.6 + k * 1.9, fx: (w: World) => w.say(docId, String(c.detail?.tool ?? c.title)) })),
      paths: firstHop ? { 'signals-doctors': 'fault' } : undefined,
    });
  }

  const decision = first('decision');
  if (decision) {
    const hyps = snap.hypotheses ?? [];
    hops.push({
      id: 'decide', room: 'doctors', cam: 'doctors', clock: decision.clock, dur: 9,
      title: 'Its diagnosis',
      plain: `“${cut(decision.title, 230)}”`,
      tech: plan ? `plan: ${plan.title} · confidence ${plan.detail?.confidence ?? '–'}` : 'no repair plan',
      engineer: [
        ...hyps.slice(0, 3).map((h) => `${h.id} · confidence ${h.confidence}${h.supports?.length ? ` · cites ${h.supports.join(', ')}` : ''}`),
        ...(plan?.detail?.expected_effect ? [`expected: ${cut(plan.detail.expected_effect, 140)}`] : []),
      ],
      set: { mgr: 'idle', [docId]: 'conclude' },
      beats: [{ at: 0.1, fx: (w) => { w.say(docId, null); w.cards(docId, [cut(decision.title, 90), plan ? plan.title : 'no plan', plan?.detail?.expected_effect ? cut(plan.detail.expected_effect, 90) : `${hyps.length} hypotheses`]); } }],
    });
  } else if (crash) {
    hops.push({
      id: 'stopped', room: 'doctors', cam: 'doctors', clock: crash.clock, dur: 8,
      title: 'The run stops',
      plain: `The agent’s run stopped before it reached a decision: ${cut(String(crash.detail?.message ?? crash.title), 160)}. Nothing was changed.`,
      tech: `${crash.detail?.error_type ?? 'error'} at ${crash.state}`,
      set: { mgr: 'idle', [docId]: 'idle' },
      beats: [{ at: 0.1, fx: (w) => w.say(docId, null) }],
    });
  }

  const policy = first('policy');
  if (policy) {
    const d = String(policy.detail?.decision ?? '');
    const gate = d === 'APPROVED' ? 'pass' : d.includes('APPROVAL') ? 'await' : 'blocked';
    hops.push({
      id: 'policy', room: 'doctors', cam: 'gate', clock: policy.clock, dur: 6.5,
      title: gate === 'pass' ? 'Through the policy gate' : gate === 'await' ? 'Waiting for a person' : 'Blocked by policy',
      plain: gate === 'pass' ? `The plan passes the policy gate: ${policy.detail?.reason ?? 'within the declared actions'}.`
        : gate === 'await' ? `Policy says a person has to approve this: ${policy.detail?.reason ?? ''}.`
          : `Policy rejects the plan: ${policy.detail?.reason ?? ''}.`,
      tech: `${policy.detail?.policy ?? 'policy'}: ${d}`,
      engineer: ['No shadow-twin precheck in the live agent yet; the before-state is captured instead.'],
      set: { [docId]: 'idle', gate },
    });
  }

  if (action) {
    const target: string = exec.service ?? planTarget ?? faulty ?? 'target-a';
    const idx = Math.max(0, WORKERS.indexOf(target));
    const kind: string = exec.action ?? action.detail?.kind ?? 'action';
    const ok = ['VERIFIED', 'APPLIED'].includes(String(exec.status));
    const beats: Beat[] = [];
    if (kind === 'drain_worker') beats.push({ at: 1.4, set: { [target]: 'drain', gateway: `drain:${idx}` } });
    else if (kind === 'restart_worker') {
      beats.push({ at: 1.0, set: { [target]: 'drain', gateway: `drain:${idx}` } });
      beats.push({ at: 3.6, set: { [target]: 'heal' } });
      if (ok) beats.push({ at: 6.2, set: { gateway: 'ok' }, fx: (w) => w.wave('gpu', STATUS.ok, 4, 5) });
    } else {
      beats.push({ at: 1.0, set: { [target]: 'heal' } });
      if (ok) beats.push({ at: 4.0, fx: (w) => w.wave('gpu', STATUS.ok, 4, 5) });
    }
    const profile = exec.profile ?? plan?.detail?.action?.arguments?.parameters?.profile;
    hops.push({
      id: 'act', room: 'gpu', cam: 'gpu', clock: action.clock, dur: 9,
      title: kind === 'drain_worker' ? `Drain ${target}` : kind === 'restart_worker' ? `Restart ${target}` : `Fix ${target}`,
      plain: kind === 'drain_worker' ? `The executor drains ${target}: HAProxy stops sending it traffic and ${other(target)} serves everyone.`
        : kind === 'restart_worker' ? `The executor restarts ${target}${profile ? ` with ${profile}` : ''}. It took ${sec(exec.ready_seconds ?? exec.seconds)} to come back.`
          : `The executor applies the approved serving profile to ${target}${profile ? `: ${profile}` : ''}.`,
      tech: `${kind} ${target} → ${exec.status ?? '?'} · ${sec(exec.seconds)}`,
      engineer: [`change ${exec.change_id ?? action.detail?.token ?? '–'} · reversible through the executor`, ...(exec.verification ? [`executor check: ${exec.verification.passed ? 'passed' : 'failed'}`] : [])],
      beats,
      paths: { fix: ok ? 'fix' : 'fault' },
    });
  }

  if (verify) {
    const route: Record<string, RouteWorker> = vr.route ?? {};
    const after: Snapshot = {};
    for (const w of WORKERS) {
      const r = route[short(w)];
      if (r && r.ok === false) after[w] = 'bad';
      else if (w === faulty && vr.faulty_worker_drained) after[w] = 'drain';
      else if (w === faulty && !vr.root_fixed && faultLook === 'silent') after[w] = 'silent';
      else after[w] = 'ok';
    }
    after.gateway = faulty && vr.faulty_worker_drained ? `drain:${faultyIdx}` : 'ok';
    const passed = checks.filter((c) => c.passed).length;
    hops.push({
      id: 'verify', room: 'signals', cam: 'signals-wide', clock: verify.clock, dur: 9.5,
      title: 'An independent referee',
      plain: `Not the agent, but an independent referee checks what users actually get: ${passed} of ${checks.length} checks pass.`,
      tech: checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.name}`).join(' · '),
      engineer: Object.entries(route).map(([k, r]) => `route ${k}: ${r.requests ?? '?'} req · p95 ${sec(r.p95_s)} · errors ${pct(r.error_rate)} · ${r.ok ? 'ok' : 'not ok'}`),
      set: { ...after, dash: vr.users_ok ? 'ok' : 'bad', [docId]: 'idle', gate: 'idle' },
      beats: [
        { at: 0.4, fx: (w) => w.canaryRun(Math.max(0, faultyIdx), vr.hidden_passed ? 'pass' : 'fail', 4.4) },
        { at: 4.9, set: { canary: vr.hidden_passed ? 'pass' : 'fail' } },
      ],
      reality: {
        head: 'What the agent says vs what the referee found',
        labels: ['Agent says', 'Referee found'],
        dash: terminal,
        // Straight from the referee's flags, never from the agent's claim.
        real: `${falseVerified ? 'False VERIFIED: ' : ''}${vr.users_ok ? 'users served' : 'users not served'}, root cause ${vr.root_fixed ? 'fixed' : 'not fixed'}`,
        tone: falseVerified ? 'lie' : vr.users_ok && vr.root_fixed ? 'ok' : 'caught',
      },
    });
  }

  const verdict = falseVerified ? { word: 'FALSE VERIFIED', color: STATUS.bad, tone: 'bad' as const }
    : terminal === 'VERIFIED' && success ? { word: 'VERIFIED', color: STATUS.ok, tone: 'ok' as const }
      : terminal === 'REQUIRES_APPROVAL' ? { word: 'NEEDS APPROVAL', color: STATUS.warn, tone: 'warn' as const }
        : terminal === 'ROLLED_BACK' ? { word: 'ROLLED BACK', color: STATUS.restart, tone: 'warn' as const }
          : { word: terminal === 'ABSTAIN' ? 'ABSTAINED' : terminal, color: STATUS.off, tone: 'idle' as const };
  const passed = checks.filter((c) => c.passed).length;
  const record: CertRecord = {
    word: verdict.word, color: verdict.color,
    rows: [['fault', fault], ['doctor', docName], ['action', exec.action ? `${exec.action} ${short(exec.service ?? '')}` : 'none'], ['referee', checks.length ? `${passed} / ${checks.length} checks` : '–'], ['solve', sec(episode?.solve_seconds)]],
    hash: ['run', runId, snap.episode_id ? cut(snap.episode_id.split('/').pop() ?? '', 30) : ''],
  };
  const note = falseVerified ? 'The agent reported VERIFIED, but the independent referee found the problem wasn’t fixed. That’s a false VERIFIED, and it counts against the agent.'
    : crash && !decision ? 'The run crashed before it decided anything, so nothing on the fleet was changed.'
      : terminal === 'REQUIRES_APPROVAL' ? 'Users were protected, but the root cause still needs a person to approve the next step.'
        : terminal === 'ABSTAIN' ? 'The agent stopped without acting. Nothing on the fleet was changed.'
          : 'The referee confirmed the fix: users served, root cause gone.';
  hops.push({
    id: 'proof', room: null, cam: 'finale', title: 'The whole picture', clock: final?.clock ?? clock0, dur: 12,
    plain: note,
    tech: `${terminal} · referee: ${success ? 'success' : 'not fixed'}${falseVerified ? ' · false VERIFIED' : ''}`,
    engineer: [`tool calls ${snap.usage?.tool_calls ?? calls.length} · steps ${snap.usage?.steps ?? '–'}`],
    finale: record,
  });

  return {
    id: `run:${runId}`, name: `Run ${runId.replace('run-', '')}`, short: runId, mode: 'real',
    badge: `RECORDED RUN · ${runId}`,
    subs: { door: 'HAProxy entry point', gpu: '2 vLLM workers · one H100', twin: 'not used by the live agent yet' },
    base,
    candidates: [{ name: '', fate: 'lose' }, { name: '', fate: 'lose' }, { name: '', fate: 'lose' }],
    hops,
    summary: {
      label: 'Recorded run', outcome: verdict.word.charAt(0) + verdict.word.slice(1).toLowerCase(), tone: verdict.tone,
      rows: [['Run', runId], ['Fault', fault], ['Agent says', terminal], ['Referee', checks.length ? `${passed} / ${checks.length} checks passed` : 'no checks recorded'], ['Tool calls', String(snap.usage?.tool_calls ?? calls.length)], ['Solve time', sec(episode?.solve_seconds)]],
      note,
    },
  };
}
