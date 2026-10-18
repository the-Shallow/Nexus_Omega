// System status as Nexus observes it. Uses only signals a monitor or the doctor
// can see (SLOs, canaries, facility alarms, worker health, run state), never the
// injected fault list, so the dock does not "know" about a fault before it is
// detected.
import { OUTCOME, serviceVerified, type FlowRun } from './flow';
import type { DoctorSnapshot, Frame } from './types';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'replay';
export interface SystemStatus { label: string; tone: Tone; pulse: boolean }

export function systemStatus(connected: boolean, frame: Frame | null, run: DoctorSnapshot | null): SystemStatus {
  if (!connected || !frame) return { label: 'Connecting', tone: 'muted', pulse: true };
  if (run && !run.terminal) {
    if (run.awaiting_approval) return { label: 'Awaiting authorization', tone: 'warn', pulse: true };
    if (run.state === 'ACT') return { label: 'Repairing', tone: 'info', pulse: true };
    if (run.state === 'VERIFY') return { label: 'Verifying', tone: 'info', pulse: true };
    if (run.state === 'PLAN' || run.state === 'PRECHECK') return { label: 'Shadow testing', tone: 'warn', pulse: true };
    return { label: 'Investigating', tone: 'warn', pulse: true };
  }
  const k = frame.kpi;
  const facility = frame.hall.crahs.some((c) => !c.running) || Object.values(frame.hall.ups).some((on) => !on);
  const crashed = frame.workers.some((w) => w.state === 'crashed');
  if (run?.terminal) {
    const closed = run.states[run.states.length - 1]?.t ?? 0;
    if (frame.t - closed < 90) {
      if (run.terminal === 'VERIFIED') return { label: 'Verified', tone: 'ok', pulse: false };
      if (run.terminal === 'REQUIRES_APPROVAL' && serviceVerified(run.terminal_reason)) return { label: 'Service verified · facility needs a human', tone: 'warn', pulse: false };
      const o = OUTCOME[run.terminal];
      return { label: o.label, tone: o.tone === 'muted' ? 'muted' : o.tone === 'info' ? 'info' : o.tone, pulse: false };
    }
  }
  if (facility) return { label: 'Facility alarm', tone: 'bad', pulse: true };
  if (crashed || k.error_rate > 0.01) return { label: 'Degraded', tone: 'bad', pulse: true };
  // The functional canary is named before the generic SLO: it is the signal that catches silent failures.
  if (k.canary < 0.999 || k.silent_rate >= 0.01) return { label: 'Canary failing', tone: 'warn', pulse: true };
  if (!k.slo_ok) return { label: 'SLO breach', tone: 'warn', pulse: true };
  return { label: 'Nominal', tone: 'ok', pulse: false };
}

/** Status of a recorded fleet run at the replay cursor. */
export function fleetStatus(flow: FlowRun): SystemStatus {
  if (flow.terminal) {
    const o = OUTCOME[flow.terminal];
    const tone = flow.verdict?.tone ?? o.tone;
    const label = flow.verdict?.label === 'FALSE VERIFIED' ? 'False VERIFIED' : o.short;
    return { label, tone: tone === 'muted' ? 'muted' : tone === 'info' ? 'info' : tone, pulse: false };
  }
  const key = flow.stages[flow.stages.length - 1]?.key;
  if (flow.stages.some((s) => s.status === 'halted')) return { label: 'Agent failed', tone: 'bad', pulse: true };
  if (key === 'act') return { label: 'Repairing', tone: 'info', pulse: true };
  if (key === 'verify') return { label: 'Verifying', tone: 'info', pulse: true };
  if (key === 'diagnose' || key === 'tools') return { label: 'Investigating', tone: 'warn', pulse: true };
  return { label: 'Canary failing', tone: 'warn', pulse: true };
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', muted: 'text-ink-3', replay: 'text-replay',
};
export const TONE_BG: Record<Tone, string> = {
  ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', muted: 'bg-ink-3', replay: 'bg-replay',
};
export const TONE_HEX: Record<Tone, string> = {
  ok: '#76b900', warn: '#f5a524', bad: '#f43f5e', info: '#38bdf8', muted: '#6e7b83', replay: '#a78bfa',
};
