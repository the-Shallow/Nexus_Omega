// Maps the doctor state machine onto the six stages shown in the recovery timeline.
//
//   Detect        INGEST          the signal and the first confirming tool call
//   Investigate   DIAGNOSE        rank causes from the evidence bundle
//   Select tools  EXPAND_CONTEXT  targeted tools chosen to confirm the leading suspect
//   Simulate      PLAN, PRECHECK  candidate repairs raced in a fork of the twin
//   Repair        ACT             one allow-listed change set, with rollback tokens
//   Verify        VERIFY          independent checks decide the outcome
//
// Stage progress only moves forward: the doctor's final DIAGNOSE pass (after
// EXPAND_CONTEXT) is shown under "Select tools", where it happens.
import { argList } from './format';
import type { DoctorSnapshot, RunEvent, RunState, Terminal } from './types';

export type StageStatus = 'pending' | 'active' | 'done' | 'waiting' | 'failed' | 'halted';

export interface Stage {
  key: string;
  label: string;
  hint: string;
  status: StageStatus;
  detail: string | null;
  events: RunEvent[];
}

const DEFS: { key: string; label: string; hint: string; states: RunState[] }[] = [
  { key: 'detect', label: 'Detect', hint: 'Telemetry and canaries cross a threshold', states: ['INGEST'] },
  { key: 'investigate', label: 'Investigate', hint: 'Rank causes from the evidence', states: ['DIAGNOSE'] },
  { key: 'tools', label: 'Select tools', hint: 'Targeted tools confirm the suspect', states: ['EXPAND_CONTEXT'] },
  { key: 'simulate', label: 'Simulate', hint: 'Race candidate fixes in a shadow twin', states: ['PLAN', 'PRECHECK'] },
  { key: 'repair', label: 'Repair', hint: 'One reversible change set', states: ['ACT'] },
  { key: 'verify', label: 'Verify', hint: 'Independent checks decide', states: ['VERIFY'] },
];

const stageIndex = (s: RunState) => DEFS.findIndex((d) => d.states.includes(s));

export function eventText(e: RunEvent): string {
  switch (e.kind) {
    case 'tool_call': {
      const d = e.detail;
      return `${d.tool}(${argList(d.arguments ?? {})})${d.status === 'error' ? ` → ${d.error_code}` : ''}`;
    }
    case 'state':
      return e.detail.note || e.title;
    default:
      return e.title;
  }
}

export interface RunView {
  stages: Stage[];
  current: number;
  terminal: Terminal | null;
}

export function runView(run: DoctorSnapshot): RunView {
  const buckets: RunEvent[][] = DEFS.map(() => []);
  let current = 0;
  for (const e of run.events) {
    const i = stageIndex(e.state);
    if (i >= 0) current = Math.max(current, i);
    buckets[current].push(e);
  }
  const terminal = run.terminal;
  const stages = DEFS.map((d, i): Stage => {
    const events = buckets[i];
    const meaningful = events.filter((e) => e.kind !== 'certificate' && e.kind !== 'terminal');
    const last = meaningful[meaningful.length - 1];
    let status: StageStatus = i < current ? 'done' : i === current ? 'active' : 'pending';
    if (i === current && run.awaiting_approval) status = 'waiting';
    if (terminal && i === current) {
      if (terminal === 'VERIFIED') status = 'done';
      else if (terminal === 'ROLLED_BACK') status = 'failed';
      else if (terminal === 'REQUIRES_APPROVAL') status = d.key === 'verify' && verifiedService(run) ? 'done' : 'halted';
      else status = 'halted';
    }
    return { key: d.key, label: d.label, hint: d.hint, status, detail: last ? eventText(last) : null, events };
  });
  return { stages, current, terminal };
}

/** REQUIRES_APPROVAL after VERIFY can mean "service verified, facility needs a human". */
export function verifiedService(run: { terminal_reason: string }) {
  return run.terminal_reason.startsWith('service verified');
}

export const OUTCOME: Record<Terminal, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; line: string }> = {
  VERIFIED: { label: 'Verified recovery', tone: 'ok', line: 'Independent checks passed' },
  ROLLED_BACK: { label: 'Rolled back', tone: 'bad', line: 'Verification failed; changes restored' },
  REQUIRES_APPROVAL: { label: 'Needs a human', tone: 'warn', line: 'Outside what software can fix alone' },
  ABSTAIN: { label: 'Abstained', tone: 'muted', line: 'No safe repair found' },
};
