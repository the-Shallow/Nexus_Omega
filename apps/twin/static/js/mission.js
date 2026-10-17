// Mission Control: live status, vital signs, doctors, incidents, detection gap, certificates.
import { $, esc, api, clock, dur, ms, pct, spark, STATE_LABEL, TERMINAL_TONE } from './ui.js';
import { renderTimeline, openProof } from './doctor.js';

const KPIS = [
  { key: 'ttft_p95', label: 'TTFT p95', fmt: (v) => ms(v), level: (v, s) => (v == null || v > s.ttft_p95_s ? 'bad' : v > 0.7 * s.ttft_p95_s ? 'warn' : '') },
  { key: 'tpot_p95', label: 'TPOT p95', fmt: (v) => (v == null ? '–' : `${(v * 1000).toFixed(1)} ms`), level: (v, s) => (v == null ? '' : v > s.tpot_p95_s ? 'bad' : v > 0.8 * s.tpot_p95_s ? 'warn' : '') },
  { key: 'error_rate', label: 'Error rate', fmt: (v) => pct(v, 2), level: (v, s) => (v > s.error_rate ? 'bad' : v > s.error_rate / 3 ? 'warn' : '') },
  { key: 'canary', label: 'Tool-call canary', fmt: (v) => pct(v, 0), level: (v) => (v < 0.999 ? 'bad' : '') },
  { key: 'tps', label: 'Throughput', fmt: (v) => `${(v / 1000).toFixed(1)}k tok/s`, level: () => '' },
  { key: 'it_kw', label: 'IT load', fmt: (v) => `${v.toFixed(0)} kW`, level: () => '' },
  { key: 'supply_c', label: 'Supply air', fmt: (v) => `${v.toFixed(1)} °C`, level: (v) => (v > 32 ? 'bad' : v > 27 ? 'warn' : '') },
  { key: 'max_gpu_c', label: 'Hottest GPU', fmt: (v) => `${v.toFixed(0)} °C`, level: (v) => (v > 87 ? 'bad' : v > 80 ? 'warn' : '') },
];

export function initMission(app) {
  $('#kpis').innerHTML = KPIS.map((k) => `<div class="kpi" id="k-${k.key}"><label>${k.label}</label><b>–</b><canvas width="220" height="44"></canvas></div>`).join('');
  refreshCerts(app);
}

export async function refreshCerts(app) {
  try {
    app.certs = await api('/api/certificates');
  } catch { app.certs = []; }
  const el = $('#certs');
  if (!app.certs.length) { el.innerHTML = '<p class="empty">None yet. Each finished run issues one.</p>'; return; }
  el.innerHTML = app.certs.slice(0, 5).map((c) => `<button class="cert-row" data-id="${esc(c.certificate_id)}">
    <span class="tone tone-${TERMINAL_TONE[c.terminal_state] ?? 'muted'}">${esc(STATE_LABEL[c.terminal_state] ?? c.terminal_state)}</span>
    <b>${esc(c.incident)}</b><small>${esc(c.issued_at ?? '')}${c.provenance === 'fixture' ? ' · seed fixture' : ''}</small></button>`).join('');
  el.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => openProof(b.dataset.id)));
}

