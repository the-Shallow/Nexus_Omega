// Floating inspector over the 3D twin for the selected rack, node, replica or facility unit.
import { $, esc, api, ms, toast } from './ui.js';
import { heatCss, airCss } from './palette.js';

export function renderInspector(app) {
  const el = $('#inspector');
  const sel = app.scene.selected;
  const f = app.frame;
  if (!sel || !f) { el.classList.remove('open'); el.dataset.key = ''; return; }
  el.classList.add('open');
  const b = (label, kind, args, tone = '') => `<button class="btn small ${tone}" data-act='${esc(JSON.stringify({ kind, args }))}'>${label}</button>`;
  const kv = (rows) => `<div class="kv">${rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('')}</div>`;
  const gpus = (nodeId) => {
    const nd = app.scene.nodeById.get(nodeId);
    return `<div class="gpus">${nd.gpus.map((g) => {
      const t = f.gpu.temp[g], fl = f.gpu.flag[g];
      return `<i title="${t} °C · ${f.gpu.power[g]} W" class="${fl === 3 ? 'xid' : fl ? 'thr' : ''}" style="--c:${fl === 3 ? '#c026d3' : heatCss(t)};--h:${Math.max(8, f.gpu.util[g] * 100)}%"><span>${fl === 3 ? 'XID' : t.toFixed(0)}</span></i>`;
    }).join('')}</div>`;
  };
  let title = '', sub = '', body = '', acts = '';
  if (sel.type === 'worker') {
    const w = f.workers.find((x) => x.id === sel.id);
    const node = app.scene.workerNode.get(w.id);
    title = w.id; sub = `${node} · ${w.config.image}`;
    body = kv([
      ['Engine', w.state], ['/health', w.healthy ? '200' : 'unreachable'], ['Tool canary', w.canary ? 'pass' : 'fail'], ['Parser / template', `${w.config.tool_parser} / ${w.config.chat_template}`],
      ['TTFT p95', ms(w.ttft_p95)], ['Tokens/s', w.tps.toLocaleString()], ['Running / waiting', `${w.running} / ${w.waiting}`], ['KV cache', `${Math.round(w.kv * 100)}%`],
    ]) + gpus(node);
    acts = w.state === 'cordoned' ? b('Uncordon', 'uncordon_node', { node }, 'ghost')
      : b('Drain → restart → re-admit', 'restart_worker', { worker: w.id, readmit: true }) + (w.weight > 0 ? b('Drain', 'drain_worker', { worker: w.id }, 'ghost') : b('Undrain', 'set_route_weight', { worker: w.id, weight: 1 }, 'ghost')) + b('Cordon node', 'cordon_node', { node }, 'ghost');
  } else if (sel.type === 'node') {
    const [cordoned, paused] = f.nodes[sel.id];
    title = sel.id; sub = `batch training · ${cordoned ? 'cordoned' : paused ? 'paused' : 'running'}`;
    body = gpus(sel.id);
    acts = (paused ? b('Resume job', 'resume_batch', { scope: sel.id }) : b('Pause job', 'pause_batch', { scope: sel.id })) + b('Cap 400 W', 'set_power_limit', { scope: sel.id, watts: 400 }, 'ghost');
  } else if (sel.type === 'rack') {
    const r = f.racks.find((x) => x.id === sel.id);
    title = `Rack ${r.id}`; sub = `${r.capped ? 'single feed · capped' : 'A+B feeds'} · ToR ${r.net ? 'degraded' : 'ok'}`;
    body = kv([['Inlet', `<span style="color:${airCss(r.inlet)}">${r.inlet.toFixed(1)} °C</span>`], ['Exhaust', `<span style="color:${airCss(r.exhaust)}">${r.exhaust.toFixed(1)} °C</span>`], ['Power', `${r.power_kw.toFixed(1)} kW`], ['ΔT', `${(r.exhaust - r.inlet).toFixed(1)} °C`]]);
    acts = b('Pause batch on rack', 'pause_batch', { scope: r.id }) + b('Resume batch', 'resume_batch', { scope: r.id }, 'ghost');
  } else if (sel.type === 'crah') {
    const c = f.hall.crahs.find((x) => x.id === sel.id);
    title = c.id; sub = c.running ? 'running' : 'TRIPPED';
    body = kv([['Supply air', `${f.hall.supply_c.toFixed(1)} °C`], ['Return air', `${f.hall.return_c.toFixed(1)} °C`], ['IT load', `${f.hall.it_kw.toFixed(0)} kW`], ['PUE', f.hall.pue.toFixed(2)]]);
    body += '<p class="note">Software cannot repair cooling. Doctors shed heat and escalate.</p>';
  } else if (sel.type === 'ups') {
    const on = f.hall.ups[sel.id];
    title = sel.id; sub = on ? 'online' : 'FEED LOST';
    body = kv([['Racks capped', f.racks.filter((r) => r.capped).length], ['IT load', `${f.hall.it_kw.toFixed(0)} kW`]]);
  } else if (sel.type === 'gateway') {
    title = 'Edge gateway'; sub = 'weighted routing · health every 2 s';
    body = kv([['Requests in', `${f.kpi.rps_in.toFixed(1)}/s`], ['Queue', f.kpi.queue + f.gateway.queue], ['Throttle', f.gateway.throttle_rps == null ? 'off' : `${f.gateway.throttle_rps.toFixed(0)} rps`], ['TTFT p95', ms(f.kpi.ttft_p95)]]);
    acts = f.gateway.throttle_rps == null ? b('Throttle 72 rps', 'throttle', { rps: 72 }) : b('Remove throttle', 'throttle', { rps: null }, 'ghost');
  }
  const key = `${sel.type}:${sel.id}:${acts}`;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = `<header><div><b></b><small></small></div><button class="btn ghost icon small" data-close aria-label="Close">✕</button></header><div class="ins-body"></div><div class="ins-acts">${acts}</div>`;
    el.querySelector('[data-close]').addEventListener('click', () => app.scene.select(null));
    el.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        const a = JSON.parse(btn.dataset.act);
        const change = await api('/api/actions', a);
        toast(`${a.kind} · ${change.token}`, change.reversible ? { action: { label: 'Rollback', run: () => api('/api/rollback', { token: change.token }) } } : {});
      } catch (e) {
        toast(e.message, { tone: 'bad' });
      }
    }));
  }
  el.querySelector('header b').textContent = title;
  el.querySelector('header small').textContent = sub;
  el.querySelector('.ins-body').innerHTML = body;
}
