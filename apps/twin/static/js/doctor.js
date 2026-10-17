// Components shared by both doctors: workflow rail, budgets, reasoning stream,
// hypotheses, incident memory, shadow-twin branches, recovery timeline, proof.
import { $, esc, api, clock, dur, ms, pct, json, toast, STATE_LABEL, TERMINAL_TONE } from './ui.js';

const RAIL = ['INGEST', 'DIAGNOSE', 'EXPAND_CONTEXT', 'PLAN', 'PRECHECK', 'ACT', 'VERIFY'];
const ICON = {
  INGEST: 'M4 12h16M12 4v16', DIAGNOSE: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.3-4.3', EXPAND_CONTEXT: 'M4 6h16M4 12h10M4 18h6',
  PLAN: 'M5 5h14v14H5zM9 9h6M9 13h4', PRECHECK: 'M6 4v6l-3 8h18l-3-8V4M5 4h14', ACT: 'M13 2 4 14h7l-1 8 9-12h-7z', VERIFY: 'M5 12l4 4 10-10',
};
const svgIcon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

// ------------------------------------------------------------------ rail

export function renderRail(el, run, idleText) {
  if (!run) {
    el.innerHTML = `<div class="rail idle">${RAIL.map((s) => `<div class="step"><i>${svgIcon(ICON[s])}</i><b>${STATE_LABEL[s]}</b><small>&nbsp;</small></div>`).join('<span class="link"></span>')}
      <div class="step terminal"><i>${svgIcon('M12 2 3 7v6c0 5 4 8 9 9 5-1 9-4 9-9V7z')}</i><b>Outcome</b><small>&nbsp;</small></div></div>
      <p class="rail-idle">${esc(idleText)}</p>`;
    return;
  }
  const visited = new Map();
  let rounds = 0;
  for (const s of run.states) {
    if (!visited.has(s.state)) visited.set(s.state, s.clock);
    if (s.state === 'EXPAND_CONTEXT') rounds++;
  }
  const current = run.terminal ? null : run.state;
  const steps = RAIL.map((s) => {
    const cls = s === current ? 'active' : visited.has(s) ? 'done' : '';
    const badge = s === 'EXPAND_CONTEXT' && rounds > 1 ? `<em>×${rounds}</em>` : '';
    return `<div class="step ${cls}"><i>${svgIcon(ICON[s])}</i><b>${STATE_LABEL[s]}${badge}</b><small>${visited.get(s) ?? '&nbsp;'}</small></div>`;
  });
  const t = run.terminal;
  const term = `<div class="step terminal ${t ? 'done tone-' + TERMINAL_TONE[t] : ''}"><i>${svgIcon(t === 'VERIFIED' ? ICON.VERIFY : 'M12 2 3 7v6c0 5 4 8 9 9 5-1 9-4 9-9V7z')}</i><b>${t ? STATE_LABEL[t] : 'Outcome'}</b><small>${t ? visited.get(t) ?? '' : '&nbsp;'}</small></div>`;
  el.innerHTML = `<div class="rail">${steps.map((s, i) => s + `<span class="link ${visited.has(RAIL[i + 1]) || (i === RAIL.length - 1 && t) ? 'on' : ''}"></span>`).join('')}${term}</div>`;
}

export function renderBudget(el, run) {
  if (!run) { el.innerHTML = ''; return; }
  const meter = (label, used, max) => `<div class="meter"><span>${label}</span><div><i style="width:${Math.min(100, (used / max) * 100)}%"></i></div><b>${used}/${max}</b></div>`;
  const u = run.usage, b = run.budget;
  el.innerHTML = meter('Steps', u.steps, b.max_steps) + meter('Context rounds', u.context_rounds, b.max_context_rounds) + meter('Tool calls', u.tool_calls, b.max_tool_calls) + meter('Mutations', u.mutations, b.max_mutations);
}

// ---------------------------------------------------------------- stream

const streamState = new WeakMap();

