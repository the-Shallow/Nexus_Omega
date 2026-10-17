// Infrastructure Doctor view: live twin, diagnosis, shadow-twin branches, reasoning.
import { $, api, toast } from './ui.js';
import { renderRail, renderBudget, renderStream, renderHypotheses, renderMemory, renderBranches, renderTimeline, approve } from './doctor.js';

let manual = null;

export function initInfraView(app) {
  $('#manual-preview').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Forking twin…';
    try {
      manual = await api('/api/preview', {});
      manual.tApplied = null;
      renderInfraView(app);
    } catch (err) {
      toast(err.message, { tone: 'bad' });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run what-if now';
    }
  });
}

export function renderInfraView(app) {
  const run = app.doctor?.doctor === 'infra' ? app.doctor : null;
  $('#infra-title').textContent = run ? `${run.incident?.title || run.signal.alarms.join(' · ')}` : 'Watching the fleet';
  $('#infra-ctrl').textContent = run ? `${run.id} · controller: ${run.controller}` : 'GPU, cooling, power, network and gateway telemetry.';
  renderRail($('#infra-rail'), run, 'Idle: watching SLOs, DCGM fields, cooling, power and the gateway.');
  renderBudget($('#infra-budget'), run);
  renderStream($('#infra-stream'), run, { empty: 'Break something: every tool call the doctor makes against the twin, and why, appears here.' });
  $('#infra-count').textContent = run ? `${run.events.filter((e) => e.kind === 'tool_call').length} tool calls · ${run.ledger.length} evidence items` : '';
  renderHypotheses($('#infra-hyps'), run);
  renderMemory($('#infra-memory'), run);

  const useRun = run?.precheck && (!manual || manual.t0 < run.precheck.t0);
  renderBranches($('#infra-branches'), useRun || !manual ? run : null, {
    manual: useRun ? undefined : manual,
    onApply: useRun && !run.awaiting_approval ? undefined : async (c) => {
      if (useRun && run.awaiting_approval) return approve(run.id, c.id);
      try {
        for (const a of c.actions) await api('/api/actions', a);
        toast(`Applied: ${c.label}`);
      } catch (err) {
        toast(err.message, { tone: 'bad' });
      }
    },
  });
  renderTimeline($('#infra-timeline'), app, run);
}
