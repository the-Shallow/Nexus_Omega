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

// ------------------------------------------------------------------ real fleet
// Recorded runs of the Nemotron agent on the live Brev fleet (evidence/agent in git),
// served by apps/twin/server.py under /api/recordings. Played back as REPLAY only.

export interface RecordingSummary {
  id: string;
  fault: string | null;
  title: string;
  target: string | null;
  solver: string | null;
  controller: string;
  environment: string | null;
  serving_image: string | null;
  started_at: string;
  agent_ended_at: string;
  ended_at: string | null;
  agent_outcome: 'completed' | 'failed';
  failure: string | null;
  /** The run's terminal state: the executor's verdict on the agent's plan, or ABSTAIN when the agent failed. */
  terminal_state: Terminal | null;
  /** The independent referee's score (users served and root cause fixed). The agent never grades itself. */
  success: boolean | null;
  false_verified: boolean | null;
  solve_seconds: number | null;
  tool_calls: number;
  evidence_count: number;
  summary: string | null;
  action: Record<string, unknown> | null;
  /** How the referee scores this fault: workers it expects fixed, and links it expects drained for a human. */
  remedy: { fix: string[]; drain: string[]; heldout: boolean; expect_action: boolean } | null;
}

export interface AgentEvent {
  event_type: string;
  payload: Record<string, any>;
  run_id: string;
  sequence: number;
  timestamp: string;
}

export interface RouteStats { requests: number; p95_s: number; median_s: number; error_rate: number; ok: boolean }

export interface Episode {
  fault: string;
  solver: string;
  at: string;
  terminal_state: Terminal;
  success: boolean;
  false_verified: boolean;
  solve_seconds: number;
  action: Record<string, unknown> | null;
  decision: { state: string; summary: string; hypotheses: { id: string; confidence: number; supports: string[]; contradicts: string[] }[]; stop_reason: string | null; repair_plan?: Record<string, any> };
  verification: {
    users_ok: boolean; route: Record<string, RouteStats>; hidden_passed: boolean; root_fixed: boolean; faulty_worker_drained: boolean;
    /** Newer episodes: per-worker results and who is drained now. */
    root?: Record<string, boolean>; drained?: Record<string, boolean>; drained_now?: string[];
  } | null;
  executor: {
    action: string; service: string; change_id: string; started_at: string; ended_at: string; seconds: number;
    status: string; profile?: string; before?: Record<string, any>;
    verification?: { passed: boolean; health_status: number; failed_cases: unknown[] };
  } | null;
}

export interface RecordingDetail {
  summary: RecordingSummary;
  events: AgentEvent[];
  evidence: Record<string, any>;
  evidence_index: { evidence_id: string; finding: string; source: string; source_type: string; collected_at: string }[];
  episode: Episode | null;
}
