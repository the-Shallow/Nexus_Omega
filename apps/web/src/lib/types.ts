// Contracts of the FastAPI twin (apps/twin/server.py, nexus/simulator/telemetry.py,
// nexus/doctors/base.py). Field names match the backend JSON exactly.

export interface Topology {
  profile: string;
  title: string;
  calibration: { source: string; confidence: string; notes: string };
  hall: { rows: string[]; racks_per_row: number; nodes_per_rack: number; gpus_per_node: number };
  gpu: { model: string; tdp_w: number; slowdown_c: number; shutdown_c: number };
  slo: { ttft_p95_s: number; tpot_p95_s: number; error_rate: number };
  model_label: string;
  racks: { id: string; row: string; index: number; nodes: string[] }[];
  nodes: { id: string; rack: string; slot: number; role: 'inference' | 'batch'; worker: string | null; gpus: number[] }[];
  workers: { id: string; node: string }[];
  crahs: { id: string; row: string; capacity_kw: number }[];
  ups: string[];
  clock_base_s: number;
  base_rps: number;
}

export interface Kpi {
  t: number;
  rps_in: number;
  ttft_p50: number | null;
  ttft_p95: number | null;
  tpot_p95: number | null;
  error_rate: number;
  silent_rate: number;
  tps: number;
  queue: number;
  running: number;
  canary: number;
  capacity: number;
  it_kw: number;
  cooling_kw: number;
  pue: number;
  supply_c: number;
  max_gpu_c: number;
  throttled: number;
  slo_ok: boolean;
}

export interface WorkerFrame {
  id: string;
  state: 'ready' | 'crashed' | 'restarting' | 'hung' | 'cordoned' | string;
  healthy: boolean;
  weight: number;
  running: number;
  waiting: number;
  kv: number;
  ttft_p95: number | null;
  rps: number;
  error_rate: number;
  silent: number;
  tps: number;
  canary: boolean;
  tool_ok: boolean;
  restarts: number;
  ready_in: number | null;
  draining: boolean;
  config: { image: string; tool_parser: string; chat_template: string };
}

export interface FaultRecord {
  id: string;
  kind: string;
  title: string;
  target?: string | null;
  targets?: string[];
  candidate_id?: string | null;
  t: number;
  resolved_at?: number | null;
}

export interface Frame {
  t: number;
  seq: number;
  kpi: Kpi;
  hall: {
    supply_c: number;
    it_kw: number;
    cooling_kw: number;
    pue: number;
    airflow: Record<string, number>;
    return_c: number;
    crahs: { id: string; running: boolean }[];
    ups: Record<string, boolean>;
  };
  racks: { id: string; inlet: number; exhaust: number; power_kw: number; capped: boolean; net: boolean }[];
  gpu: { temp: number[]; util: number[]; power: number[]; clock: number[]; flag: number[] };
  nodes: Record<string, [number, number]>;
  workers: WorkerFrame[];
  flows: Record<string, { disp: number; ok: number; err: number; silent: number }>;
  gateway: { queue: number; throttle_rps: number | null; in: number; shed: number; burst: number };
  faults: FaultRecord[];
  doctor?: DoctorSnapshot | null;
  doctors?: { enabled: boolean; autopilot: boolean; active: string | null };
  speed?: number;
  paused?: boolean;
}

export interface FaultSpec {
  kind: string;
  title: string;
  category: string;
  candidate_id: string | null;
  summary: string;
  target_type: string;
  default_target: string | null;
  upstream_url?: string;
  live_episode?: 'real' | 'hybrid' | 'simulated';
}

export type RunState =
  | 'INGEST' | 'DIAGNOSE' | 'EXPAND_CONTEXT' | 'PLAN' | 'PRECHECK' | 'ACT' | 'VERIFY'
  | Terminal;
export type Terminal = 'VERIFIED' | 'ROLLED_BACK' | 'REQUIRES_APPROVAL' | 'ABSTAIN';

export interface ToolCallRecord {
  call_id: string;
  tool: string;
  class: 'read' | 'test' | 'mutate' | string;
  arguments: Record<string, unknown>;
  reason: string;
  hypothesis: string | null;
  t: number;
  status: 'ok' | 'error';
  result?: unknown;
  error_code?: string;
  error?: string;
}

export interface RunEvent {
  seq: number;
  t: number;
  clock: string;
  state: RunState;
  kind: 'state' | 'tool_call' | 'evidence' | 'policy' | 'precheck' | 'approval' | 'action' | 'verify' | 'terminal' | 'certificate' | 'note' | 'decision' | 'plan' | string;
  title: string;
  detail: Record<string, any>;
}

export interface Candidate {
  id: string;
  label: string;
  actions: { kind: string; args?: Record<string, unknown> }[];
  slo_fraction?: number;
  final_slo_ok?: boolean;
  final_capacity?: number;
  recovered_s?: number | null;
  mean_error?: number;
  peak_ttft_p95?: number | null;
  policy?: 'allowed' | 'rejected';
  policy_reason?: string;
}

export interface Hypothesis {
  id: string;
  label: string;
  confidence: number;
  supports: string[];
  contradicts: string[];
}

