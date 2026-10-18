// HUD: KPI strip, chaos deck, incidents, inspector, event stream and the SimPy what-if panel.
import { heatCss, airCss } from './palette.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mmss = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const ms = (v) => (v == null ? '–' : v < 1 ? `${(v * 1000).toFixed(0)}<small>ms</small>` : `${v.toFixed(2)}<small>s</small>`);
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}<small>%</small>`;

const CATEGORY_COLOR = {
  'Compute & Worker Failures': '#ff8a3d',
  'Inference & Tool-Calling Failures': '#ffb020',
  'Performance & Workload Failures': '#b46bff',
  'Network & Communication Failures': '#4de8ff',
  'Power Cooling & Thermal Failures': '#ff2d55',
  'GPU & Hardware Failures': '#ff3df2',
  'Cascading & Compound Failures': '#ff5f9e',
};

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

export class Hud {
  constructor(topo, scene) {
    this.topo = topo;
    this.scene = scene;
    this.slo = topo.slo;
    this.hist = {};
    this.whist = {};
    this.lastKpiT = -1;
    this.autoFocus = true;
    this.preview = null;
    this.applied = null;
    this.wasBreached = false;
    this.okSince = null;
    this.inspectKey = '';
    this.defineKpis();
    this.buildKpis();
    $('#profile').textContent = `${topo.profile} · ${topo.calibration.confidence} confidence`;
    $('#preview').addEventListener('click', () => this.runPreview());
    scene.on('select', () => { this.inspectKey = ''; this.renderInspector(); this.renderCards(); });
    this.loadCatalog();
    this.renderInspector();
  }

  // ------------------------------------------------------------------- KPIs

  defineKpis() {
    const slo = this.slo;
    const lvl = (bad, warn) => (v) => (v == null ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : '');
    this.kpiDefs = [
      { key: 'ttft_p95', label: 'TTFT p95', fmt: ms, level: (v) => (v == null ? 'bad' : v > slo.ttft_p95_s ? 'bad' : v > 0.7 * slo.ttft_p95_s ? 'warn' : '') },
      { key: 'tpot_p95', label: 'TPOT p95', fmt: (v) => (v == null ? '–' : `${(v * 1000).toFixed(1)}<small>ms</small>`), level: (v) => (v == null ? '' : v > slo.tpot_p95_s ? 'bad' : v > 0.8 * slo.tpot_p95_s ? 'warn' : '') },
      { key: 'error_rate', label: 'Errors', fmt: (v) => pct(v, 2), level: lvl(slo.error_rate, slo.error_rate / 3) },
      { key: 'canary', label: 'Tool canary', fmt: (v) => pct(v, 0), level: (v) => (v < 0.999 ? 'bad' : '') },
      { key: 'tps', label: 'Throughput', fmt: (v) => `${(v / 1000).toFixed(1)}<small>k tok/s</small>`, level: () => '' },
      { key: 'queue', label: 'Queue', fmt: (v) => `${v}`, level: lvl(200, 20) },
      { key: 'it_kw', label: 'IT load', fmt: (v) => `${v.toFixed(0)}<small>kW</small>`, level: () => '' },
      { key: 'pue', label: 'PUE', fmt: (v) => v.toFixed(2), level: lvl(1.6, 1.45) },
      // ASHRAE recommended inlet envelope tops out at 27 °C.
      { key: 'supply_c', label: 'Supply air', fmt: (v) => `${v.toFixed(1)}<small>°C</small>`, level: lvl(32, 27) },
      { key: 'max_gpu_c', label: 'Hottest GPU', fmt: (v) => `${v.toFixed(0)}<small>°C</small>`, level: lvl(87, 80) },
      { key: 'throttled', label: 'Throttled', fmt: (v) => `${v}`, level: lvl(64, 1) },
    ];
  }

  buildKpis() {
    const root = $('#kpis');
    root.innerHTML = `<div class="kpi slo" id="kpi-slo"><div><label>Inference SLO</label><div class="v">—</div></div></div>` +
      this.kpiDefs.map((d) => `<div class="kpi" id="kpi-${d.key}"><label>${d.label}</label><div class="v">–</div><canvas width="120" height="32"></canvas></div>`).join('');
  }

  updateKpis(k) {
    const slo = $('#kpi-slo');
    slo.className = `kpi slo ${k.slo_ok ? 'ok' : 'bad'}`;
    $('.v', slo).textContent = k.slo_ok ? 'MET' : 'BREACH';
    for (const d of this.kpiDefs) {
      const el = $(`#kpi-${d.key}`);
      const v = k[d.key];
      el.className = `kpi ${d.level(v)}`;
      $('.v', el).innerHTML = v == null ? '–' : d.fmt(v);
      this.spark($('canvas', el), this.hist[d.key] || [], d.level(v));
    }
  }

  spark(canvas, values, level, opts = {}) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const vals = values.filter((v) => v != null);
    if (vals.length < 2) return;
    let lo = opts.min ?? Math.min(...vals), hi = opts.max ?? Math.max(...vals);
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const color = level === 'bad' ? '#ff2d55' : level === 'warn' ? '#ffb020' : opts.color || '#4de8ff';
    const y = (v) => h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
    const x = (i) => (i / (values.length - 1)) * w;
    if (opts.line != null) {
      ctx.strokeStyle = '#ffffff30'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, y(opts.line)); ctx.lineTo(w, y(opts.line)); ctx.stroke(); ctx.setLineDash([]);
    }
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + '55'); grad.addColorStop(1, color + '00');
    ctx.beginPath();
    values.forEach((v, i) => { if (v != null) ctx.lineTo(x(i), y(v)); });
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    values.forEach((v, i) => { if (v != null) ctx.lineTo(x(i), y(v)); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * (w > 200 ? 1 : 1.4); ctx.stroke();
  }

  // ----------------------------------------------------------------- banner

  updateBanner(k, faults) {
    const el = $('#banner');
    const active = faults.filter((f) => f.resolved_at == null);
    let cls = '', text = '';
    if (!k.slo_ok && k.silent_rate > 0.01 && k.error_rate < this.slo.error_rate) {
      cls = 'warn'; text = `SILENT FAILURE · HTTP 200 everywhere · ${(k.silent_rate * 100).toFixed(0)}% of tool calls dropped · canary ${(k.canary * 100).toFixed(0)}%`;
    } else if (!k.slo_ok && k.canary < 0.999 && k.error_rate < this.slo.error_rate && (k.ttft_p95 ?? 0) < this.slo.ttft_p95_s) {
      cls = 'warn'; text = `CANARY FAILING · latency and error dashboards look healthy`;
    } else if (!k.slo_ok) {
      const parts = [];
      if (k.ttft_p95 == null || k.ttft_p95 > this.slo.ttft_p95_s) parts.push(`TTFT p95 ${k.ttft_p95 == null ? '–' : k.ttft_p95.toFixed(2) + 's'}`);
      if (k.tpot_p95 != null && k.tpot_p95 > this.slo.tpot_p95_s) parts.push(`TPOT p95 ${(k.tpot_p95 * 1000).toFixed(0)}ms`);
      if (k.error_rate > this.slo.error_rate) parts.push(`errors ${(k.error_rate * 100).toFixed(1)}%`);
      if (k.canary < 0.999) parts.push(`canary ${(k.canary * 100).toFixed(0)}%`);
      cls = 'bad'; text = `SLO BREACH · ${parts.join(' · ')}`;
    }
    if (!k.slo_ok) { this.wasBreached = true; this.okSince = null; }
    else if (this.wasBreached) {
      this.okSince ??= k.t;
      if (k.t - this.okSince < 8) { cls = 'ok'; text = `SLO RESTORED · verified by canary, latency and error checks${active.length ? ' · underlying fault still open' : ''}`; }
      else this.wasBreached = false;
    }
    if (!cls && active.length && k.slo_ok) {
      cls = 'info'; text = `DEGRADED BUT STABLE · ${active.length} open incident${active.length > 1 ? 's' : ''} · ${(k.capacity * 100).toFixed(0)}% serving capacity`;
    }
    el.className = `banner ${cls} ${cls ? 'show' : ''}`;
    el.textContent = text;
  }

  // ------------------------------------------------------------ chaos deck

  async loadCatalog() {
    this.catalog = await api('/api/faults');
    this.renderCards();
  }

  targetFor(entry) {
    const sel = this.scene.selected;
    if (!sel) return entry.default_target;
    const nodeOf = (s) => (s.type === 'worker' ? this.scene.workerNode.get(s.id) : s.type === 'node' ? s.id : null);
    switch (entry.target_type) {
      case 'worker':
      case 'workers':
        return sel.type === 'worker' ? sel.id : entry.default_target;
      case 'node':
        return nodeOf(sel) ?? entry.default_target;
      case 'rack': {
        const n = nodeOf(sel);
        return sel.type === 'rack' ? sel.id : n ? this.scene.nodeById.get(n).rack : entry.default_target;
      }
      case 'crah':
        return sel.type === 'crah' ? sel.id : entry.default_target;
      case 'ups':
        return sel.type === 'ups' ? sel.id : entry.default_target;
      default:
        return entry.default_target;
    }
  }

  renderCards() {
    if (!this.catalog) return;
    const root = $('#cards');
    root.innerHTML = this.catalog.map((e, i) => {
      const t = this.targetFor(e);
      const live = e.live_episode === 'real' ? '<span class="chip real" title="A reproducible episode of this failure exists on the live target">REAL EPISODE</span>'
        : e.live_episode === 'hybrid' ? '<span class="chip hybrid" title="Live episode mixes real actions with simulated telemetry">HYBRID</span>'
        : '<span class="chip sim" title="This category is simulation-only in Nexus Ω">SIM-ONLY</span>';
      const src = e.upstream_url ? `<a class="chip" href="${esc(e.upstream_url)}" target="_blank" rel="noopener">${esc(e.candidate_id)}</a>` : `<span class="chip">${esc(e.provenance ?? '')}</span>`;
      const tgt = t ? `<span class="chip target">→ ${esc(t.split(',').length > 1 ? `${t.split(',').length} workers` : t)}</span>` : '';
      return `<div class="card" style="--cat:${CATEGORY_COLOR[e.category] ?? '#4de8ff'}">
        <div class="row"><b>${esc(e.title)}</b><button class="inject" data-i="${i}">Inject</button></div>
        <p>${esc(e.summary)}</p>
        <div class="meta">${live}${src}${tgt}</div></div>`;
    }).join('');
    root.querySelectorAll('.inject').forEach((b) => b.addEventListener('click', () => this.inject(this.catalog[+b.dataset.i])));
  }

  async inject(entry) {
    const target = this.targetFor(entry);
    try {
      const f = await api('/api/faults', { kind: entry.kind, target });
      this.toast(`FAULT ${f.title}${f.target ? ' → ' + f.target : ''}`);
      if (this.autoFocus) this.focusFault(f);
    } catch (e) {
      this.toast(e.message, 'err');
    }
  }

  focusFault(f) {
    const t = f.targets?.[0];
    if (f.kind === 'tool_parser') return this.scene.preset('cold');
    if (f.kind === 'traffic_burst') return this.scene.preset('network');
    if (f.kind === 'power_feed_loss') return this.scene.preset('power');
    if (f.kind === 'compound') return this.scene.preset('hot');
    if (f.kind === 'crah_failure') return this.scene.focus('crah', t);
    if (this.scene.workerNode.has(t)) return this.scene.focus('worker', t);
    if (this.scene.nodeById.has(t)) return this.scene.focus('node', t);
    if (this.scene.rackById.has(t)) return this.scene.focus('rack', t);
  }

  renderIncidents(faults, now) {
    const root = $('#incidents');
    const list = [...faults].reverse().slice(0, 6);
    if (!list.length) { root.innerHTML = '<p class="empty">No active incidents</p>'; return; }
    const key = list.map((f) => f.id + (f.resolved_at ?? '')).join('|') + Math.floor(now / 5);
    if (key === this.incKey) return;
    this.incKey = key;
    const repairable = new Set(['network_degrade', 'crah_failure', 'power_feed_loss', 'gpu_xid', 'compound', 'worker_hang']);
    root.innerHTML = list.map((f) => {
      const done = f.resolved_at != null;
      const btn = !done && repairable.has(f.kind) ? `<button data-fid="${f.id}" title="Human field action outside the agent's authority">${f.kind === 'worker_hang' ? 'Unpause' : 'Field repair'}</button>` : '';
      return `<div class="incident ${done ? 'resolved' : ''}"><div class="row"><b>${esc(f.title)}</b>${btn}</div>
        <small>${esc(f.target ?? 'hall')} · ${done ? `resolved T+${mmss(f.resolved_at)}` : `open ${mmss(now - f.t)}`}${f.candidate_id ? ' · ' + esc(f.candidate_id) : ''}</small></div>`;
    }).join('');
    root.querySelectorAll('button[data-fid]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/faults/${b.dataset.fid}/repair`, {}); } catch (e) { this.toast(e.message, 'err'); }
    }));
  }

  // -------------------------------------------------------------- inspector

  renderInspector() {
    const f = this.frame;
    const sel = this.scene.selected;
    const root = $('#inspector');
    if (!f) { root.innerHTML = '<p class="empty">Waiting for the twin…</p>'; return; }
    const key = this.actionKey(sel, f);
    if (key !== this.inspectKey) {
      this.inspectKey = key;
      root.innerHTML = `<div id="insp-live"></div><h3 style="margin-top:6px">Actions</h3><div class="actions">${this.actionButtons(sel, f)}</div>${this.inspectorNote(sel)}`;
      root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(JSON.parse(b.dataset.act))));
    }
    $('#insp-live').innerHTML = this.inspectorBody(sel, f);
    const sp = $('#insp-spark');
    if (sp) this.spark(sp, sp.dataset.series ? JSON.parse(sp.dataset.series) : [], '', { line: sp.dataset.line ? +sp.dataset.line : undefined, min: 0 });
  }

  actionKey(sel, f) {
    if (!sel) return 'hall';
    if (sel.type === 'worker') {
      const w = f.workers.find((x) => x.id === sel.id);
      return `w:${sel.id}:${w.state}:${w.weight}:${w.cap}:${w.tool_ok}`;
    }
    if (sel.type === 'node') return `n:${sel.id}:${f.nodes[sel.id].join()}`;
    if (sel.type === 'gateway') return `g:${f.gateway.throttle_rps}:${f.workers[0].cap}`;
    return `${sel.type}:${sel.id}`;
  }

  actionButtons(sel, f) {
    const b = (label, kind, args, risky = false) => `<button class="act ${risky ? 'risky' : ''}" data-act='${esc(JSON.stringify({ kind, args }))}'>${label}</button>`;
    if (!sel) return b('Pause batch row A', 'pause_batch', { scope: 'batch:A' }) + b('Resume all batch', 'resume_batch', { scope: 'batch' }) + b('Cap batch GPUs 250 W', 'set_power_limit', { scope: 'batch', watts: 250 }) + b('Reset batch power', 'set_power_limit', { scope: 'batch' });
    if (sel.type === 'worker') {
      const w = f.workers.find((x) => x.id === sel.id);
      if (w.state === 'cordoned') return b('Uncordon node', 'uncordon_node', { node: this.scene.workerNode.get(w.id) }, true);
      return [
        b('Drain → restart → re-admit', 'restart_worker', { worker: w.id, readmit: true }),
        b('Restart', 'restart_worker', { worker: w.id }, true),
        w.weight > 0 ? b('Drain', 'drain_worker', { worker: w.id }) : b('Undrain', 'set_route_weight', { worker: w.id, weight: 1 }),
        !w.tool_ok ? b('Patch parser config', 'patch_config', { workers: [w.id] }) : '',
        w.cap == null ? b('Cap 64 in-flight', 'set_concurrency', { worker: w.id, limit: 64 }) : b('Remove cap', 'set_concurrency', { worker: w.id, limit: null }),
        b('Cordon node', 'cordon_node', { node: this.scene.workerNode.get(w.id) }, true),
      ].join('');
    }
    if (sel.type === 'node') {
      const [cordoned, paused] = f.nodes[sel.id];
      return [
        paused ? b('Resume batch job', 'resume_batch', { scope: sel.id }) : b('Pause batch job', 'pause_batch', { scope: sel.id }),
        b('Cap GPUs 400 W', 'set_power_limit', { scope: sel.id, watts: 400 }),
        b('Reset power limit', 'set_power_limit', { scope: sel.id }),
        cordoned ? b('Uncordon', 'uncordon_node', { node: sel.id }, true) : b('Cordon + escalate', 'cordon_node', { node: sel.id }, true),
      ].join('');
    }
    if (sel.type === 'rack') return b('Pause batch on rack', 'pause_batch', { scope: sel.id }) + b('Resume batch on rack', 'resume_batch', { scope: sel.id }) + b('Cap rack GPUs 400 W', 'set_power_limit', { scope: sel.id, watts: 400 }) + b('Reset power', 'set_power_limit', { scope: sel.id });
    if (sel.type === 'crah') {
      const row = this.topo.crahs.find((c) => c.id === sel.id).row;
      return b(`Pause batch row ${row}`, 'pause_batch', { scope: `batch:${row}` }) + b(`Cap batch row ${row} 400 W`, 'set_power_limit', { scope: `batch:${row}`, watts: 400 }) + b(`Resume batch row ${row}`, 'resume_batch', { scope: `batch:${row}` });
    }
    if (sel.type === 'ups') return b('Cap batch GPUs 250 W', 'set_power_limit', { scope: 'batch', watts: 250 }) + b('Reset batch power', 'set_power_limit', { scope: 'batch' });
    if (sel.type === 'gateway') {
      const capped = f.workers[0].cap != null;
      return (f.gateway.throttle_rps == null ? b('Throttle 72 rps', 'throttle', { rps: 72 }) : b('Remove throttle', 'throttle', { rps: null })) +
        (capped ? b('Remove in-flight caps', 'set_concurrency', { limit: null }) : b('Cap 64 in-flight / worker', 'set_concurrency', { limit: 64 }));
    }
    return '';
  }

  inspectorNote(sel) {
    if (!sel) return `<p class="note">Click a rack, GPU node, CRAH, UPS or the gateway. Calibration: ${esc(this.topo.calibration.source)}.</p>`;
    if (sel.type === 'crah' || sel.type === 'ups') return '<p class="note">The agent cannot repair cooling or power. It can only shed heat or load and escalate. Use "Field repair" under Incidents for the human fix.</p>';
    return '';
  }

  inspectorBody(sel, f) {
    const k = f.kpi;
    const grid = (rows) => `<div class="grid">${rows.map(([a, v]) => `<div><span>${a}</span><b>${v}</b></div>`).join('')}</div>`;
    const state = (cls, text) => `<span class="state ${cls}">${esc(text)}</span>`;
    const spark = (label, series, line) => `<div class="spark-wrap"><label>${label}</label><canvas id="insp-spark" width="600" height="92" data-series='${JSON.stringify(series)}' ${line != null ? `data-line="${line}"` : ''}></canvas></div>`;
    if (!sel) {
      const t = this.topo;
      const nGpu = f.gpu.temp.length;
      return `<div class="insp-title"><b>Hall</b><span>${esc(t.title)}</span></div>
        <div class="chips">${state('ok', `${t.workers.length} vLLM replicas`)}${state('off', `${nGpu} × ${t.gpu.model}`)}${state(t.calibration.confidence === 'low' ? 'warn' : 'ok', `calibration: ${t.calibration.confidence}`)}</div>
        ${grid([
          ['IT load', `${f.hall.it_kw.toFixed(0)} kW`], ['Cooling', `${f.hall.cooling_kw.toFixed(0)} kW`],
          ['PUE', f.hall.pue.toFixed(2)], ['Supply air', `${f.hall.supply_c.toFixed(1)} °C`],
          ['Return air', `${f.hall.return_c.toFixed(1)} °C`], ['Airflow A / B', `${(f.hall.airflow.A * 100).toFixed(0)} / ${(f.hall.airflow.B * 100).toFixed(0)}%`],
          ['Requests in', `${k.rps_in.toFixed(1)}/s`], ['Running', k.running],
          ['TTFT p50', k.ttft_p50 == null ? '–' : `${(k.ttft_p50 * 1000).toFixed(0)} ms`], ['Serving capacity', `${(k.capacity * 100).toFixed(0)}%`],
        ])}
        ${spark('Hottest GPU · last 2 min', this.hist.max_gpu_c?.slice(-120) ?? [], 87)}`;
    }
    if (sel.type === 'worker') {
      const w = f.workers.find((x) => x.id === sel.id);
      const node = this.scene.nodeById.get(this.scene.workerNode.get(w.id));
      const engine = { ready: ['ok', 'engine ready'], hung: ['warn', 'engine stalled'], crashed: ['bad', 'engine crashed'], restarting: ['restart', `restarting ${Math.ceil(w.ready_in ?? 0)}s`], cordoned: ['off', 'cordoned'] }[w.state];
      return `<div class="insp-title"><b>${w.id}</b><span>${node.id} · TP${this.topo.hall.gpus_per_node}</span></div>
        <div class="chips">${state(...engine)}${state(w.healthy ? 'ok' : 'bad', w.healthy ? '/health 200' : '/health ✗')}${state(w.canary ? 'ok' : 'bad', w.canary ? 'tool canary ✓' : 'tool canary ✗')}${state(w.tool_ok ? 'ok' : 'warn', w.tool_ok ? 'parser ok' : 'parser misconfigured')}${w.weight === 0 ? state('off', 'drained') : ''}${w.cap != null ? state('warn', `cap ${w.cap}`) : ''}</div>
        ${grid([
          ['Running', w.running], ['Waiting', w.waiting], ['KV cache', `${(w.kv * 100).toFixed(0)}%`], ['TTFT p95', w.ttft_p95 == null ? '–' : `${(w.ttft_p95 * 1000).toFixed(0)} ms`],
          ['Req/s', w.rps.toFixed(1)], ['Tokens/s', w.tps.toLocaleString()], ['Errors', `${(w.error_rate * 100).toFixed(1)}%`], ['Silent drops', w.silent],
          ['Preemptions', w.preemptions], ['Restarts', w.restarts], ['SM clock', `${(w.clock * 100).toFixed(0)}%`], ['Log lines/s', w.log_rate],
        ])}
        ${this.gpuStrip(node, f)}
        ${spark('Tokens/s · last 2 min', this.whist[w.id]?.slice(-120) ?? [])}`;
    }
    if (sel.type === 'node') {
      const node = this.scene.nodeById.get(sel.id);
      const [cordoned, paused] = f.nodes[sel.id];
      const powers = node.gpus.map((g) => f.gpu.power[g]);
      return `<div class="insp-title"><b>${node.id}</b><span>batch training · rack ${node.rack}</span></div>
        <div class="chips">${cordoned ? state('off', 'cordoned') : paused ? state('off', 'job paused') : state('ok', 'job running')}</div>
        ${grid([['Node power', `${(powers.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} kW`], ['Mean util', `${(node.gpus.reduce((a, g) => a + f.gpu.util[g], 0) / node.gpus.length * 100).toFixed(0)}%`]])}
        ${this.gpuStrip(node, f)}`;
    }
    if (sel.type === 'rack') {
      const r = f.racks.find((x) => x.id === sel.id);
      const meta = this.scene.rackById.get(sel.id);
      return `<div class="insp-title"><b>Rack ${r.id}</b><span>row ${meta.row} · ${meta.nodes.length} nodes</span></div>
        <div class="chips">${r.capped ? state('warn', 'single feed · power capped') : state('ok', 'A+B feeds')}${r.net ? state('bad', 'ToR degraded') : state('ok', 'ToR ok')}</div>
        ${grid([['Inlet', `<span style="color:${airCss(r.inlet)}">${r.inlet.toFixed(1)} °C</span>`], ['Exhaust', `<span style="color:${airCss(r.exhaust)}">${r.exhaust.toFixed(1)} °C</span>`], ['Power', `${r.power_kw.toFixed(1)} kW`], ['ΔT', `${(r.exhaust - r.inlet).toFixed(1)} °C`]])}
        ${meta.nodes.slice().reverse().map((n) => this.gpuStrip(this.scene.nodeById.get(n), f, true)).join('')}`;
    }
    if (sel.type === 'crah') {
      const c = f.hall.crahs.find((x) => x.id === sel.id);
      const meta = this.topo.crahs.find((x) => x.id === sel.id);
      return `<div class="insp-title"><b>${c.id}</b><span>serves row ${meta.row} · ${meta.capacity_kw} kW</span></div>
        <div class="chips">${c.running ? state('ok', 'running') : state('bad', 'TRIPPED')}</div>
        ${grid([['Supply air', `${f.hall.supply_c.toFixed(1)} °C`], ['Return air', `${f.hall.return_c.toFixed(1)} °C`], ['Row airflow', `${((f.hall.airflow[meta.row] ?? 1) * 100).toFixed(0)}%`], ['Hall IT load', `${f.hall.it_kw.toFixed(0)} kW`]])}
        ${spark('Supply air °C · last 2 min', this.hist.supply_c?.slice(-120) ?? [], 27)}`;
    }
    if (sel.type === 'ups') {
      const on = f.hall.ups[sel.id];
      const live = Object.values(f.hall.ups).filter(Boolean).length || 1;
      return `<div class="insp-title"><b>${sel.id}</b><span>2N feed</span></div>
        <div class="chips">${on ? state('ok', 'online') : state('bad', 'FEED LOST')}</div>
        ${grid([['Load', on ? `${(f.hall.it_kw / live).toFixed(0)} kW` : '0 kW'], ['Racks capped', f.racks.filter((r) => r.capped).length]])}`;
    }
    if (sel.type === 'gateway') {
      return `<div class="insp-title"><b>Edge gateway</b><span>weighted routing · health every 2 s</span></div>
        <div class="chips">${f.gateway.throttle_rps != null ? state('warn', `throttled ${f.gateway.throttle_rps.toFixed(0)} rps`) : state('ok', 'no throttle')}${f.gateway.burst > 1 ? state('bad', `burst ×${f.gateway.burst}`) : ''}</div>
        ${grid([['Requests in', `${k.rps_in.toFixed(1)}/s`], ['Gateway queue', f.gateway.queue], ['Engine queues', k.queue - f.gateway.queue], ['Errors', `${(k.error_rate * 100).toFixed(2)}%`]])}
        ${spark('TTFT p95 (s) · last 2 min', this.hist.ttft_p95?.slice(-120) ?? [], this.slo.ttft_p95_s)}`;
    }
    return '';
  }

  gpuStrip(node, f, compact = false) {
    const gpus = node.gpus.map((g, i) => {
      const t = f.gpu.temp[g], u = f.gpu.util[g], flag = f.gpu.flag[g];
      const cls = flag === 3 ? 'xid' : flag === 1 ? 'thermal' : flag === 2 ? 'power' : '';
      return `<div class="gpu ${cls}" title="g${i}: ${t}°C · ${f.gpu.power[g]} W · clock ${(f.gpu.clock[g] * 100).toFixed(0)}%"><i style="height:${Math.max(4, u * 100)}%;--c:${flag === 3 ? '#ff3df2' : heatCss(t)}"></i><span>${flag === 3 ? 'XID' : t.toFixed(0) + '°'}</span></div>`;
    }).join('');
    const hot = Math.max(...node.gpus.map((g) => f.gpu.temp[g]));
    return `${compact ? `<div class="dcgm" style="margin:0">${node.id}</div>` : ''}<div class="gpus" ${compact ? 'style="margin:2px 0 6px"' : ''}>${gpus}</div>` +
      (compact ? '' : `<div class="dcgm">DCGM_FI_DEV_GPU_TEMP max ${hot.toFixed(0)} · DCGM_FI_DEV_POWER_USAGE ${(node.gpus.reduce((a, g) => a + f.gpu.power[g], 0) / 1000).toFixed(1)} kW</div>`);
  }

  async act(a) {
    try {
      const change = await api('/api/actions', a);
      this.inspectKey = '';
      this.toast(`${change.token} · ${a.kind}`, '', change.reversible ? change.token : null);
    } catch (e) {
      this.toast(e.message, 'err');
    }
  }

  // ----------------------------------------------------------------- what-if

  async runPreview() {
    const btn = $('#preview');
    if (btn.disabled) return;
    btn.disabled = true;
    const f = this.frame;
    const kinds = new Set((f?.faults ?? []).filter((x) => x.resolved_at == null).map((x) => x.kind));
    this.secondary = kinds.has('crah_failure') || kinds.has('compound') || kinds.has('power_feed_loss') ? { key: 'tpot_p95', label: 'TPOT p95', line: this.slo.tpot_p95_s }
      : kinds.has('traffic_burst') ? { key: 'error_rate', label: 'errors', line: this.slo.error_rate }
      : { key: 'canary', label: 'tool canary', line: 1 };
    const horizon = kinds.has('crah_failure') || kinds.has('compound') ? 300 : 180;
    $('#whatif-sub').textContent = `forking twin at T+${mmss(f?.t ?? 0)} · running candidates × 3 seeds…`;
    const started = performance.now();
    try {
      this.preview = await api('/api/preview', { horizon });
      this.applied = null;
      $('#whatif-sub').textContent = `forked at T+${mmss(this.preview.t0)} · ${this.preview.candidates.length} candidates × ${this.preview.seeds.length} seeds × ${this.preview.horizon}s in ${((performance.now() - started) / 1000).toFixed(1)}s · band = min–max across seeds`;
      this.renderCands();
    } catch (e) {
      this.toast(e.message, 'err');
      $('#whatif-sub').textContent = 'preview failed';
    } finally {
      btn.disabled = false;
    }
  }

  // One line on why the top candidate outranks the others.
  reason(c, all) {
    const better = all.filter((o) => o !== c && o.slo_fraction > c.slo_fraction);
    if (better.length && better.every((o) => o.final_capacity < c.final_capacity)) return `≈ SLO of #${all.indexOf(better[0]) + 1} at ${(c.final_capacity * 100).toFixed(0)}% capacity vs ${(better[0].final_capacity * 100).toFixed(0)}%`;
    const tie = all.find((o) => o !== c && Math.round(o.slo_fraction * 10) === Math.round(c.slo_fraction * 10));
    if (tie && c.final_capacity > tie.final_capacity) return `keeps ${(c.final_capacity * 100).toFixed(0)}% serving capacity`;
    if (tie && c.peak_gpu_c < tie.peak_gpu_c) return `coolest GPUs (${c.peak_gpu_c.toFixed(0)}°C peak)`;
    return 'best SLO compliance';
  }

  renderCands() {
    const p = this.preview;
    const root = $('#cands');
    root.innerHTML = p.candidates.map((c, i) => `
      <div class="cand ${c.id === p.recommended ? 'best' : ''} ${this.applied?.id === c.id ? 'applied' : ''}" style="animation-delay:${i * 60}ms">
        <div class="row"><span class="rank">#${i + 1}${c.id === p.recommended ? ' · RECOMMENDED' : ''}</span><span class="score" style="color:${c.slo_fraction > 0.9 ? 'var(--ok)' : c.slo_fraction > 0.5 ? 'var(--warn)' : 'var(--bad)'}">${(c.slo_fraction * 100).toFixed(0)}<small>% in SLO</small></span></div>
        <b title="${esc(c.label)}">${esc(c.label)}</b>${c.id === p.recommended ? `<span class="why">${esc(this.reason(c, p.candidates))}</span>` : ''}
        <canvas width="460" height="150" data-i="${i}"></canvas>
        <div class="stats"><span>TTFT pk <b>${c.peak_ttft_p95 == null ? '–' : c.peak_ttft_p95.toFixed(2) + 's'}</b></span><span>err <b>${(c.mean_error * 100).toFixed(1)}%</b></span><span>GPU pk <b>${c.peak_gpu_c.toFixed(0)}°</b></span><span>cap <b>${(c.final_capacity * 100).toFixed(0)}%</b></span></div>
        ${c.actions.length ? `<button class="act" data-apply="${i}">${this.applied?.id === c.id ? 'Applied · tracking actual' : 'Apply to twin'}</button>` : '<button class="act" disabled style="opacity:.4">baseline</button>'}
      </div>`).join('');
    root.querySelectorAll('canvas').forEach((cv) => this.drawCand(cv, p.candidates[+cv.dataset.i]));
    root.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', () => this.apply(p.candidates[+b.dataset.apply])));
  }

  async apply(c) {
    if (this.applied) return this.toast('A candidate is already applied from this preview', 'err');
    const age = this.frame.t - this.preview.t0;
    if (age > 15) {
      // The twin has moved on since the fork: re-run the preview before acting on it.
      this.toast(`prediction is ${age.toFixed(0)} s old · re-forking before apply`);
      await this.runPreview();
      c = this.preview?.candidates.find((x) => x.id === c.id);
      if (!c) return this.toast('candidate no longer offered after re-fork', 'err');
    }
    try {
      for (const a of c.actions) await api('/api/actions', a);
      this.applied = { id: c.id, actual: [], tApply: this.frame.t };
      this.toast(`APPLIED · ${c.label} · tracking prediction vs actual`);
      this.renderCands();
    } catch (e) {
      this.toast(e.message, 'err');
    }
  }

  drawCand(canvas, c) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const s = c.series, T = this.preview.horizon;
    const x = (t) => (t / T) * W;
    // SLO strip: share of seeds meeting the SLO each second (green = all, red = none).
    const strip = 12;
    s.slo.forEach((v, i) => {
      const t0 = s.t[i], t1 = s.t[i + 1] ?? T;
      ctx.fillStyle = v >= 0.999 ? '#2dff8f' : v > 0 ? '#ffb020' : '#ff2d55';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x(t0), 0, Math.max(1, x(t1) - x(t0)) + 0.5, strip);
    });
    ctx.globalAlpha = 1;
    const top = { y0: strip + 4, h: (H - strip - 8) * 0.56 }, bot = { y0: strip + 8 + (H - strip - 8) * 0.56, h: (H - strip - 8) * 0.44 };
    // Top: TTFT p95 on a log scale, 0.1 s – 30 s.
    const ly = (v) => top.y0 + top.h - ((Math.log10(Math.max(0.1, Math.min(30, v))) + 1) / Math.log10(300)) * top.h;
    const sec = this.secondary;
    const secMax = sec.key === 'canary' ? 1 : sec.key === 'error_rate' ? Math.max(0.05, ...s.error_rate.hi.filter((v) => v != null)) : Math.max(sec.line * 1.6, ...s[sec.key].hi.filter((v) => v != null));
    const by = (v) => bot.y0 + bot.h - (Math.min(v, secMax) / secMax) * bot.h;
    const band = (key, yf, color) => {
      const b = s[key];
      ctx.beginPath();
      s.t.forEach((t, i) => b.hi[i] != null && ctx.lineTo(x(t), yf(b.hi[i])));
      for (let i = s.t.length - 1; i >= 0; i--) if (b.lo[i] != null) ctx.lineTo(x(s.t[i]), yf(b.lo[i]));
      ctx.closePath();
      ctx.fillStyle = color + '33'; ctx.fill();
      ctx.beginPath();
      s.t.forEach((t, i) => b.mid[i] != null && ctx.lineTo(x(t), yf(b.mid[i])));
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    };
    const guide = (y, label) => {
      ctx.strokeStyle = '#ffffff40'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff70'; ctx.font = '16px JetBrains Mono, monospace'; ctx.fillText(label, 4, y - 4);
    };
    ctx.fillStyle = '#ffffff08'; ctx.fillRect(0, top.y0, W, top.h); ctx.fillRect(0, bot.y0, W, bot.h);
    guide(ly(this.slo.ttft_p95_s), 'TTFT SLO');
    guide(by(sec.line), sec.label);
    band('ttft_p95', ly, '#4de8ff');
    band(sec.key, by, '#b46bff');
    if (this.applied?.id === c.id) {
      ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x(this.applied.tApply - this.preview.t0), strip); ctx.lineTo(x(this.applied.tApply - this.preview.t0), H); ctx.stroke();
    }
    if (this.applied?.id === c.id && this.applied.actual.length > 1) {
      const line = (key, yf) => {
        ctx.beginPath();
        this.applied.actual.forEach((a) => a[key] != null && ctx.lineTo(x(a.t), yf(a[key])));
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5; ctx.shadowColor = '#fff'; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
      };
      line('ttft_p95', ly);
      line(sec.key, by);
    }
  }

  // -------------------------------------------------------------- per frame

  update(f) {
    this.frame = f;
    const k = f.kpi;
    if (k.t !== this.lastKpiT) {
      this.lastKpiT = k.t;
      for (const d of this.kpiDefs) (this.hist[d.key] ??= []).push(k[d.key]);
      for (const d of Object.values(this.hist)) if (d.length > 240) d.shift();
      for (const w of f.workers) {
        const h = (this.whist[w.id] ??= []);
        h.push(w.tps);
        if (h.length > 240) h.shift();
      }
      this.updateKpis(k);
      if (this.applied && this.preview) {
        const t = k.t - this.preview.t0;
        if (t <= this.preview.horizon) {
          this.applied.actual.push({ t, ttft_p95: k.ttft_p95, tpot_p95: k.tpot_p95, error_rate: k.error_rate, canary: k.canary });
          const i = this.preview.candidates.findIndex((c) => c.id === this.applied.id);
          const cv = document.querySelector(`#cands canvas[data-i="${i}"]`);
          if (cv) this.drawCand(cv, this.preview.candidates[i]);
        }
      }
    }
    $('#simclock').textContent = `T+${mmss(f.t)}`;
    document.querySelectorAll('#speed button').forEach((b) => b.classList.toggle('on', f.paused ? b.dataset.speed === '0' : !f.paused && +b.dataset.speed === f.speed));
    this.updateBanner(k, f.faults);
    this.renderIncidents(f.faults, f.t);
    if (!this.inspTick || performance.now() - this.inspTick > 250) {
      this.inspTick = performance.now();
      this.renderInspector();
    }
    for (const e of f.events) this.logEvent(e);
  }

  logEvent(e) {
    const ol = $('#log');
    const li = document.createElement('li');
    li.className = e.level;
    li.innerHTML = `<time>T+${mmss(e.t)}</time><span>${esc(e.msg)}</span>`;
    ol.prepend(li);
    while (ol.children.length > 80) ol.lastChild.remove();
  }

  toast(text, cls = '', rollbackToken = null) {
    const el = document.createElement('div');
    el.className = `toast ${cls}`;
    el.innerHTML = `<span>${esc(text)}</span>${rollbackToken ? '<button>Rollback</button>' : ''}`;
    if (rollbackToken) {
      el.querySelector('button').addEventListener('click', async () => {
        try { await api('/api/rollback', { token: rollbackToken }); el.remove(); this.inspectKey = ''; } catch (e) { this.toast(e.message, 'err'); }
      });
    }
    $('#toast').prepend(el);
    setTimeout(() => el.remove(), rollbackToken ? 9000 : 4000);
  }
}