export function renderStream(el, run, { empty = 'No run yet.' } = {}) {
  const st = streamState.get(el) ?? { id: null, n: 0 };
  if (!run) {
    if (st.id !== null || !el.children.length) el.innerHTML = `<p class="empty">${esc(empty)}</p>`;
    streamState.set(el, { id: null, n: 0 });
    return;
  }
  if (st.id !== run.id) { el.innerHTML = ''; st.id = run.id; st.n = 0; }
  const fresh = run.events.slice(st.n);
  for (const e of fresh) {
    const node = streamCard(e, run);
    if (node) el.appendChild(node);
  }
  st.n = run.events.length;
  streamState.set(el, st);
  if (fresh.length) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  const appr = el.querySelector('.card-approval:last-of-type');
  if (appr) appr.classList.toggle('stale', !run.awaiting_approval);
}

function streamCard(e, run) {
  const d = e.detail;
  const div = document.createElement('div');
  const time = `<time>${e.clock}</time>`;
  switch (e.kind) {
    case 'state':
      div.className = 'sc sc-state';
      div.innerHTML = `${time}<b>${STATE_LABEL[e.title] ?? e.title}</b><span>${esc(d.note ?? '')}</span>`;
      break;
    case 'tool_call': {
      div.className = `sc sc-tool ${d.status}`;
      const args = Object.keys(d.arguments || {}).length ? esc(JSON.stringify(d.arguments)) : '';
      const result = d.status === 'ok' ? json(d.result, 900) : `${d.error_code}: ${d.error}`;
      div.innerHTML = `${time}<div class="tool-head"><code>${esc(d.tool)}</code><span class="args">${args}</span>
        <span class="pill ${d.status === 'ok' ? 'ok' : 'bad'}">${d.status === 'ok' ? '✓ ok' : '✗ ' + esc(d.error_code)}</span><span class="pill muted">${esc(d.class)}</span></div>
        <p>${esc(d.reason)}${d.hypothesis ? ` <span class="hyp">tests: ${esc(d.hypothesis)}</span>` : ''}</p>
        <details><summary>${d.status === 'ok' ? 'Result' : 'Error'}</summary><pre>${esc(result)}</pre></details>`;
      break;
    }
    case 'evidence':
      div.className = 'sc sc-evidence';
      div.innerHTML = `${time}<span class="ev">${esc(d.evidence_id)}</span><p>${esc(e.title)}</p>
        <div class="chips">${d.supports.map((h) => `<span class="pill ok">+ ${esc(h)}</span>`).join('')}${d.contradicts.map((h) => `<span class="pill muted">− ${esc(h)}</span>`).join('')}</div>`;
      break;
    case 'decision':
      div.className = 'sc sc-decision';
      div.innerHTML = `${time}<div class="who">Diagnosis · ${(d.confidence * 100).toFixed(0)}% confidence</div><p>${esc(e.title)}</p><div class="chips">${(d.evidence || []).map((x) => `<span class="pill">${esc(x)}</span>`).join('')}</div>`;
      break;
    case 'plan':
      div.className = 'sc sc-plan';
      div.innerHTML = `${time}<div class="who">Repair plan</div><p>${esc(e.title)}</p>${d.risk ? `<dl><dt>Expected</dt><dd>${esc(d.expected_effect)}</dd><dt>Risk</dt><dd>${esc(d.risk)}</dd><dt>Rollback</dt><dd>${esc(d.rollback_plan)}</dd></dl>` : ''}`;
      break;
    case 'precheck':
      div.className = 'sc sc-precheck';
      div.innerHTML = `${time}<div class="who">Shadow twin</div><p>${esc(e.title)}</p>`;
      break;
    case 'policy':
      div.className = `sc sc-policy ${d.decision === 'rejected' ? 'rejected' : d.decision === 'approved' ? 'approved' : ''}`;
      div.innerHTML = `${time}<span class="pill ${d.decision === 'rejected' ? 'bad' : d.decision === 'approved' ? 'ok' : 'warn'}">${esc(d.decision)}</span><code>${esc(d.policy)}</code><span>${esc(d.reason)}</span>`;
      break;
    case 'approval':
      div.className = 'sc card-approval';
      div.innerHTML = `${time}<div class="who">Authorization required</div><p>${esc(e.title)}</p>
        <div class="row"><button class="btn primary" data-a="recommended">Authorize</button><button class="btn ghost" data-a="reject">Decline</button></div>`;
      div.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => approve(run.id, b.dataset.a)));
      break;
    case 'action':
      div.className = 'sc sc-action';
      div.innerHTML = `${time}<code>${esc(e.title)}</code>${d.token ? `<span class="pill">${esc(d.token)}</span>` : ''}${d.reversible === false ? '<span class="pill warn">irreversible</span>' : d.reversible ? '<span class="pill ok">rollback ready</span>' : ''}`;
      break;
    case 'verify':
      div.className = 'sc sc-verify';
      div.innerHTML = `${time}<div class="who">Independent verification</div><ul>${d.checks.map((c) => `<li class="${c.passed ? 'ok' : 'bad'}">${c.passed ? '✓' : '✗'} ${esc(c.name)} <small>${esc(c.detail)}</small></li>`).join('')}</ul>`;
      break;
    case 'terminal':
      div.className = `sc sc-terminal tone-${TERMINAL_TONE[e.title]}`;
      div.innerHTML = `${time}<b>${STATE_LABEL[e.title]}</b><span>${esc(d.reason)}</span>`;
      break;
    case 'certificate':
      div.className = 'sc sc-cert';
      div.innerHTML = `${time}<span>${esc(e.title)}</span><button class="btn small">View proof</button>`;
      div.querySelector('button').addEventListener('click', () => openProof(d.certificate_id));
      break;
    default:
      div.className = 'sc sc-note';
      div.innerHTML = `${time}<span>${esc(e.title)}</span>`;
  }
  return div;
}