export interface DoctorSnapshot {
  id: string;
  doctor: 'tool' | 'infra';
  title: string;
  controller: string;
  state: RunState;
  states: { state: RunState; t: number; clock: string }[];
  terminal: Terminal | null;
  terminal_reason: string;
  incident: { title?: string; incident_class?: string; candidate_id?: string | null; target?: string; targets?: string[] };
  signal: { doctor: string; alarms: string[]; fault_t: number | null };
  events: RunEvent[];
  hypotheses: Hypothesis[];
  ledger: { evidence_id: string; finding: string; source_type: string; source: string; collected_at: string }[];
  usage: { steps: number; context_rounds: number; tool_calls: number; mutations: number };
  budget: { max_steps: number; max_context_rounds: number; max_tool_calls: number; max_mutations: number };
  matches: { certificate_id: string; similarity: number; incident: string; repair: string; terminal_state: string }[];
  precheck: { t0: number; horizon: number; seeds: number[]; recommended?: string; candidates: Candidate[] } | null;
  chosen: string | null;
  awaiting_approval: boolean;
  autopilot: boolean;
  certificate_id: string | null;
}

export interface Certificate {
  certificate_id: string;
  doctor: 'tool' | 'infra';
  provenance: string;
  controller: string;
  issued_at: string;
  run_id: string;
  incident: DoctorSnapshot['incident'];
  diagnosis: { hypothesis: string | null; summary?: string; confidence?: number };
  timeline: {
    fault_clock: string | null;
    detected_clock: string;
    acted_clock: string | null;
    closed_clock: string;
    time_to_detect_s: number | null;
    time_to_recover_s: number;
  };
  states: DoctorSnapshot['states'];
  tool_calls: ToolCallRecord[];
  evidence: DoctorSnapshot['ledger'];
  hypotheses: Hypothesis[];
  policy: { policy: string; decision: string; reason: string }[];
  matched_certificates: DoctorSnapshot['matches'];
  precheck: { seeds: number[]; horizon: number; recommended?: string; candidates: Candidate[] } | null;
  repair: { label: string | null; actions: Candidate['actions']; change_tokens: string[]; rollback_token: string | null; rollback_exercised: boolean };
  verification: { checks: { name: string; passed: boolean; detail: string }[]; before: Kpi; after: Kpi } | null;
  prediction_vs_actual: { metric: string; samples: number; mae_s: number; points: [number, number, number][] } | null;
  dashboards_alerted: boolean;
  budget: { limits: DoctorSnapshot['budget']; used: DoctorSnapshot['usage'] };
  terminal_state: Terminal;
  terminal_reason: string;
  sha256: string;
}

export interface CertificateSummary {
  certificate: Certificate;
  notification: { channel: string; text: string; sent: boolean };
  morning: { headline: string; lines: string[] } | Record<string, unknown>;
}

/** Where the pixels on screen come from. Never shown as anything it is not. */
export type DataMode = 'live' | 'simulated' | 'replay';

// ---- Real runs from the Brev box (apps/twin/results_api.py, nexus/results/) ----------------

export interface ScoreCell { success: number; total: number; false_verified: number; median_s: number | null }

export interface ScoreBatch {
  id: string;
  label: string;
  solver: 'rules' | 'agent' | string;
  heldout?: boolean;
  from: string;
  to: string;
  faults: Record<string, ScoreCell>;
  total: ScoreCell;
}

export interface Scoreboard { batches: ScoreBatch[] }

export interface EpisodeSummary {
  id: string;
  fault: string;
  solver: string;
  heldout: boolean;
  at: string;
  terminal_state: Terminal;
  success: boolean;
  false_verified: boolean;
  solve_seconds: number | null;
  run_id: string | null;
  action: string | null;
  target: string | null;
  contaminated: boolean;
  source: string;
}

export interface RunSummary {
  run_id: string;
  started_at: string | null;
  updated_at: string | null;
  trigger: string | null;
  resources: string[];
  events: number;
  completed: boolean;
  outcome: 'run_completed' | 'run_failed' | null;
  state: string | null;
  steps: number | null;
  tool_calls: number | null;
}

/** One raw line of artifacts/agent-runs/<id>/events.jsonl. */
export interface AgentEnvelope {
  run_id: string;
  sequence: number;
  timestamp: string;
  event_type: string;
  payload: Record<string, any>;
}

/** A real run adapted to the twin's snapshot; controller is "nemotron". */
export type RealRunSnapshot = DoctorSnapshot & { episode_id: string | null };

export interface BfclProfile {
  label: string;
  port: number;
  at: string;
  by_category: Record<'simple' | 'multiple' | 'parallel' | 'irrelevance', { passed: number; total: number; score: number }>;
  tool_calling_score: number;
  overall: number;
  http_errors: number;
  file: string;
}

export interface CapacityTable { name: string; columns: string[]; rows: string[][] }

export interface LiveStatus {
  gateway: boolean;
  prometheus: boolean;
  operator: boolean;
  operator_configured: boolean;
  box: boolean;
  active_job: string | null;
  checked_at: string;
}

export interface RealFault { name: string; heldout: boolean; fix: string[]; drain: string[]; expect_action: boolean }

export interface Job {
  id: string;
  fault: string;
  solver: 'rules' | 'agent';
  state: 'queued' | 'running' | 'done' | 'failed';
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
  run_ids: string[];
  episode: Pick<EpisodeSummary, 'fault' | 'solver' | 'at' | 'terminal_state' | 'success' | 'false_verified' | 'solve_seconds' | 'run_id'> | null;
  error: string | null;
}
