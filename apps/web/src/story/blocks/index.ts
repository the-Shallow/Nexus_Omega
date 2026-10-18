// The block grammar: every kind of thing the story shows, and how each state reads.
import { agent, human, packets } from './callers';
import { gateway, replica, substrate } from './infra';
import { certificate, doctor, gate, shadowTwin } from './nexus';
import { canary, dashboards } from './signals';
import type { Block, Family } from './types';

export type { Block, Family } from './types';

interface Spec extends Family { spacing: number; y: number; yaw: number; lift: number }

export const FAMILIES: Spec[] = [
  {
    id: 'agent', name: 'AI agent', stands: 'Tool-calling clients. They act on what the model returns.', make: () => agent(), spacing: 3.6, y: 0.6, yaw: 0, lift: 0.32,
    states: [
      { key: 'ok', label: 'Working', tone: 'ok', note: 'Sends tool calls, gets real ones back' },
      { key: 'silent', label: 'Quietly stalled', tone: 'warn', note: 'Gets 200 OK with no tool call, stops acting' },
      { key: 'bad', label: 'Erroring', tone: 'bad', note: 'Requests fail loudly' },
    ],
  },
  {
    id: 'human', name: 'Human user', stands: 'Chat and API users.', make: () => human(), spacing: 3.6, y: 0.7, yaw: 0, lift: 0.32,
    states: [
      { key: 'ok', label: 'Answered', tone: 'ok', note: 'Fast replies' },
      { key: 'silent', label: 'Waiting', tone: 'warn', note: 'Slow, nothing obviously wrong' },
      { key: 'bad', label: 'Error', tone: 'bad', note: '5xx from the service' },
    ],
  },
  {
    id: 'packets', name: 'Request & response', stands: 'Blue goes out. What comes back tells the story.', make: () => packets(), spacing: 3.4, y: 0.5, yaw: 0, lift: 0.32,
    states: [
      { key: 'ok', label: 'Answer', tone: 'ok', note: 'Solid green: real content' },
      { key: 'silent', label: 'Empty 200 OK', tone: 'warn', note: 'Hollow amber ring: tool_calls: []' },
      { key: 'bad', label: 'Failed', tone: 'bad', note: 'Dies on the way back, red sparks' },
    ],
  },
  {
    id: 'gateway', name: 'Gateway', stands: 'The front door. Fans traffic into one lane per replica.', make: () => gateway(), spacing: 6.4, y: 0.9, yaw: -0.55, lift: 0.36,
    states: [
      { key: 'ok', label: 'Routing', tone: 'ok', note: '8 lanes, even weight' },
      { key: 'drain', label: 'Draining 2 lanes', tone: 'warn', note: 'Barrier on lanes being repaired' },
      { key: 'bad', label: 'Overloaded', tone: 'bad', note: 'Queue climbs, violet packets shed' },
    ],
  },
  {
    id: 'replica', name: 'vLLM replica', stands: 'One serving unit: a rack of 4 nodes × 8 GPUs on the heat ramp.', make: () => replica(), spacing: 3.6, y: 1.15, yaw: 0, lift: 0.32,
    states: [
      { key: 'ok', label: 'Serving', tone: 'ok', note: 'Green LEDs, warm GPUs, solid answers' },
      { key: 'silent', label: 'Silently wrong', tone: 'warn', note: 'Looks healthy. Answers are hollow' },
      { key: 'bad', label: 'Broken', tone: 'bad', note: 'Shakes, earthquake rings, red' },
    ],
  },
  {
    id: 'substrate', name: 'Physical substrate', stands: 'Under the glass floor: cooling air, power and network feeding the racks.', make: () => substrate(), spacing: 3.8, y: 0.6, yaw: -0.3, lift: 0.45,
    states: [
      { key: 'ok', label: 'Cooling', tone: 'ok', note: 'Cold air, power and fibre flowing' },
      { key: 'hot', label: 'Degraded', tone: 'warn', note: 'Warm air, heat rising into the rack' },
      { key: 'bad', label: 'CRAH tripped', tone: 'bad', note: 'Fans stop, duct red, heat haze' },
    ],
  },
  {
    id: 'dashboards', name: 'Dashboards', stands: 'What operators watch: latency, errors, GPU use.', make: () => dashboards(), spacing: 4.6, y: 1.1, yaw: 0, lift: 0.32,
    states: [
      { key: 'ok', label: 'Healthy', tone: 'ok', note: 'Everything within SLO' },
      { key: 'silent', label: 'Green, but lying', tone: 'warn', note: 'Identical to healthy. The canary isn’t on it' },
      { key: 'bad', label: 'Alarm', tone: 'bad', note: 'Red numbers, spiking lines' },
    ],
  },
  {
    id: 'canary', name: 'Canary drone', stands: 'A known tool-call request flown to a replica and checked on return.', make: () => canary(), spacing: 3.8, y: 0.8, yaw: 0, lift: 0.32,
    states: [
      { key: 'probe', label: 'Probing', tone: 'info', note: 'Every 5 s, every replica' },
      { key: 'pass', label: 'Passed', tone: 'ok', note: '4/4 tool calls came back' },
      { key: 'fail', label: 'Caught it', tone: 'bad', note: 'Came back empty: the unmasking' },
    ],
  },
  {
    id: 'doctor', name: 'Doctor', stands: 'One of two doctors. Calls tools, gathers evidence, proposes a fix.', make: () => doctor(), spacing: 4.4, y: 0.9, yaw: 0, lift: 0.32,
    states: [
      { key: 'idle', label: 'Idle', tone: 'idle', note: 'Waiting for the manager to route an alarm' },
      { key: 'investigate', label: 'Investigating', tone: 'ok', note: 'Tools orbit; a beam hits what each inspects' },
      { key: 'conclude', label: 'Evidence in', tone: 'ok', note: 'Every claim cites a tool result' },
    ],
  },
  {
    id: 'twin', name: 'Shadow twin', stands: 'A violet fork of the live system. Candidate fixes race over 3 seeds.', make: () => shadowTwin(), spacing: 6.0, y: 0.6, yaw: -0.25, lift: 0.55,
    states: [
      { key: 'fork', label: 'Forking', tone: 'sim', note: 'Copying live state into the hologram' },
      { key: 'race', label: 'Racing', tone: 'sim', note: 'Band width = spread between seeds' },
      { key: 'winner', label: 'Winner picked', tone: 'ok', note: 'Green wins, red is rejected by policy' },
    ],
  },
  {
    id: 'gate', name: 'Policy gate', stands: 'Every repair passes through it before touching anything real.', make: () => gate(), spacing: 3.8, y: 1.0, yaw: -0.75, lift: 0.32,
    states: [
      { key: 'pass', label: 'Within policy', tone: 'ok', note: 'Allow-listed, within budget' },
      { key: 'await', label: 'Needs approval', tone: 'warn', note: 'Autopilot off: a human authorizes' },
      { key: 'blocked', label: 'Blocked', tone: 'bad', note: 'Outside the approved list' },
    ],
  },
  {
    id: 'certificate', name: 'Certificate', stands: 'The sealed record of what happened and what proved it.', make: () => certificate(), spacing: 3.0, y: 1.0, yaw: 0, lift: 0.32,
    states: [
      { key: 'verified', label: 'Verified', tone: 'ok', note: 'Every independent check held 10 s' },
      { key: 'human', label: 'Needs a human', tone: 'warn', note: 'Service fine, facility still broken' },
      { key: 'rolled', label: 'Rolled back', tone: 'info', note: 'Checks failed, change undone' },
    ],
  },
];

export function makeBlock(f: Family, state: string): Block {
  const b = f.make();
  b.set(state);
  return b;
}
