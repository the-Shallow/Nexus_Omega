// Tool-Calling Doctor view: request anatomy, raw vs parsed, serving contract, reasoning.
import { $, esc, clock } from './ui.js';
import { renderRail, renderBudget, renderStream, renderHypotheses, renderMemory, renderBranches, renderTimeline } from './doctor.js';

const PAIRS = new Set(['hermes|hermes-tools', 'qwen25_coder|qwen25-coder-tools']);
const matched = (c) => PAIRS.has(`${c.tool_parser}|${c.chat_template}`);
const CALL = '{"name": "create_ticket", "arguments": {"priority": "high", "summary": "Refund not received"}}';

export function initToolView() {
  const stages = ['Agent app', 'Gateway', 'vLLM engine', 'Model output', 'Tool parser', 'API response'];
  $('#anatomy').innerHTML = `<div class="anatomy">
    <svg viewBox="0 0 380 150" class="anat-svg">
      <path id="anat-path" d="M20 40 H 360 V 110 H 20" class="anat-line"/>
      ${stages.map((s, i) => {
        const [x, y] = i < 3 ? [20 + i * 170, 40] : [360 - (i - 3) * 170, 110];
        return `<g class="anat-node ${s === 'Tool parser' ? 'parser' : ''}" transform="translate(${x} ${y})"><circle r="9"/><text y="${i < 3 ? -16 : 28}">${s}</text></g>`;
      }).join('')}
      <circle r="6" class="anat-dot" id="anat-dot"><animateMotion dur="3.2s" repeatCount="indefinite"><mpath href="#anat-path"/></animateMotion></circle>
    </svg>
    <div class="anat-verdict" id="anat-verdict"></div></div>`;
}

export function renderToolView(app) {
  const f = app.frame;
  const run = app.doctor?.doctor === 'tool' ? app.doctor : null;
  $('#tool-title').textContent = run ? `${run.incident?.title || 'Investigating'}${run.terminal ? '' : ' · ' + run.state.replace('_', ' ').toLowerCase()}` : 'Watching tool calls';
  $('#tool-ctrl').textContent = run ? `${run.id} · controller: ${run.controller}` : 'Canaries probe every replica for real, parsed tool calls.';
  renderRail($('#tool-rail'), run, 'Idle: functional canaries run every 5 s on every replica.');
  renderBudget($('#tool-budget'), run);
  renderStream($('#tool-stream'), run, { empty: 'When a canary finds empty tool_calls on a healthy replica, every tool call, retry and policy decision appears here.' });
  $('#tool-count').textContent = run ? `${run.events.filter((e) => e.kind === 'tool_call').length} tool calls · ${run.ledger.length} evidence items` : '';
  renderHypotheses($('#tool-hyps'), run);
  renderMemory($('#tool-memory'), run);
  renderBranches($('#tool-branches'), run, {});
  renderTimeline($('#tool-timeline'), app, run);

  // Serving contract per replica (live from the twin).
  const workers = f.workers;
  const target = run?.incident?.targets?.[0] ?? workers.find((w) => !matched(w.config))?.id ?? workers[0].id;
  const w = workers.find((x) => x.id === target);
  const ok = matched(w.config);
  const ck = workers.map((x) => `${x.id}:${x.config.chat_template}:${x.state}:${x.weight}:${x.canary}`).join('|');
  const contract = $('#contract');
  if (contract.dataset.key !== ck) {
    contract.dataset.key = ck;
    contract.innerHTML = `<div class="contract">${workers.map((x) => {
      const m = matched(x.config);
      const st = x.state === 'restarting' ? 'restarting' : x.draining ? 'draining' : x.weight === 0 ? 'drained' : x.canary ? 'canary ✓' : 'canary ✗';
      return `<div class="cw ${m ? 'm' : 'x'} ${x.state === 'restarting' || x.draining ? 'busy' : ''}" title="${esc(x.config.image)}"><b>${x.id}</b><code>${esc(x.config.tool_parser)}</code><code>${esc(x.config.chat_template)}</code><small>${st}</small></div>`;
    }).join('')}</div>
    ${(f.config_log || []).length ? `<ol class="changes">${f.config_log.slice(-4).reverse().map((c) => `<li><time>${clock(c.t)}</time><span>${esc(c.worker)} · ${esc(c.source)}</span>${Object.entries(c.diff).map(([k, [a, b]]) => `<code>${esc(k)}: <s>${esc(a)}</s> → ${esc(b)}</code>`).join('')}</li>`).join('')}</ol>` : '<p class="note">No serving-config changes recorded.</p>'}`;
  }

  // Request anatomy verdict and raw vs parsed sample for the focused replica.
  const v = $('#anat-verdict');
  const vk = `${target}:${ok}`;
  if (v.dataset.key !== vk) {
    v.dataset.key = vk;
    $('#anatomy .anatomy').classList.toggle('broken', !ok);
    v.innerHTML = ok
      ? `<span class="pill ok">✓ ${esc(target)}: parser and template agree</span><span>tool_calls: [create_ticket]</span>`
      : `<span class="pill warn">✗ ${esc(target)}: call dropped at the parser</span><span>HTTP 200 · tool_calls: []</span>`;
    const raw = run?.ledger.find((e) => e.source_type === 'raw_generation')?.data;
    const sample = raw ?? {
      raw_output: ok ? `<tool_call>\n${CALL}\n</tool_call>` : CALL,
      structured_response: ok ? { content: null, tool_calls: [{ function: { name: 'create_ticket' } }], http_status: 200 } : { content: CALL, tool_calls: [], http_status: 200 },
    };
    $('#rawdiff').innerHTML = `<div class="rawdiff ${ok && !raw ? '' : 'bad'}">
      <div><span class="eyebrow">What the model wrote</span><pre>${esc(sample.raw_output)}</pre><small>${raw ? `evidence from ${esc(raw.request_id)}` : 'twin sample'}</small></div>
      <div class="arrow">→</div>
      <div><span class="eyebrow">What the client received</span><pre>${esc(JSON.stringify(sample.structured_response, null, 2))}</pre><small>${sample.structured_response.tool_calls.length ? 'structured call parsed' : 'call returned as plain text'}</small></div></div>`;
  }
}
