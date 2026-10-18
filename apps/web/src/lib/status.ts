// System status as Nexus observes it. Uses only signals a monitor or the doctor
// can see (SLOs, canaries, facility alarms, worker health, run state), never the
// injected fault list, so the header does not "know" about a fault before it is
// detected.
import type { DoctorSnapshot, Frame } from './types';
import { OUTCOME, verifiedService } from './stages';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'replay';
export interface SystemStatus { label: string; tone: Tone; pulse: boolean }

export function systemStatus(connected: boolean, frame: Frame | null, run: DoctorSnapshot | null): SystemStatus {
  if (!connected || !frame) return { label: 'Connecting', tone: 'muted', pulse: true };
  if (run && !run.terminal) {
    if (run.awaiting_approval) return { label: 'Awaiting authorization', tone: 'warn', pulse: true };
    if (run.state === 'ACT') return { label: 'Repairing', tone: 'info', pulse: true };
    if (run.state === 'VERIFY') return { label: 'Verifying', tone: 'info', pulse: true };
    if (run.state === 'PLAN' || run.state === 'PRECHECK') return { label: 'Simulating fixes', tone: 'warn', pulse: true };
    return { label: 'Investigating', tone: 'warn', pulse: true };
  }
  const k = frame.kpi;
  const facility = frame.hall.crahs.some((c) => !c.running) || Object.values(frame.hall.ups).some((on) => !on);
  const crashed = frame.workers.some((w) => w.state === 'crashed');
  if (run?.terminal) {
    const closed = run.states[run.states.length - 1]?.t ?? 0;
    if (frame.t - closed < 90) {
      if (run.terminal === 'VERIFIED') return { label: 'Verified', tone: 'ok', pulse: false };
      if (run.terminal === 'REQUIRES_APPROVAL' && verifiedService(run)) return { label: 'Service verified · facility needs a human', tone: 'warn', pulse: false };
      const o = OUTCOME[run.terminal];
      return { label: o.label, tone: o.tone === 'muted' ? 'muted' : o.tone, pulse: false };
    }
  }
  if (facility) return { label: 'Facility alarm', tone: 'bad', pulse: true };
  if (crashed || k.error_rate > 0.01) return { label: 'Degraded', tone: 'bad', pulse: true };
  if (!k.slo_ok) return { label: 'SLO breach', tone: 'warn', pulse: true };
  if (k.canary < 0.999) return { label: 'Canary failing', tone: 'warn', pulse: true };
  return { label: 'Nominal', tone: 'ok', pulse: false };
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', muted: 'text-ink-3', replay: 'text-replay',
};
export const TONE_BG: Record<Tone, string> = {
  ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', muted: 'bg-ink-3', replay: 'bg-replay',
};
