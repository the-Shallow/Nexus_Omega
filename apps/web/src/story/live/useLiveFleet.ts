// The real fleet, once a second, from the UI server's live socket (apps/twin/live.py).
// Nothing here is derived or smoothed: a null means the box didn't report it.
import { useEffect, useState } from 'react';

export interface LiveWorker {
  id: string;
  state: string | null;
  draining: boolean | null;
  rps: number | null;
  error_rate: number | null;
  ttft_p95: number | null;
}

export interface LiveFrame {
  workers: LiveWorker[];
  kpi: { slo_ok: boolean | null; error_rate: number | null; ttft_p95: number | null; rps_in: number | null; max_gpu_c: number | null };
  gpu: { power: (number | null)[]; temp: (number | null)[]; util: (number | null)[] };
  sources: { gateway: boolean; prometheus: boolean; operator: boolean };
}

export function useLiveFleet(enabled: boolean): LiveFrame | null {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  useEffect(() => {
    if (!enabled) { setFrame(null); return; }
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const open = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?source=live`);
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        // The socket names workers a/b; the world and the agent's probes call them target-a/target-b.
        if (msg.type !== 'hello' && msg.workers) {
          setFrame({ ...msg, workers: msg.workers.map((w: LiveWorker) => ({ ...w, id: w.id.startsWith('target-') ? w.id : `target-${w.id}` })) } as LiveFrame);
        }
      };
      ws.onclose = () => { if (!closed) retry = setTimeout(open, 2000); };
    };
    open();
    return () => { closed = true; clearTimeout(retry); ws?.close(); };
  }, [enabled]);
  return frame;
}