export async function approve(runId, choice) {
  try {
    await api(`/api/doctors/runs/${runId}/approve`, { choice });
    toast(choice === 'reject' ? 'Repair declined: run ends as REQUIRES_APPROVAL' : 'Repair authorized');
  } catch (e) {
    toast(e.message, { tone: 'bad' });
  }
}

// ------------------------------------------------------------ hypotheses

export function renderHypotheses(el, run) {
  if (!run) { el.innerHTML = '<p class="empty">Hypotheses appear once a doctor starts diagnosing.</p>'; return; }
  const rows = run.hypotheses.slice(0, 6);
  if (el.dataset.run !== run.id) { el.innerHTML = ''; el.dataset.run = run.id; }
  for (const [i, h] of rows.entries()) {
    let row = el.querySelector(`[data-h="${h.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'hyp-row';
      row.dataset.h = h.id;
      row.innerHTML = `<div class="hyp-top"><span></span><b></b></div><div class="bar"><i></i></div><small></small>`;
      el.appendChild(row);
    }
    row.style.order = i;
    row.classList.toggle('lead', i === 0);
    row.querySelector('span').textContent = h.label;
    row.querySelector('b').textContent = `${(h.confidence * 100).toFixed(0)}%`;
    row.querySelector('i').style.width = `${Math.max(2, h.confidence * 100)}%`;
    row.querySelector('small').textContent = [h.supports.length ? `supported by ${h.supports.join(', ')}` : '', h.contradicts.length ? `contradicted by ${h.contradicts.join(', ')}` : ''].filter(Boolean).join(' · ');
  }
}

export function renderMemory(el, run) {
  const m = run?.matches?.[0];
  if (!run || !m) {
    el.innerHTML = `<p class="empty">${run && run.events.some((e) => e.detail?.tool === 'retrieve_incident_context') ? 'No past certificate matches this signature.' : 'Signature not checked yet.'}</p>`;
    return;
  }
  const r = 26, c = 2 * Math.PI * r;
  el.innerHTML = `<div class="memory">
    <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="${r}" class="track"/><circle cx="32" cy="32" r="${r}" class="val" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - m.similarity)}"/><text x="32" y="37">${Math.round(m.similarity * 100)}%</text></svg>
    <div><b>${esc(m.incident)}</b><p>Fixed by <em>${esc(m.repair)}</em> · ${esc(m.terminal_state)}</p>
    <small>${esc(m.certificate_id)} ${m.provenance === 'fixture' ? '<span class="pill warn">seed fixture</span>' : ''}</small></div></div>
    <div class="chips tight">${m.shared.map((s) => `<span class="pill muted">${esc(s)}</span>`).join('')}</div>`;
}

// -------------------------------------------------- shadow twin branches

export function renderBranches(el, run, { onApply, manual } = {}) {
  const pre = manual ?? run?.precheck;
  if (!pre) {
    el.innerHTML = `<p class="empty">${run ? 'The doctor forks the twin at PRECHECK and compares each candidate before acting.' : 'Inject a failure: the doctor will fork the twin and race candidate fixes here.'}</p>`;
    return;
  }
  const key = `${run?.id}:${pre.t0}:${run?.chosen}:${run?.awaiting_approval}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const cands = pre.candidates;
  const H = 46 * cands.length + 10;
  const fork = `<svg class="fork" viewBox="0 0 80 ${H}" preserveAspectRatio="none">${cands.map((_, i) => {
    const y = 28 + i * 46;
    return `<path d="M0 ${H / 2} C 40 ${H / 2}, 40 ${y}, 80 ${y}" class="${i === 0 ? 'best' : ''}"/>`;
  }).join('')}<circle cx="4" cy="${H / 2}" r="4"/></svg>`;
  const rows = cands.map((c, i) => {
    const chosen = run?.chosen === c.id;
    const rec = pre.recommended === c.id;
    const tone = c.slo_fraction > 0.9 ? 'ok' : c.slo_fraction > 0.5 ? 'warn' : 'bad';
    const spark = (c.series?.slo || []).map((v, k, a) => `<i style="left:${(k / a.length) * 100}%;width:${100 / a.length + 0.4}%" class="${v >= 0.999 ? 'g' : v > 0 ? 'a' : 'r'}"></i>`).join('');
    const badge = c.policy === 'rejected' ? `<span class="pill bad" title="${esc(c.policy_reason)}">blocked by policy</span>` : chosen ? '<span class="pill ok">applied</span>' : rec ? '<span class="pill ok">recommended</span>' : '';
    const btn = onApply && c.actions?.length && c.policy !== 'rejected' && !chosen ? `<button class="btn small ${rec ? 'primary' : 'ghost'}" data-i="${i}">${run?.awaiting_approval ? 'Authorize' : 'Apply'}</button>` : '';
    return `<div class="branch ${chosen ? 'chosen' : ''} ${rec ? 'rec' : ''} ${c.policy === 'rejected' ? 'blocked' : ''}" style="animation-delay:${i * 70}ms">
      <div class="b-label"><b>${esc(c.label)}</b>${badge}</div>
      <div class="b-strip" title="SLO met per second across seeds">${spark}</div>
      <div class="b-num ${tone}">${Math.round(c.slo_fraction * 100)}<small>% in SLO</small></div>
      <div class="b-meta">TTFT pk ${c.peak_ttft_p95 == null ? '–' : c.peak_ttft_p95.toFixed(2) + 's'} · cap ${Math.round(c.final_capacity * 100)}%${c.recovered_s >= 5 ? ` · full in ${Math.round(c.recovered_s)}s` : ''}</div>${btn}</div>`;
  }).join('');
  el.innerHTML = `<div class="branches">${fork}<div class="b-list">${rows}</div></div>
    <p class="foot">Forked at ${clock(pre.t0)} · ${cands.length} candidates × ${pre.seeds.length} seeds × ${pre.horizon}s · calibration: ${esc(pre.calibration?.confidence ?? 'low')}</p>`;
  el.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => onApply(cands[+b.dataset.i])));
}

