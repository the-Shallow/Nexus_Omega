import type {
  AgentEnvelope, BfclProfile, CapacityTable, CertificateSummary, EpisodeSummary, FaultSpec, Job, LiveStatus,
  RealFault, RealRunSnapshot, RunEvent, RunSummary, Scoreboard,
} from './types';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).detail ?? msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  faults: () => request<FaultSpec[]>('/api/faults'),
  inject: (kind: string, target?: string) => request<{ id: string; title: string; kind: string; target?: string; targets?: string[] }>('/api/faults', { kind, target }),
  control: (body: { speed?: number; paused?: boolean; reset?: boolean }) => request<{ speed: number; paused: boolean; t: number }>('/api/control', body),
  doctorConfig: (body: { autopilot?: boolean }) => request<{ autopilot: boolean }>('/api/doctors/config', body),
  repair: (faultId: string) => request<{ id: string }>(`/api/faults/${encodeURIComponent(faultId)}/repair`, {}),
  approve: (runId: string, choice: string) => request<{ choice: string }>(`/api/doctors/runs/${runId}/approve`, { choice }),
  certificate: (id: string) => request<CertificateSummary>(`/api/certificates/${id}/summary`),
  certificateUrl: (id: string) => `/api/certificates/${encodeURIComponent(id)}?download=1`,

  // Real runs (read-only): local evidence/ or the Brev box, whichever the server is pointed at.
  scoreboard: () => request<Scoreboard>('/api/results/scoreboard'),
  episodes: (q: { solver?: string; fault?: string; heldout?: boolean } = {}) =>
    request<EpisodeSummary[]>(`/api/results/episodes${query(q)}`),
  episode: (id: string) => request<Record<string, any>>(`/api/results/episodes/${id}`),
  runs: () => request<RunSummary[]>('/api/results/runs'),
  run: (id: string) => request<RealRunSnapshot>(`/api/results/runs/${encodeURIComponent(id)}`),
  runEvidence: (id: string, ev: string) => request<Record<string, any>>(`/api/results/runs/${encodeURIComponent(id)}/evidence/${encodeURIComponent(ev)}`),
  bfcl: () => request<BfclProfile[]>('/api/results/bfcl'),
  gates: () => request<Record<string, unknown[]>>('/api/results/gates'),
  capacityFiles: () => request<string[]>('/api/results/capacity'),
  capacity: (name: string) => request<CapacityTable>(`/api/results/capacity/${encodeURIComponent(name)}`),
  audit: (limit = 50) => request<Record<string, any>[]>(`/api/results/audit?limit=${limit}`),

  // Live fleet. The operator token stays on the server; these fail with 503 until it is configured.
  liveStatus: () => request<LiveStatus>('/api/live/status'),
  liveFaults: () => request<RealFault[]>('/api/live/faults'),
  breakFleet: (fault: string, solver: 'rules' | 'agent' = 'rules') => request<{ job_id: string }>('/api/live/break', { fault, solver }),
  jobs: () => request<Job[]>('/api/live/jobs'),
  job: (id: string) => request<Job>(`/api/live/jobs/${encodeURIComponent(id)}`),
};

function query(q: Record<string, string | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * Follow a real run: replays its trail, then tails it until it ends and the referee has scored it.
 * EventSource resumes from the last sequence on its own after a dropped connection.
 * Returns a function that closes the stream.
 */
export function streamRun(
  runId: string,
  on: { event?: (envelope: AgentEnvelope | null, runEvents: RunEvent[]) => void; end?: (snapshot: RealRunSnapshot) => void; error?: () => void },
): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  const handle = (m: MessageEvent) => {
    const { event, run_events } = JSON.parse(m.data);
    on.event?.(event, run_events);
  };
  es.onmessage = handle;
  es.addEventListener('referee', handle as EventListener);
  es.addEventListener('end', ((m: MessageEvent) => { on.end?.(JSON.parse(m.data)); es.close(); }) as EventListener);
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) on.error?.(); };
  return () => es.close();
}
