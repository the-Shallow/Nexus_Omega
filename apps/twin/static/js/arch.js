// Architecture Explorer: the platform pipeline and the technology layer under it.
import { $, esc } from './ui.js';

const NODES = [
  { id: 'org', x: 100, y: 250, title: 'Organization', sub: 'SLOs · policy · approvals', status: 'built',
    body: 'Operators set SLOs and automatic-repair policy, authorize out-of-policy actions, and receive the recovery certificate.',
    io: ['In: certificates, approval requests', 'Out: policy, autopilot on/off, approvals'], api: ['POST /api/doctors/config', 'POST /api/doctors/runs/{id}/approve'] },
  { id: 'twin', x: 290, y: 250, title: 'Digital Twin', sub: 'operational · SimPy · 3D', status: 'built',
    body: 'SimPy model of the inference pod: request flow, continuous batching, KV cache, GPU power and thermals, rack feeds, cooling. Exposes DCGM and vLLM metric names so tools read it like the live target.',
    io: ['In: profile (uncalibrated), faults, actions', 'Out: 10 Hz frames, Prometheus text'], api: ['WS /ws', 'GET /metrics', 'POST /api/faults'] },
  { id: 'ctrl', x: 480, y: 250, title: 'Nemotron Controller', sub: 'small model + state machine', status: 'live',
    body: 'NVIDIA Nemotron 3.5 Lightning selects tools and proposes repairs on the Brev fleet; a deterministic controller owns the state machine, budgets, policy and audit log. In this twin view the doctors run a rule-based stand-in with the same contract.',
    io: ['In: evidence bundle, tool results', 'Out: schema-valid decisions, tool requests'], api: ['nexus/agent (Checkpoint 0)', 'nexus/doctors/base.py (stand-in)'] },
  { id: 'runtime', x: 670, y: 250, title: 'Tool-Calling Runtime', sub: 'typed · allow-listed', status: 'built',
    body: 'Validates every tool call against its schema, enforces read / test / mutate classes per state, applies budgets, records an append-only audit trail. No generic shell or HTTP client.',
    io: ['In: tool requests', 'Out: results, policy decisions'], api: ['nexus/agent/tools.py', 'nexus/doctors/tools.py'] },
  { id: 'tooldoc', x: 880, y: 140, title: 'Tool-Calling Doctor', sub: 'tool collection', status: 'built', accent: true,
    body: 'Tools for silent tool-call failures: canary, serving config, change history, raw generation, parser logs, incident memory, matched parser/template patch. Same controller as the Infrastructure Doctor.',
    io: ['run_canary · read_serving_config · get_change_history', 'read_raw_generation · read_logs · patch_serving_config'], api: [] },
  { id: 'infradoc', x: 880, y: 360, title: 'Infrastructure Doctor', sub: 'tool collection', status: 'built', accent: true,
    body: 'Tools for process, capacity, network, GPU and facility failures. Contains impact (drain, throttle, cap power, cordon) and escalates what software cannot fix.',
    io: ['list_workers · query_metrics · inspect_facility', 'inspect_gpu · inspect_network · restart / drain / throttle / cordon'], api: [] },
  { id: 'sim', x: 1090, y: 250, title: 'Simulate & Recover', sub: 'fork · compare · act', status: 'built',
    body: 'PRECHECK forks the twin and races each candidate over 3 seeds. ACT applies one allow-listed change set with rollback tokens.',
    io: ['In: candidate actions', 'Out: ranked predictions, change tokens'], api: ['POST /api/preview', 'POST /api/actions', 'POST /api/rollback'] },
  { id: 'verify', x: 1280, y: 250, title: 'Verification', sub: 'independent · deterministic', status: 'built',
    body: 'Functional canary, hidden canary set, TTFT / TPOT / error SLOs, policy compliance. Failure triggers automatic rollback.',
    io: ['In: live (twin) telemetry', 'Out: VERIFIED · ROLLED_BACK · REQUIRES_APPROVAL · ABSTAIN'], api: [] },
  { id: 'cert', x: 1460, y: 250, title: 'Recovery Certificate', sub: 'JSON · sha256 · memory', status: 'built',
    body: 'Evidence, tool calls, hypotheses, policy, prediction vs actual, before / after and the rollback token. Stored and matched by signature for future incidents.',
    io: ['In: run record', 'Out: certificate, chat preview, morning summary'], api: ['GET /api/certificates', 'GET /api/certificates/{id}'] },
];
const EDGES = [['org', 'twin'], ['twin', 'ctrl'], ['ctrl', 'runtime'], ['runtime', 'tooldoc'], ['runtime', 'infradoc'], ['tooldoc', 'sim'], ['infradoc', 'sim'], ['sim', 'verify'], ['verify', 'cert']];

