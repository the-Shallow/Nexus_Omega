import { Twin3D } from './scene.js';
import { $, $$, esc, api, clock, mmss, toast, setClockBase, STATE_LABEL } from './ui.js';
import { DOMAINS, renderDomain } from './domains.js';
import { renderArch } from './arch.js';
import { initMission, renderMission, refreshCerts } from './mission.js';
import { initToolView, renderToolView } from './toolview.js';
import { initInfraView, renderInfraView } from './infraview.js';
import { renderInspector } from './inspector.js';
import { openProof } from './doctor.js';

const CATEGORY_COLOR = {
  'Compute & Worker Failures': '#ea580c', 'Inference & Tool-Calling Failures': '#d97706', 'Performance & Workload Failures': '#7c3aed',
  'Network & Communication Failures': '#0891b2', 'Power Cooling & Thermal Failures': '#e11d48', 'GPU & Hardware Failures': '#c026d3', 'Cascading & Compound Failures': '#db2777',
};

const app = {
  topo: null, frame: null, doctor: null, kpiHist: [], scene: null, view: 'mission', domain: 'datacenter', certs: [],
  follow: true, lastRunId: null, lastTerminal: null,
  go: (view) => setView(view),
};
window.nexus = app; // handy for demos and debugging

function setView(view) {
  app.view = view;
  document.body.className = `view-${view}`;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  for (const v of ['mission', 'tool', 'infra', 'arch', 'domain']) $(`#view-${v}`).classList.toggle('on', v === view);
  const host = view === 'mission' ? $('#mission-stage') : view === 'infra' ? $('#infra-stage') : null;
  const stage = $('#stage');
  if (host) host.appendChild(stage);
  else document.body.appendChild(stage);
  stage.classList.toggle('parked', !host);
  if (view === 'arch' && !$('#view-arch').children.length) renderArch($('#view-arch'));
  if (app.frame) render();
}

function setDomain(id) {
  app.domain = id;
  const d = DOMAINS.find((x) => x.id === id);
  $('#domain-name').textContent = d.name;
  $('#domain-sw').style.background = d.color;
  $('#domain-menu').classList.remove('open');
  if (id === 'datacenter') return setView(app.view === 'domain' ? 'mission' : app.view);
  renderDomain($('#view-domain'), id);
  setView('domain');
}

function render() {
  if (!app.frame) return;
  $('#clock').textContent = clock(app.frame.t);
  $('#clock').title = `twin T+${mmss(app.frame.t)}`;
  $$('#speed button').forEach((b) => b.classList.toggle('on', app.frame.paused ? b.dataset.speed === '0' : !app.frame.paused && +b.dataset.speed === app.frame.speed));
  const run = app.doctor;
  for (const d of ['tool', 'infra']) $(`#dot-${d}`).className = `dot ${run && run.doctor === d && !run.terminal ? 'live' : ''}`;
  if (app.view === 'mission') renderMission(app);
  else if (app.view === 'tool') renderToolView(app);
  else if (app.view === 'infra') renderInfraView(app);
  if (app.view === 'mission' || app.view === 'infra') renderInspector(app);
}

function onDoctor(snap) {
  app.doctor = snap;
  if (!snap) return;
  if (snap.id !== app.lastRunId) {
    app.lastRunId = snap.id;
    app.lastTerminal = null;
    const target = snap.doctor === 'tool' ? 'tool' : 'infra';
    if (app.follow && app.view !== 'arch' && app.view !== 'domain') setTimeout(() => setView(target), 900);
    toast(`${snap.title} engaged · ${snap.signal.alarms.join(', ')}`, { action: { label: 'Open', run: () => setView(target) } });
  }
  if (snap.terminal && app.lastTerminal !== snap.terminal) {
    app.lastTerminal = snap.terminal;
    refreshCerts(app);
    if (snap.certificate_id) toast(`${STATE_LABEL[snap.terminal]} · certificate issued`, { tone: snap.terminal === 'VERIFIED' ? 'ok' : 'warn', action: { label: 'View proof', run: () => openProof(snap.certificate_id) }, ttl: 9000 });
  }
}

let lastRender = 0;
function connect(delay = 500) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'hello') {
      if (!app.scene) boot(data.topology);
      return;
    }
    if (!app.scene) return;
    app.frame = data;
    if (data.kpi && data.kpi.t !== app.kpiHist.at(-1)?.t) {
      app.kpiHist.push(data.kpi);
      if (app.kpiHist.length > 1200) app.kpiHist.shift();
    }
    if ('doctor' in data) onDoctor(data.doctor);
    $('#autopilot').checked = data.doctors?.autopilot ?? true;
    app.scene.update(data);
    const now = performance.now();
    if (now - lastRender > 240 || 'doctor' in data) {
      lastRender = now;
      render();
    }
  };
  ws.onclose = () => setTimeout(() => connect(Math.min(delay * 2, 5000)), delay);
}

function boot(topo) {
  app.topo = topo;
  setClockBase(topo.clock_base_s);
  app.scene = new Twin3D($('#stage'), topo);
  app.scene.on('select', () => renderInspector(app));
  app.scene.on('cinematic', (on) => $('[data-toggle="cinematic"]').classList.toggle('on', on));
  initMission(app);
  initToolView(app);
  initInfraView(app);
  bindChrome();
  loadChaos();
  setView('mission');
}

