// Small shared helpers for every view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

let clockBase = 1 * 3600 + 47 * 60;
export const setClockBase = (s) => { clockBase = s; };
export function clock(t) {
  const s = Math.floor(clockBase + (t ?? 0)) % 86400;
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':');
}
export function mmss(t) {
  const s = Math.max(0, Math.floor(t ?? 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function dur(s) {
  if (s == null) return '–';
  s = Math.round(s);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
export const ms = (v) => (v == null ? '–' : v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`);
export const pct = (v, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);

export const STATE_LABEL = {
  INGEST: 'Ingest', DIAGNOSE: 'Diagnose', EXPAND_CONTEXT: 'Expand context', PLAN: 'Plan', PRECHECK: 'Shadow test', ACT: 'Act', VERIFY: 'Verify',
  VERIFIED: 'Verified', ROLLED_BACK: 'Rolled back', REQUIRES_APPROVAL: 'Needs approval', ABSTAIN: 'Abstained',
};
export const TERMINAL_TONE = { VERIFIED: 'ok', ROLLED_BACK: 'warn', REQUIRES_APPROVAL: 'warn', ABSTAIN: 'muted' };

export function spark(canvas, values, { color = '#76b900', line, min, max, fill = true } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) return;
  let lo = min ?? Math.min(...vals), hi = max ?? Math.max(...vals);
  if (line != null) { lo = Math.min(lo, line); hi = Math.max(hi, line); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const y = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
  const x = (i) => (i / (values.length - 1)) * w;
  if (line != null) {
    ctx.strokeStyle = '#98a2b3'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y(line)); ctx.lineTo(w, y(line)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.beginPath();
  values.forEach((v, i) => { if (v != null) ctx.lineTo(x(i), y(v)); });
  if (fill) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00');
    ctx.save(); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = g; ctx.fill(); ctx.restore();
    ctx.beginPath();
    values.forEach((v, i) => { if (v != null) ctx.lineTo(x(i), y(v)); });
  }
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}

export function toast(text, { tone = '', action = null, ttl = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').addEventListener('click', () => { action.run(); el.remove(); });
  $('#toasts').prepend(el);
  setTimeout(() => el.classList.add('out'), ttl);
  setTimeout(() => el.remove(), ttl + 400);
}

// Animate a number inside an element toward a target.
export function tween(el, to, fmt = (v) => v.toFixed(0), duration = 600) {
  const from = +el.dataset.v || 0;
  el.dataset.v = to;
  if (from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / duration);
    const e = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function json(value, max = 600) {
  const text = JSON.stringify(value, null, 2) ?? '';
  return text.length > max ? text.slice(0, max) + '\n…' : text;
}