// ----------------------------------------------------- recovery timeline

export function renderTimeline(el, app, run) {
  const hist = app.kpiHist;
  if (!hist.length) return;
  const now = hist[hist.length - 1].t;
  const fault = run?.signal?.fault_t;
  const t0 = Math.max(hist[0].t, Math.min(fault ?? now - 120, run ? run.states[0]?.t - 20 : now - 120) - 10);
  const t1 = Math.max(now, (run?.states.at(-1)?.t ?? now)) + 5;
  const X = (t) => `${((t - t0) / (t1 - t0)) * 100}%`;
  const window = hist.filter((k) => k.t >= t0);
  const slo = app.topo.slo;
  const lane = (label, test, note) => {
    const segs = [];
    let start = null, bad = false;
    for (const k of window) {
      const b = test(k);
      if (start === null) { start = k.t; bad = b; continue; }
      if (b !== bad) { segs.push([start, k.t, bad]); start = k.t; bad = b; }
    }
    if (start !== null) segs.push([start, now, bad]);
    return `<div class="lane"><span class="lane-label">${label}<small>${note}</small></span><div class="lane-track">${segs.map(([a, b, x]) => `<i class="${x ? 'bad' : 'ok'}" style="left:${X(a)};width:calc(${X(b)} - ${X(a)})"></i>`).join('')}</div></div>`;
  };
  const dash = lane('Dashboards', (k) => (k.ttft_p95 ?? 0) > slo.ttft_p95_s || k.error_rate > slo.error_rate, 'latency · errors');
  const canary = lane('Functional canary', (k) => k.canary < 0.999, 'tool calls work?');
  const marks = [];
  if (fault != null && fault >= t0) marks.push({ t: fault, label: 'Fault', cls: 'fault' });
  const seen = new Set();
  for (const s of run?.states ?? []) {
    if (seen.has(s.state)) continue;
    seen.add(s.state);
    marks.push({ t: s.t, label: s.state === 'INGEST' ? 'Detected' : STATE_LABEL[s.state], cls: s.state === 'INGEST' ? 'detect' : ['VERIFIED', 'ROLLED_BACK', 'REQUIRES_APPROVAL', 'ABSTAIN'].includes(s.state) ? 'term ' + TERMINAL_TONE[s.state] : s.state === 'ACT' ? 'act' : '' });
  }
  // Place labels by priority (fault, detection, action, outcome first) in two rows.
  const span = t1 - t0;
  const rank = (m) => (m.cls === 'fault' || m.cls === 'detect' ? 0 : m.cls.startsWith('term') ? 1 : m.cls === 'act' ? 2 : 3);
  const rows = [[], []];
  for (const m of [...marks].sort((a, b) => rank(a) - rank(b))) {
    const x = (m.t - t0) / span;
    const r = rows.findIndex((row) => row.every((y) => Math.abs(y - x) > 0.075));
    m.row = r === 0 ? '' : r === 1 ? 'low' : 'hide';
    if (r >= 0) rows[r].push(x);
  }
  const nexus = `<div class="lane nexus"><span class="lane-label">Nexus Ω<small>${run ? esc(run.title) : 'watching'}</small></span><div class="lane-track">
    ${marks.map((m) => `<span class="mark ${m.cls}" style="left:${X(m.t)}" title="${esc(m.label)} · ${clock(m.t)}"><i></i>${m.row === 'hide' ? '' : `<em class="${m.row}">${esc(m.label)}<small>${clock(m.t)}</small></em>`}</span>`).join('')}
    <span class="now" style="left:${X(now)}"></span></div></div>`;
  const ttd = run && fault != null ? `<span>Time to detect <b>${dur(run.states[0].t - fault)}</b></span>` : '';
  const ttr = run?.terminal && fault != null ? `<span>Time to resolution <b>${dur(run.states.at(-1).t - fault)}</b></span>` : '';
  el.innerHTML = `<header><h3>Recovery timeline</h3><div class="tl-stats">${ttd}${ttr}${run?.certificate_id ? `<button class="btn small" data-proof>View proof</button>` : ''}</div></header>${dash}${canary}${nexus}
    <div class="axis"><span>${clock(t0)}</span><span>${clock((t0 + t1) / 2)}</span><span>${clock(t1)}</span></div>`;
  el.querySelector('[data-proof]')?.addEventListener('click', () => openProof(run.certificate_id));
}

