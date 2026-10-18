import type { CertificateSummary, FaultSpec } from './types';

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
};
