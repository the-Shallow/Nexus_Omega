// Signals: the dashboard wall (what operators see) and the canary drone (what is true).
import * as THREE from 'three';
import { STATUS } from '../../twin/palette';
import { additive, basic, canvasTex, curve, edges, glow, label, mesh, metal, sample } from '../engine/fx';
import type { Block } from './types';

const HEX = (n: number) => '#' + n.toString(16).padStart(6, '0');

interface PanelSpec { title: string; ok: string; bad: string; unit: string }
const PANELS: PanelSpec[] = [
  { title: 'TTFT p95', ok: '0.41', bad: '3.82', unit: 's' },
  { title: 'Error rate', ok: '0.0', bad: '7.9', unit: '%' },
  { title: 'GPU util', ok: '81', bad: '12', unit: '%' },
];

/** Draw one dashboard panel: title, big number, sparkline, status chip. */
function drawPanel(ctx: CanvasRenderingContext2D, p: PanelSpec, look: string, t: number) {
  const W = 512, H = 320;
  const bad = look === 'bad';
  const col = bad ? STATUS.bad : STATUS.ok;
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(20,26,30,0.92)'); g.addColorStop(1, 'rgba(9,12,14,0.92)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.roundRect(4, 4, W - 8, H - 8, 26); ctx.fill();
  ctx.strokeStyle = bad ? 'rgba(244,63,94,0.7)' : 'rgba(255,255,255,0.10)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.font = '600 26px "JetBrains Mono", monospace';
  ctx.fillStyle = '#6b7880';
  ctx.fillText(p.title.toUpperCase(), 34, 58);
  ctx.font = '600 104px "Instrument Sans Variable", sans-serif';
  ctx.fillStyle = HEX(col);
  const v = bad ? p.bad : p.ok;
  ctx.fillText(v, 32, 168);
  const vw = ctx.measureText(v).width;
  ctx.font = '500 40px "Instrument Sans Variable", sans-serif';
  ctx.fillStyle = '#a3afb7';
  ctx.fillText(p.unit, 44 + vw, 168);
  // Chip.
  ctx.font = '600 22px "JetBrains Mono", monospace';
  const chip = bad ? 'SLO BREACH' : 'WITHIN SLO';
  const cw = ctx.measureText(chip).width + 30;
  ctx.fillStyle = bad ? 'rgba(244,63,94,0.18)' : 'rgba(118,185,0,0.16)';
  ctx.beginPath(); ctx.roundRect(W - cw - 30, 30, cw, 40, 20); ctx.fill();
  ctx.fillStyle = HEX(col);
  ctx.fillText(chip, W - cw - 15, 58);
  // Sparkline.
  ctx.beginPath();
  for (let x = 0; x <= 60; x++) {
    const k = x / 60;
    let y = 0.5 + 0.12 * Math.sin(k * 9 + t * 1.3) * 0.5 + 0.05 * Math.sin(k * 23 + t * 2.1);
    if (bad && k > 0.62) y -= Math.min(0.42, (k - 0.62) * 2.4);
    ctx.lineTo(34 + k * (W - 68), 220 + y * 70);
  }
  ctx.strokeStyle = HEX(col); ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.stroke();
  // The detail that nobody looks at: canary state, tucked in the footer.
  if (look === 'silent') {
    ctx.font = '500 21px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(245,158,11,0.75)';
    ctx.fillText('canary 2/4 · not on this dashboard', 34, 300);
  }
}

/** Three floating panels in an arc. "silent" draws them green: the dashboards are lying. */
export function dashboards(): Block {
  const root = new THREE.Group();
  const panels = PANELS.map((spec, k) => {
    const { ctx, tex } = canvasTex(512, 320);
    const plane = mesh(new THREE.PlaneGeometry(1.0, 0.625), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }), undefined, false);
    const holder = new THREE.Group();
    const a = (k - 1) * 0.42;
    holder.position.set(Math.sin(a) * 1.9 - 0, 1.35 + (k === 1 ? 0.12 : 0), 1.9 - Math.cos(a) * 1.9);
    holder.rotation.y = -a;
    holder.add(plane);
    const pole = mesh(new THREE.CylinderGeometry(0.012, 0.012, holder.position.y - 0.31, 6), metal(0x2a333a), [holder.position.x, (holder.position.y - 0.31) / 2, holder.position.z]);
    root.add(holder, pole);
    return { spec, ctx, tex, plane };
  });
  const base = mesh(new THREE.BoxGeometry(2.6, 0.06, 0.5), metal(0x0f1316, 0.5, 0.6), [0, 0.03, 0.15]);
  root.add(base);
  let acc = 1;
  const b: Block = {
    root, state: 'ok',
    set(s) { b.state = s; acc = 1; },
    tick(t, dt) {
      acc += dt;
      if (acc < 0.12) return;
      acc = 0;
      for (const p of panels) {
        drawPanel(p.ctx, p.spec, b.state, t);
        p.tex.needsUpdate = true;
      }
    },
  };
  return b;
}

export interface Canary extends Block {
  /** Fly a route (local coordinates) out and back, then show the verdict at the dock. */
  fly(points: THREE.Vector3[], verdict: 'pass' | 'fail', dur?: number): void;
  dock: THREE.Vector3;
}

