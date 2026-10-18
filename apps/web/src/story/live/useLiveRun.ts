// One live episode on the Brev fleet, from the button press to the referee's verdict.
//
//   starting → breaking (reset + inject, no agent run yet) → investigating (agent trail streaming)
//            → repairing (trail handed to the executor) → verdict (referee scored it) → done
//
// The operator runs the whole episode; we only start it, poll the job and follow its run.
// Compound faults run the agent twice, so we always follow the newest run id.
import { useCallback, useEffect, useState } from 'react';
import { api, streamRun } from '../../lib/api';
import type { RunEvent } from '../../lib/types';

export type Phase = 'starting' | 'breaking' | 'investigating' | 'repairing' | 'verdict' | 'done' | 'failed';

/** What the agent's tool-call canary saw on one worker. */
export interface Canary { count: number | null; status: number | null; verdict: string }

export interface LiveRun {
  fault: string;
  jobId: string | null;
  phase: Phase;
  startedAt: number;
  runIds: string[];
  events: RunEvent[];
  canary: Record<string, Canary>;
  hidden: boolean | null;
  terminal: string | null;
  success: boolean | null;
  falseVerified: boolean | null;
  error: string | null;
  /** The run the instant replay plays: the episode's own run, else the newest one. */
  replayRun: string | null;
  jobDoneAt: number | null;
  streamEnded: string | null;
}

const TERMINAL = new Set(['run_completed', 'run_failed']);
const BREAK_TIMEOUT_MS = 6 * 60_000;
/** After the job is done, how long to wait for the run's stream to close before replaying anyway. */
const SETTLE_MS = 30_000;

export function useLiveRun() {
  const [run, setRun] = useState<LiveRun | null>(null);
  const patch = useCallback((p: Partial<LiveRun> | ((r: LiveRun) => Partial<LiveRun>)) =>
    setRun((r) => (r ? { ...r, ...(typeof p === 'function' ? p(r) : p) } : r)), []);

  const start = useCallback(async (fault: string) => {
    setRun({
      fault, jobId: null, phase: 'starting', startedAt: Date.now(), runIds: [], events: [], canary: {}, hidden: null,
      terminal: null, success: null, falseVerified: null, error: null, replayRun: null, jobDoneAt: null, streamEnded: null,
    });
    try {
      const { job_id } = await api.breakFleet(fault, 'agent');
      patch({ jobId: job_id, phase: 'breaking' });
    } catch (e) {
      const msg = (e as Error).message;
      patch({
        phase: 'failed',
        error: /still (queued|running)/.test(msg) ? 'A run is already in progress on the fleet. Wait for it to finish.' : `Couldn’t start the fault: ${msg}`,
      });
    }
  }, [patch]);
  const clear = useCallback(() => setRun(null), []);

  // Poll the job: new run ids, and how the episode ended.
  const jobId = run?.jobId ?? null;
  const settled = !run || run.phase === 'done' || run.phase === 'failed';
  useEffect(() => {
    if (!jobId || settled) return;
    let alive = true;
    const poll = () => api.job(jobId).then((job) => {
      if (!alive) return;
      setRun((r) => {
        if (!r || r.jobId !== jobId || r.phase === 'done' || r.phase === 'failed') return r;
        const next = { ...r };
        if (job.run_ids.length && job.run_ids.join() !== r.runIds.join()) next.runIds = job.run_ids;
        if (job.state === 'failed') {
          next.phase = 'failed';
          next.error = job.error ?? 'The episode failed on the box.';
        } else if (job.state === 'done') {
          next.jobDoneAt = r.jobDoneAt ?? Date.now();
          const ep = job.episode;
          if (ep) Object.assign(next, { terminal: ep.terminal_state, success: ep.success, falseVerified: ep.false_verified });
          next.replayRun = ep?.run_id ?? job.run_ids.at(-1) ?? null;
          if (!job.run_ids.length) { next.phase = 'failed'; next.error = 'The episode finished without an agent run.'; }
        } else if (!job.run_ids.length && Date.now() - r.startedAt > BREAK_TIMEOUT_MS) {
          next.phase = 'failed';
          next.error = 'No agent run started within 6 minutes.';
        }
        return next;
      });
    }).catch(() => { /* a dropped poll is retried on the next tick */ });
    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [jobId, settled]);

  // Follow the newest agent run as it streams.
  const runId = run?.runIds.at(-1) ?? null;
  useEffect(() => {
    if (!runId) return;
    patch((r) => (r.phase !== 'done' && r.phase !== 'failed' && !r.jobDoneAt ? { phase: 'investigating' } : {}));
    const probed = new Set<string>();
    return streamRun(runId, {
      event: (envelope, runEvents) => {
        patch((r) => {
          const next: Partial<LiveRun> = { events: [...r.events, ...runEvents] };
          if (envelope && TERMINAL.has(envelope.event_type) && r.phase === 'investigating') next.phase = 'repairing';
          if (!envelope) {
            // The referee's view, appended from the episode record.
            if (r.phase !== 'done' && r.phase !== 'failed') next.phase = 'verdict';
            const v = runEvents.find((e) => e.kind === 'verify')?.detail?.verification;
            if (v && 'hidden_passed' in v) next.hidden = !!v.hidden_passed;
            const t = runEvents.find((e) => e.kind === 'terminal');
            if (t) Object.assign(next, { success: t.detail.success ?? r.success, falseVerified: t.detail.false_verified ?? r.falseVerified });
          }
          return next;
        });
        // The agent's opening probes include one tool-call canary per worker: read what it saw.
        for (const e of runEvents) {
          const id = e.detail?.evidence_id;
          if (e.kind !== 'evidence' || !id || probed.has(id) || !String(e.detail?.source ?? '').startsWith('probe:')) continue;
          probed.add(id);
          api.runEvidence(runId, id).then((ev) => {
            const d = ev?.content?.data;
            if (d?.probe_id !== 'tool-call-visible' || !d.resource_id) return;
            patch((r) => ({ canary: { ...r.canary, [d.resource_id]: { count: d.structured_tool_call_count ?? null, status: d.http_status ?? null, verdict: d.verdict ?? '' } } }));
          }).catch(() => {});
        }
      },
      end: (snap) => patch((r) => ({ streamEnded: runId, terminal: r.terminal ?? snap.terminal })),
    });
  }, [runId, patch]);

  // Done once the job has finished and its last run's stream has closed (or after a short wait).
  const doneAt = run?.jobDoneAt ?? null;
  const ended = run?.streamEnded ?? null;
  const replayRun = run?.replayRun ?? null;
  useEffect(() => {
    if (settled || !doneAt || !replayRun) return;
    if (ended && ended === runId) { patch({ phase: 'done' }); return; }
    const t = setTimeout(() => patch({ phase: 'done' }), Math.max(0, SETTLE_MS - (Date.now() - doneAt)));
    return () => clearTimeout(t);
  }, [settled, doneAt, ended, replayRun, runId, patch]);

  return { run, start, clear };
}