// ------------------------------------------------------ proof of recovery

export async function openProof(certId) {
  let data;
  try {
    data = await api(`/api/certificates/${certId}/summary`);
  } catch (e) {
    toast(e.message, { tone: 'bad' });
    return;
  }
  const { certificate: c, notification: n, morning: m } = data;
  const before = c.verification?.before ?? {}, after = c.verification?.after ?? {};
  const row = (label, key, fmt) => `<tr><td>${label}</td><td>${fmt(before[key])}</td><td>${fmt(after[key])}</td></tr>`;
  const modal = $('#proof');
  modal.innerHTML = `<div class="proof-card" role="dialog" aria-label="Proof of recovery">
    <header>
      <div><span class="eyebrow">Recovery certificate</span><h2>${esc(c.incident?.title ?? 'Incident')} <span class="tone tone-${TERMINAL_TONE[c.terminal_state]}">${STATE_LABEL[c.terminal_state]}</span></h2>
      <p>${esc(c.terminal_reason)} · ${esc(c.certificate_id)}</p></div>
      <div class="row"><a class="btn" href="/api/certificates/${encodeURIComponent(c.certificate_id)}?download=1">Download JSON</a><button class="btn ghost" data-print>Print / PDF</button><button class="btn ghost icon" data-close aria-label="Close">✕</button></div>
    </header>
    <section class="proof-grid">
      <div class="pcard morning">
        <span class="eyebrow">While you slept</span>
        <h3>${esc(m.headline)}</h3>
        <ol class="steps"><li><b>${m.detected ?? '–'}</b> canary alert</li><li><b>${m.repaired ?? '–'}</b> repair applied</li><li><b>${m.verified ?? '–'}</b> ${esc(STATE_LABEL[c.terminal_state].toLowerCase())}</li></ol>
        <div class="kv"><span>Time to detect</span><b>${m.time_to_detect}</b><span>Time to resolution</span><b>${m.time_to_recover}</b><span>Dashboards alerted</span><b class="${c.dashboards_alerted ? '' : 'warn-text'}">${c.dashboards_alerted ? 'yes' : 'no: latency and errors stayed green'}</b></div>
      </div>
      <div class="pcard slack">
        <span class="eyebrow">${esc(n.channel)} · preview, not sent</span>
        <div class="msg"><i>Ω</i><div><b>Nexus Ω</b><small>${esc(m.verified ?? '')}</small><pre>${esc(n.text)}</pre></div></div>
      </div>
      <div class="pcard">
        <span class="eyebrow">Before → after</span>
        <table class="ba"><thead><tr><th></th><th>At detection</th><th>Verified</th></tr></thead><tbody>
          ${row('TTFT p95', 'ttft_p95', ms)}${row('TPOT p95', 'tpot_p95', (v) => (v == null ? '–' : `${(v * 1000).toFixed(1)} ms`))}${row('Error rate', 'error_rate', (v) => pct(v, 2))}${row('Tool canary', 'canary', (v) => pct(v, 0))}${row('Serving capacity', 'capacity', (v) => pct(v, 0))}${row('Hottest GPU', 'max_gpu_c', (v) => (v == null ? '–' : `${v.toFixed(0)} °C`))}
        </tbody></table>
      </div>
      <div class="pcard">
        <span class="eyebrow">Independent checks</span>
        <ul class="checks">${(c.verification?.checks ?? []).map((k) => `<li class="${k.passed ? 'ok' : 'bad'}"><i>${k.passed ? '✓' : '✗'}</i>${esc(k.name)}<small>${esc(k.detail)}</small></li>`).join('')}</ul>
      </div>
      <div class="pcard">
        <span class="eyebrow">Predicted vs actual · TTFT p95</span>
        <canvas id="pva" width="720" height="240"></canvas>
        <p class="note">${c.prediction_vs_actual ? `Mean absolute error ${c.prediction_vs_actual.mae_s.toFixed(3)} s over ${c.prediction_vs_actual.samples} samples.` : 'No prediction for this run.'}</p>
      </div>
      <div class="pcard">
        <span class="eyebrow">Repair & rollback</span>
        <p><b>${esc(c.repair?.label ?? 'none')}</b></p>
        <div class="kv"><span>Change tokens</span><b>${esc((c.repair?.change_tokens ?? []).join(', ') || '–')}</b><span>Rollback token</span><b>${esc(c.repair?.rollback_token ?? 'n/a')}</b><span>Rollback exercised</span><b>${c.repair?.rollback_exercised ? 'yes' : 'no'}</b></div>
        <p class="note">Diagnosis: ${esc(c.diagnosis?.summary ?? '')}</p>
      </div>
      <div class="pcard wide">
        <span class="eyebrow">Evidence chain · ${c.evidence?.length ?? 0} items · ${c.tool_calls?.length ?? 0} tool calls</span>
        <ol class="chain">${(c.evidence ?? []).map((e) => `<li><code>${esc(e.evidence_id)}</code><span>${esc(e.finding)}</span><small>${esc(e.source_type)} · ${esc(e.collected_at)}</small></li>`).join('')}</ol>
      </div>
    </section>
    <footer>Controller: ${esc(c.controller)} · Effects and verification: SimPy twin · sha256 ${esc((c.sha256 ?? '').slice(0, 16))}…</footer>
  </div>`;
  modal.classList.add('open');
  modal.querySelector('[data-close]').addEventListener('click', () => modal.classList.remove('open'));
  modal.querySelector('[data-print]').addEventListener('click', () => window.print());
  modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('open'); };
  drawPva($('#pva'), c.prediction_vs_actual);
}