/**
 * The canary drone: flies a known tool-call request to a replica and back. It is the
 * one signal that checks the work, not just the plumbing. Standalone, it loops to a
 * ghost replica; in the story, the world flies it across the floor with `fly()`.
 */
export function canary(standalone = true): Canary {
  const root = new THREE.Group();
  const dockAt = standalone ? new THREE.Vector3(-1.15, 0, 0) : new THREE.Vector3(0, 0, 0);
  const targetGeo = new THREE.BoxGeometry(0.42, 1.05, 0.5);
  const target = mesh(targetGeo, metal(0x14191d, 0.5, 0.5), [1.15, 0.53, 0]);
  const targetLine = edges(targetGeo, 0x2a343c);
  targetLine.position.copy(target.position);
  target.visible = targetLine.visible = standalone;
  const dock = mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.06, 24), metal(0x0f1316), [dockAt.x, 0.03, dockAt.z]);
  const dockRing = mesh(new THREE.TorusGeometry(0.27, 0.01, 8, 40), basic(0x38bdf8, 1.4), [dockAt.x, 0.065, dockAt.z], false);
  dockRing.rotation.x = Math.PI / 2;
  root.add(target, targetLine, dock, dockRing);

  const drone = new THREE.Group();
  const core = mesh(new THREE.OctahedronGeometry(0.12, 0), metal(0x2a333a, 0.7, 0.25));
  const band = mesh(new THREE.TorusGeometry(0.2, 0.014, 8, 40), basic(0x38bdf8, 2), undefined, false);
  band.rotation.x = Math.PI / 2;
  const light = mesh(new THREE.SphereGeometry(0.035, 10, 8), basic(0x38bdf8, 2.6), [0, -0.1, 0], false);
  const trail = mesh(new THREE.SphereGeometry(0.2, 20, 14), additive(0x38bdf8, 0.0, 1), undefined, false);
  drone.add(core, band, light, trail);
  root.add(drone);
  const loop = curve([[-1.15, 0.45, 0], [-0.4, 1.35, 0.2], [0.55, 1.2, 0.1], [0.82, 0.8, 0], [0.55, 1.25, -0.15], [-0.4, 1.4, -0.2], [-1.15, 0.45, 0]], 80);
  const verdict = label('', 'lbl wtag', [dockAt.x, 1.05, dockAt.z]);
  verdict.visible = false;
  root.add(verdict);
  const pos = new THREE.Vector3();
  let flight: { path: ReturnType<typeof curve>; t0: number; dur: number; verdict: 'pass' | 'fail' } | null = null;
  let pending: { points: THREE.Vector3[]; verdict: 'pass' | 'fail'; dur: number } | null = null;
  let now = 0;

  const b: Canary = {
    root, state: 'probe', dock: dockAt.clone().setY(0.6),
    set(s) {
      b.state = s;
      verdict.visible = s === 'pass' || s === 'fail';
      verdict.element.className = 'lbl wtag ' + (s === 'fail' ? 'bad' : '');
      verdict.element.innerHTML = s === 'fail' ? '<b>canary</b><em>tool_calls: [] · FAIL</em>' : '<b>canary</b><em>4/4 tool calls · PASS</em>';
    },
    fly(points, v, dur = 4.2) { pending = { points, verdict: v, dur }; },
    tick(t) {
      now = t;
      if (pending) {
        const pts = pending.points;
        flight = { path: curve([...pts, ...pts.slice(0, -1).reverse()].map((p) => p.toArray() as [number, number, number]), 120), t0: now, dur: pending.dur, verdict: pending.verdict };
        pending = null;
        b.set('probe');
      }
      const s = b.state;
      if (flight) {
        const q = (now - flight.t0) / flight.dur;
        if (q >= 1) { b.set(flight.verdict); flight = null; }
        else sample(flight.path, q * flight.path.len, pos);
      }
      if (!flight) {
        if (standalone) {
          const q = s === 'probe' ? (t / 3.2) % 1 : Math.min(1, 0.5 + ((t / 3.2) % 1) * 0.5);
          sample(loop, q * loop.len, pos);
        } else pos.set(dockAt.x, 0.6 + Math.sin(t * 1.6) * 0.06, dockAt.z);
      }
      drone.position.copy(pos);
      drone.rotation.y = t * 2.2;
      band.rotation.z = Math.sin(t * 3) * 0.2;
      const c = b.state === 'fail' ? STATUS.bad : b.state === 'pass' ? STATUS.ok : 0x38bdf8;
      band.material.color.copy(glow(c, 2));
      light.material.color.copy(glow(c, b.state === 'fail' ? (Math.sin(t * 10) > 0 ? 3 : 0.6) : 2.6));
      trail.material.color.copy(glow(c, 1));
      trail.material.opacity = 0.03 + 0.02 * Math.sin(t * 6);
      dockRing.material.color.copy(glow(c, 1.4));
      const near = standalone && pos.distanceTo(target.position) < 0.7;
      (targetLine.material as THREE.LineBasicMaterial).color.copy(glow(near ? c : 0x2a343c, near ? 1.4 : 1));
    },
  };
  b.set('probe');
  return b;
}