const TECH = [
  ['Models', [['NVIDIA Nemotron 3.5 Lightning', 'live', 'The agent on Brev (NVFP4, 35% of the H100)'], ['Qwen2.5-Coder-7B (target)', 'live', 'Two workers being repaired, on vLLM']]],
  ['Serving', [['vLLM 0.27.1', 'live', 'Serves the agent and the targets on Brev'], ['HAProxy + admin API', 'live', 'Load balancing, drain and undrain'], ['guidellm', 'live', 'Capacity sweeps']]],
  ['Simulation & evaluation', [['SimPy digital twin', 'built', 'Uncalibrated profile'], ['Doctor runtime + certificates', 'built', 'Rule-based stand-in reasoning'], ['Episodes + referee', 'live', 'Rules vs Nemotron, held-out sets']]],
  ['Observability', [['NVIDIA DCGM exporter', 'live', 'GPU telemetry on Brev'], ['Prometheus', 'live', '5 s scrape on Brev'], ['Three.js twin view', 'built', 'This interface']]],
  ['Infrastructure', [['NVIDIA Brev', 'live', '1 × H100 PCIe 80 GB'], ['Docker Compose', 'live', 'HAProxy, gateway, Prometheus, DCGM, Toxiproxy']]],
];
const STATUS = { live: 'Live on Brev', built: 'Built in repo', progress: 'In progress', planned: 'Planned' };

export function renderArch(el) {
  const W = 168, H = 80;
  const byId = new Map(NODES.map((n) => [n.id, n]));
  const path = ([a, b]) => {
    const p = byId.get(a), q = byId.get(b);
    const x1 = p.x + W / 2, y1 = p.y, x2 = q.x - W / 2, y2 = q.y, mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };
  const edges = EDGES.map((e, i) => `<path id="e${i}" d="${path(e)}" class="edge"/>
    <circle r="4" class="dot"><animateMotion dur="${2.4 + (i % 3) * 0.3}s" repeatCount="indefinite" begin="${i * 0.25}s"><mpath href="#e${i}"/></animateMotion></circle>`).join('');
  const v = byId.get('verify'), c = byId.get('ctrl');
  const loop = `<path id="loop" d="M${v.x} ${v.y + H / 2} C ${v.x} 520, ${c.x} 520, ${c.x} ${c.y + H / 2}" class="edge loop"/>
    <text class="loop-label" x="${(v.x + c.x) / 2}" y="505">feedback · retry · rollback</text>
    <circle r="4" class="dot back"><animateMotion dur="4s" repeatCount="indefinite"><mpath href="#loop"/></animateMotion></circle>`;
  const nodes = NODES.map((n, i) => `<g class="anode ${n.accent ? 'accent' : ''} st-${n.status}" data-id="${n.id}" transform="translate(${n.x - W / 2} ${n.y - H / 2})" style="animation-delay:${i * 70}ms">
    <rect width="${W}" height="${H}" rx="14"/><text x="14" y="34" class="t">${esc(n.title)}</text><text x="14" y="55" class="s">${esc(n.sub)}</text><circle cx="${W - 16}" cy="16" r="5" class="led"/></g>`).join('');
  const bracket = `<rect x="${byId.get('tooldoc').x - W / 2 - 14}" y="${byId.get('tooldoc').y - H / 2 - 30}" width="${W + 28}" height="${byId.get('infradoc').y - byId.get('tooldoc').y + H + 44}" rx="20" class="bracket"/>
    <text x="${byId.get('tooldoc').x}" y="${byId.get('tooldoc').y - H / 2 - 12}" class="bracket-label">one model · two tool collections</text>`;
  el.innerHTML = `<div class="arch">
    <header class="arch-head"><div><span class="eyebrow">Architecture explorer</span><h2>One controller loop, two doctors, independent proof</h2></div>
      <div class="legend-st">${Object.entries(STATUS).map(([k, v]) => `<span class="st st-${k}"><i></i>${v}</span>`).join('')}</div></header>
    <div class="arch-body">
      <svg viewBox="0 0 1560 560" class="arch-svg">${bracket}${edges}${loop}${nodes}</svg>
      <aside class="arch-detail" id="arch-detail"></aside>
    </div>
    <div class="tech">${TECH.map(([group, items]) => `<div class="tech-group"><span class="eyebrow">${group}</span>${items.map(([name, st, note]) => `<div class="tech-item st-${st}"><i></i><div><b>${esc(name)}</b><small>${esc(note)}</small></div><span>${STATUS[st]}</span></div>`).join('')}</div>`).join('')}</div>
  </div>`;
  const show = (id) => {
    const n = byId.get(id);
    el.querySelectorAll('.anode').forEach((g) => g.classList.toggle('sel', g.dataset.id === id));
    $('#arch-detail', el).innerHTML = `<span class="st st-${n.status}"><i></i>${STATUS[n.status]}</span><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p>
      <span class="eyebrow">Inputs / outputs</span><ul>${n.io.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${n.api.length ? `<span class="eyebrow">Interfaces</span><ul class="mono">${n.api.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
  };
  el.querySelectorAll('.anode').forEach((g) => g.addEventListener('click', () => show(g.dataset.id)));
  show('ctrl');
}