export function renderMission(app) {
  const f = app.frame, k = f.kpi, slo = app.topo.slo;
  const run = app.doctor;
  const active = run && !run.terminal ? run : null;

  // Status hero.
  const open = f.faults.filter((x) => x.resolved_at == null);
  let tone = 'ok', title = 'All systems nominal', sub = `${app.topo.workers.length} vLLM replicas · ${f.gpu.temp.length} GPUs · ${k.rps_in.toFixed(0)} req/s`;
  if (active) {
    tone = active.doctor === 'tool' ? 'warn' : 'bad';
    title = active.incident?.title || active.signal.alarms.join(' · ');
    sub = `${active.title} · ${STATE_LABEL[active.state]}${active.awaiting_approval ? ' · awaiting your authorization' : ''}`;
  } else if (!k.slo_ok) {
    tone = 'bad'; title = 'SLO breach'; sub = 'Detecting…';
  } else if (open.length) {
    tone = 'info'; title = 'Degraded but stable'; sub = `${open.length} open incident${open.length > 1 ? 's' : ''} need a human`;
  }
  const sc = $('#status-card');
  sc.className = `card status tone-${tone}`;
  sc.innerHTML = `<div class="pulse"><i></i></div><div><span class="eyebrow">System status</span><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>`;

  // Vital signs.
  if (k.t !== app._kpiT) {
    app._kpiT = k.t;
    for (const d of KPIS) {
      const el = $(`#k-${d.key}`);
      const lvl = d.level(k[d.key], slo);
      el.className = `kpi ${lvl}`;
      $('b', el).textContent = k[d.key] == null ? '–' : d.fmt(k[d.key]);
      spark($('canvas', el), app.kpiHist.slice(-120).map((x) => x[d.key]), { color: lvl === 'bad' ? '#e11d48' : lvl === 'warn' ? '#d97706' : '#76b900' });
    }
  }

  // Doctor cards.
  const card = (doc, name, blurb) => {
    const r = run && run.doctor === doc ? run : null;
    const live = r && !r.terminal;
    const state = live ? STATE_LABEL[r.state] : r ? STATE_LABEL[r.terminal] : 'Watching';
    const tone2 = live ? 'active' : r ? TERMINAL_TONE[r.terminal] : 'idle';
    const prog = ['INGEST', 'DIAGNOSE', 'EXPAND_CONTEXT', 'PLAN', 'PRECHECK', 'ACT', 'VERIFY'].map((s) => `<i class="${r?.states.some((x) => x.state === s) ? 'on' : ''} ${live && r.state === s ? 'cur' : ''}"></i>`).join('');
    return `<button class="doctor-card tone-${tone2}" data-go="${doc}"><div class="dc-top"><span class="eyebrow">${name}</span><span class="tone tone-${tone2 === 'active' ? 'warn' : tone2 === 'idle' ? 'muted' : tone2}">${esc(state)}</span></div>
      <p>${r ? esc(r.incident?.title || r.signal.alarms.join(', ')) : esc(blurb)}</p><div class="prog">${prog}</div></button>`;
  };
  const dc = $('#doctor-cards');
  const html = card('tool', 'Tool-Calling Doctor', 'Canaries probe every replica for real tool calls.') + card('infra', 'Infrastructure Doctor', 'Telemetry from GPUs, cooling, power and the gateway.');
  if (dc.dataset.html !== html) {
    dc.dataset.html = html;
    dc.innerHTML = html;
    dc.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => app.go(b.dataset.go)));
  }

  // Incidents.
  const inc = $('#incidents');
  const items = [...f.faults].reverse().slice(0, 5);
  const key = items.map((x) => x.id + (x.resolved_at ?? '')).join('|') + Math.floor(f.t / 5);
  if (inc.dataset.key !== key) {
    inc.dataset.key = key;
    inc.innerHTML = items.length ? items.map((x) => `<div class="incident ${x.resolved_at != null ? 'done' : ''}"><i></i><div><b>${esc(x.title)}</b>
      <small>${esc(x.target ?? 'hall')} · ${x.resolved_at != null ? `resolved ${clock(x.resolved_at)}` : `since ${clock(x.t)}`}${x.candidate_id ? ' · ' + esc(x.candidate_id) : ''}</small></div>
      ${x.resolved_at == null && ['network_degrade', 'crah_failure', 'power_feed_loss', 'gpu_xid', 'compound', 'worker_hang'].includes(x.kind) ? `<button class="btn small ghost" data-fix="${x.id}" title="Human field action outside the agent's authority">${x.kind === 'worker_hang' ? 'Unpause' : 'Field repair'}</button>` : ''}</div>`).join('')
      : '<p class="empty">No incidents. Try <b>Break the system</b>.</p>';
    inc.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => api(`/api/faults/${b.dataset.fix}/repair`, {})));
  }

  // Detection gap: what the dashboards saw vs what Nexus saw.
  const gap = $('#gap-card');
  const r = run;
  if (r && r.signal.fault_t != null) {
    const win = app.kpiHist.filter((x) => x.t >= r.signal.fault_t && x.t <= (r.states.at(-1)?.t ?? f.t));
    const dashAlert = win.find((x) => (x.ttft_p95 ?? 0) > slo.ttft_p95_s || x.error_rate > slo.error_rate);
    gap.innerHTML = `<h3>Detection gap</h3>
      <div class="gap-row"><span>Dashboards</span><b class="${dashAlert ? 'bad-text' : 'muted-text'}">${dashAlert ? `alerted ${clock(dashAlert.t)}` : 'no alert'}</b></div>
      <div class="gap-row"><span>Nexus Ω canary</span><b class="ok-text">alerted ${clock(r.states[0].t)}</b></div>
      <div class="gap-row"><span>Time to detect</span><b>${dur(r.states[0].t - r.signal.fault_t)}</b></div>
      <div class="gap-row"><span>${r.terminal ? 'Time to ' + STATE_LABEL[r.terminal].toLowerCase() : 'Elapsed'}</span><b>${dur((r.terminal ? r.states.at(-1).t : f.t) - r.signal.fault_t)}</b></div>
      <p class="note">${dashAlert ? 'Latency or errors breached: dashboards would have paged.' : 'Health, latency and error dashboards stayed green the whole time.'}</p>`;
  } else {
    gap.innerHTML = `<h3>Detection gap</h3><p class="empty">After an incident: when the dashboards noticed vs when Nexus Ω did.</p>`;
  }

  renderTimeline($('#mission-timeline'), app, run);
}