async function loadChaos() {
  const catalog = await api('/api/faults');
  const groups = [
    ['Tool-Calling Doctor', catalog.filter((e) => e.kind === 'tool_parser')],
    ['Infrastructure Doctor', catalog.filter((e) => e.kind !== 'tool_parser')],
  ];
  const badge = (e) => (e.live_episode === 'real' ? '<span class="pill ok" title="A reproducible episode exists on the live target">real episode</span>'
    : e.live_episode === 'hybrid' ? '<span class="pill info">hybrid</span>' : '<span class="pill warn">sim-only</span>');
  $('#chaos').innerHTML = groups.map(([name, items]) => `<span class="eyebrow">${name}</span><div class="chaos-grid">${items.map((e) => `
    <button class="chaos-card" data-kind="${e.kind}" style="--cat:${CATEGORY_COLOR[e.category] ?? '#0891b2'}">
      <div class="cc-top"><b>${esc(e.title)}</b><svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg></div>
      <p>${esc(e.summary)}</p>
      <div class="chips">${badge(e)}${e.candidate_id ? `<span class="pill muted">${esc(e.candidate_id)}</span>` : ''}${e.default_target ? `<span class="pill muted">→ ${esc(e.default_target.includes(',') ? e.default_target.split(',').length + ' replicas' : e.default_target)}</span>` : ''}</div>
    </button>`).join('')}</div>`).join('');
  $$('#chaos [data-kind]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const f = await api('/api/faults', { kind: b.dataset.kind });
      $('#drawer').classList.remove('open');
      toast(`Injected: ${f.title}${f.target ? ' → ' + f.target : ''}`, { tone: 'bad' });
      if (app.view === 'mission' || app.view === 'infra') {
        const t = f.targets?.[0];
        if (f.kind === 'crah_failure') app.scene.focus('crah', t);
        else if (f.kind === 'power_feed_loss') app.scene.preset('power');
        else if (f.kind === 'traffic_burst') app.scene.preset('network');
        else if (f.kind === 'tool_parser') app.scene.preset('cold');
        else if (app.scene.workerNode.has(t)) app.scene.focus('worker', t);
        else if (app.scene.nodeById.has(t)) app.scene.focus('node', t);
        else if (app.scene.rackById.has(t)) app.scene.focus('rack', t);
      }
    } catch (e) {
      toast(e.message, { tone: 'bad' });
    }
  }));
}

function bindChrome() {
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => { if (app.domain !== 'datacenter') setDomain('datacenter'); setView(b.dataset.view); }));
  $('#break-btn').addEventListener('click', () => $('#drawer').classList.add('open'));
  $('#drawer-close').addEventListener('click', () => $('#drawer').classList.remove('open'));
  $('#autopilot').addEventListener('change', (e) => api('/api/doctors/config', { autopilot: e.target.checked }).then(() => toast(e.target.checked ? 'Autopilot on: doctors act within policy' : 'Autopilot off: doctors stop at the shadow test for your authorization')));
  $$('#speed button').forEach((b) => b.addEventListener('click', () => {
    const s = +b.dataset.speed;
    api('/api/control', s === 0 ? { paused: true } : { speed: s, paused: false });
  }));
  const reset = () => {
    if (!confirm('Reset the twin to a healthy fleet? Certificates are kept as incident memory.')) return;
    api('/api/control', { reset: true, speed: 1, paused: false }).then(() => {
      app.kpiHist = [];
      app.doctor = null;
      app.lastRunId = null;
      app.scene.select(null);
      setView('mission');
      app.scene.preset('overview');
      toast('Twin reset: healthy fleet');
    });
  };
  $('#reset').addEventListener('click', reset);
  $$('#cams button').forEach((b) => b.addEventListener('click', () => app.scene.preset(b.dataset.cam)));
  const toggles = {
    cinematic: () => app.scene.setCinematic(!app.scene.cinematic),
    thermal: (btn) => { app.scene.setThermal(!app.scene.thermal); btn.classList.toggle('on', app.scene.thermal); },
    labels: (btn) => { const on = !btn.classList.contains('on'); app.scene.setLabels(on); btn.classList.toggle('on', on); },
  };
  $$('[data-toggle]').forEach((b) => b.addEventListener('click', () => toggles[b.dataset.toggle](b)));

  const menu = $('#domain-menu');
  menu.innerHTML = DOMAINS.map((d) => `<button data-domain="${d.id}"><span class="sw" style="background:${d.color}"></span><div><b>${d.name}</b><small>${d.blurb}</small></div><span class="pill ${d.status === 'live' ? 'ok' : 'muted'}">${d.status}</span></button>`).join('');
  $('#domain-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
  $$('[data-domain]', menu).forEach((b) => b.addEventListener('click', () => setDomain(b.dataset.domain)));
  $('#domain-sw').style.background = DOMAINS[0].color;

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const views = ['mission', 'tool', 'infra', 'arch'];
    if (e.key >= '1' && e.key <= '4') setView(views[+e.key - 1]);
    else if (e.key === 'b' || e.key === 'B') $('#drawer').classList.toggle('open');
    else if (e.key === 'c' || e.key === 'C') toggles.cinematic();
    else if (e.key === 'r' || e.key === 'R') reset();
    else if (e.key === 'Escape') { $('#drawer').classList.remove('open'); $('#proof').classList.remove('open'); app.scene.select(null); }
    else if (e.key === ' ') { e.preventDefault(); api('/api/control', { paused: !app.frame?.paused }); }
  });
}

connect();
