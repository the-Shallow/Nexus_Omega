let clockBase = 1 * 3600 + 47 * 60;
export const setClockBase = (s: number) => { clockBase = s; };

/** Twin time shown as time of day; twin t=0 is 01:47:00 for the "2 AM" story. */
export function clock(t: number): string {
  const s = Math.floor(clockBase + t) % 86400;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

export function dur(s: number | null | undefined): string {
  if (s == null) return '–';
  const r = Math.round(s);
  return r >= 60 ? `${Math.floor(r / 60)}m ${String(r % 60).padStart(2, '0')}s` : `${r}s`;
}

export const ms = (s: number | null | undefined) => (s == null ? '–' : s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

export function argList(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
}
