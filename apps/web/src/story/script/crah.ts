// Story B: a CRAH trip (DCGM-720 class). Loud, physical, and it ends with a human,
// because software can't fix a fan. Illustrative values; nothing here is live.
import { STATUS } from '../../twin/palette';
import { BASE, type Story } from './types';

const ROW_A = (s: string) => Object.fromEntries([0, 1, 2, 3].map((k) => [`vllm-${k}`, s]));

export const crah: Story = {
  id: 'crah',
  name: 'Cooling unit trips',
  short: 'CRAH trip',
  mode: 'scripted',
  badge: 'SIMULATED · ILLUSTRATIVE DATA',
  base: BASE,
  candidates: [
    { name: 'A · throttle the gateway', fate: 'lose' },
    { name: 'B · pause batch jobs, all rows', fate: 'win' },
    { name: 'C · restart row A replicas', fate: 'policy' },
  ],
  summary: {
    outcome: 'Needs a human',
    tone: 'warn',
    rows: [['Detected', '12 s after the trip'], ['Service', 'verified, SLO held'], ['Facility', 'CRAH-1 still down'], ['Approval', 'authorized by operator'], ['Doctor', 'Infrastructure'], ['Next', 'field repair of CRAH-1']],
    note: 'Nexus protected the service and said so honestly: the cooling unit itself needs a person with tools.',
  },
  hops: [
    {
      id: 'night', room: null, cam: 'wide', title: 'A normal night', clock: '02:10:00', dur: 6,
      plain: 'It’s 2:10 AM. Eight replicas serve traffic while batch training fills the rest of the GPUs.',
      tech: '8 × vLLM · batch util 82% · supply air 18 °C',
    },
    {
      id: 'trip', room: 'gpu', cam: 'gpu-under', title: 'A cooling unit trips', clock: '02:10:41', dur: 8,
      plain: 'Under the floor, cooling unit CRAH-1 trips. Its fans stop and cold air to row A dries up.',
      tech: 'CRAH-1 running=false · supply air 18 → 27 °C',
      engineer: ['The physical layer lives under the glass: air ducts, power rails, fibre'],
      beats: [{ at: 1.4, set: { floor: 'trip' }, fx: (w) => w.wave('gpu', STATUS.bad, 2.6, 4) }],
      paths: {},
    },
    {
      id: 'heat', room: 'gpu', cam: 'gpu', title: 'Heat climbs', clock: '02:11:30', dur: 8,
      plain: 'Heat rises into row A. The GPUs slow themselves down to survive, and answers get slower.',
      tech: 'GPU 87 °C · thermal slowdown · TTFT p95 1.8 s',
      engineer: ['First-order thermal model (R_th, τ), slowdown above 87 °C'],
      beats: [{ at: 1.0, set: ROW_A('hot') }],
      paths: { 'gpu-signals': 'fault' },
    },
    {
      id: 'loud', room: 'signals', cam: 'signals', title: 'This one is loud', clock: '02:11:42', dur: 7,
      plain: 'Unlike a silent failure, this one sets off alarms: latency and temperature both breach.',
      tech: 'TTFT p95 1.8 s > 1.0 s SLO · supply air 27 °C',
      set: { dash: 'bad' },
    },
    {
      id: 'diagnose', room: 'doctors', cam: 'doctors', title: 'The Infrastructure Doctor', clock: '02:11:55', dur: 9,
      plain: 'The manager routes it to the Infrastructure Doctor. It checks the facility and the fleet, not the model.',
      tech: 'inspect_facility · query_metrics · list_workers',
      engineer: ['It localizes from tool output only, never from the injected fault'],
      set: { mgr: 'infra', 'doc-infra': 'investigate' },
      beats: [{ at: 5.6, set: { 'doc-infra': 'conclude' } }],
      paths: { 'signals-doctors': 'fault' },
    },
    {
      id: 'shadow', room: 'twin', cam: 'twin', title: 'Race the options', clock: '02:12:30', dur: 9,
      plain: 'In the shadow twin, pausing batch jobs on every row cools things fastest without touching inference.',
      tech: 'A throttle ✗ sheds users · B pause batch ✓ · C restart ✗ policy',
      set: { mgr: 'idle', twin: 'race' },
      beats: [{ at: 4.8, set: { twin: 'winner' } }],
      paths: { 'doctors-twin': 'fault' },
    },
    {
      id: 'approve', room: 'doctors', cam: 'gate', title: 'A human approves', clock: '02:13:05', dur: 6,
      plain: 'Autopilot is off for facility incidents, so the fix waits at the gate for a person to approve it.',
      tech: 'policy: facility → REQUIRES_APPROVAL · recommended: pause_batch',
      set: { gate: 'await' },
      wait: { label: 'Authorize: pause batch jobs', set: { gate: 'pass' } },
    },
    {
      id: 'act', room: 'gpu', cam: 'gpu', title: 'Shed heat, keep serving', clock: '02:13:20', dur: 9,
      plain: 'Batch work pauses. Heat drops in row A, and inference keeps serving the whole time.',
      tech: 'pause_batch(rows=A,B) · GPU 87 → 71 °C',
      beats: [{ at: 1.5, set: { floor: 'cooled' } }, { at: 4.0, set: ROW_A('ok'), fx: (w) => w.wave('gpu', STATUS.ok, 4.2, 5.5) }],
      paths: { fix: 'fix' },
    },
    {
      id: 'honest', room: 'gpu', cam: 'gpu-under', title: 'Service fine, fan still broken', clock: '02:15:02', dur: 9,
      plain: 'The service is verified. But CRAH-1 is still down, and software can’t fix a fan. Nexus says so.',
      tech: 'service checks 6/6 · CRAH-1 down · REQUIRES_APPROVAL',
      engineer: ['“Record field repair” is a human action; agents never clear facility faults'],
      set: { dash: 'ok', 'doc-infra': 'idle', twin: 'idle', gate: 'idle' },
    },
    {
      id: 'proof', room: null, cam: 'finale', title: 'The whole picture', clock: '02:15:02', dur: 12,
      plain: 'Detected in 12 seconds. The service is protected and verified, and the cooling unit is handed to a person.',
      tech: 'REQUIRES_APPROVAL · service verified · facility open',
      finale: 'human',
    },
  ],
};