function drawPva(canvas, pva) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!pva) return;
  const pts = pva.points;
  const tMax = Math.max(...pts.map((p) => p[0])), tMin = Math.min(...pts.map((p) => p[0]));
  const vMax = Math.max(0.5, ...pts.flatMap((p) => [p[1], p[2]])) * 1.15;
  const x = (t) => 40 + ((t - tMin) / (tMax - tMin || 1)) * (W - 60);
  const y = (v) => H - 30 - (v / vMax) * (H - 50);
  ctx.strokeStyle = '#e5e8ec'; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const v = (vMax * k) / 4; ctx.beginPath(); ctx.moveTo(40, y(v)); ctx.lineTo(W - 20, y(v)); ctx.stroke(); ctx.fillStyle = '#98a2b3'; ctx.font = '20px Inter'; ctx.fillText(`${v.toFixed(1)}s`, 0, y(v) + 6); }
  ctx.beginPath(); pts.forEach((p) => ctx.lineTo(x(p[0]), y(p[1]))); ctx.strokeStyle = '#0891b2'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#76b900';
  pts.forEach((p) => { ctx.beginPath(); ctx.arc(x(p[0]), y(p[2]), 5, 0, Math.PI * 2); ctx.fill(); });
  ctx.font = '20px Inter'; ctx.fillStyle = '#0891b2'; ctx.fillText('— predicted (median of seeds)', 60, 24); ctx.fillStyle = '#4d7c0f'; ctx.fillText('● actual', 400, 24);
}
