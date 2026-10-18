// Demand side: AI agents, humans, and the packets they exchange with the system.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { FLOW, STATUS } from '../../twin/palette';
import { basic, glow, label, mesh, metal, Sparks, Travelers, type V3 } from '../engine/fx';
import type { Block } from './types';

const LOOK: Record<string, number> = { ok: STATUS.ok, silent: STATUS.warn, bad: STATUS.bad };

/** Request out, response back; the response is solid green, hollow amber (empty) or red sparks. */
function exchange(root: THREE.Group, route: V3[]) {
  const tr = new Travelers(96);
  const sp = new Sparks(48);
  root.add(tr.points, sp.points);
  const r = tr.add(route);
  const end = new THREE.Vector3(...route[route.length - 1]);
  const mid = new THREE.Vector3(...route[0]).lerp(end, 0.55);
  let acc = 0, pendingSpark = -1;
  return {
    tick(state: string, t: number, dt: number, every = 0.55) {
      acc += dt;
      if (acc > every) {
        acc = 0;
        tr.spawn(r, FLOW.request, { dur: 0.9, size: 0.1 });
        if (state === 'ok') tr.spawn(r, FLOW.ok, { reverse: true, dur: 0.9, delay: 0.95, size: 0.1 });
        else if (state === 'silent') tr.spawn(r, FLOW.silent, { reverse: true, dur: 0.9, delay: 0.95, size: 0.2, hollow: true, gain: 2 });
        else if (state === 'bad') { tr.spawn(r, FLOW.err, { reverse: true, dur: 0.9, delay: 0.95, size: 0.11, until: 0.45 }); pendingSpark = t + 0.95 + 0.4; }
      }
      if (pendingSpark > 0 && t >= pendingSpark) { sp.burst(mid, STATUS.bad, 10); pendingSpark = -1; }
      tr.update(dt);
      sp.update(dt);
    },
  };
}

/** `demo` runs the block's own packet loop; in the story the world drives traffic instead. */
export function agent(route: V3[] = [[0.36, 0.5, 0], [1.45, 0.62, 0]], demo = true): Block {
  const root = new THREE.Group();
  const base = mesh(new THREE.CylinderGeometry(0.46, 0.52, 0.1, 6), metal(0x0f1316, 0.6, 0.5), [0, 0.05, 0]);
  base.rotation.y = Math.PI / 6;
  const rim = mesh(new THREE.TorusGeometry(0.47, 0.012, 6, 6), basic(STATUS.ok, 1.6), [0, 0.105, 0], false);
  rim.rotation.set(Math.PI / 2, 0, Math.PI / 6);
  const body = mesh(new RoundedBoxGeometry(0.6, 0.56, 0.6, 4, 0.12), metal(0x1b2228, 0.65, 0.32), [0, 0.42, 0]);
  const visor = mesh(new THREE.BoxGeometry(0.5, 0.17, 0.02), new THREE.MeshStandardMaterial({ color: 0x07090a, metalness: 0.2, roughness: 0.15 }), [0, 0.47, 0.302], false);
  const eye = mesh(new THREE.BoxGeometry(0.34, 0.045, 0.012), basic(STATUS.ok), [0, 0.47, 0.316], false);
  const mast = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6), metal(0x2a333a), [0.16, 0.8, 0]);
  const tip = mesh(new THREE.SphereGeometry(0.035, 12, 8), basic(STATUS.ok), [0.16, 0.92, 0], false);
  root.add(base, rim, body, visor, eye, mast, tip);
  const ex = exchange(root, route);
  const b: Block = {
    root, state: 'ok',
    set(s) { b.state = s; },
    tick(t, dt) {
      const c = LOOK[b.state] ?? STATUS.off;
      const k = b.state === 'ok' ? 1.6 + 0.6 * Math.sin(t * 2.4) : b.state === 'silent' ? 0.7 + 0.25 * Math.sin(t * 0.9) : Math.sin(t * 10) > 0 ? 2.4 : 0.4;
      eye.material.color.copy(glow(c, k));
      tip.material.color.copy(glow(c, k * 0.8));
      rim.material.color.copy(glow(c, 0.9));
      if (demo) ex.tick(b.state, t, dt, b.state === 'silent' ? 1.1 : 0.55);
    },
  };
  return b;
}

export function human(route: V3[] = [[0.3, 0.75, 0], [1.45, 0.62, 0]], demo = true): Block {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x3a454d, metalness: 0.25, roughness: 0.5 });
  const torso = mesh(new THREE.CapsuleGeometry(0.17, 0.36, 6, 16), skin, [0, 0.42, 0]);
  const head = mesh(new THREE.SphereGeometry(0.13, 20, 14), skin, [0, 0.9, 0]);
  const halo = mesh(new THREE.TorusGeometry(0.34, 0.012, 8, 48), basic(STATUS.ok, 1.6), [0, 0.02, 0], false);
  halo.rotation.x = Math.PI / 2;
  const disc = mesh(new THREE.CircleGeometry(0.34, 40), new THREE.MeshBasicMaterial({ color: glow(STATUS.ok, 0.25), transparent: true, opacity: 0.35, depthWrite: false }), [0, 0.012, 0], false);
  disc.rotation.x = -Math.PI / 2;
  const bubble = label('', 'lbl story-bubble', [0.05, 1.22, 0]);
  root.add(torso, head, halo, disc, bubble);
  const ex = exchange(root, route);
  const b: Block = {
    root, state: 'ok',
    set(s) {
      b.state = s;
      bubble.element.textContent = s === 'ok' ? 'answered' : s === 'silent' ? 'waiting…' : 'error 503';
      bubble.element.dataset.tone = s;
    },
    tick(t, dt) {
      const c = LOOK[b.state] ?? STATUS.off;
      const k = b.state === 'bad' ? (Math.sin(t * 10) > 0 ? 2 : 0.5) : 1.4 + 0.4 * Math.sin(t * 2);
      halo.material.color.copy(glow(c, k));
      disc.material.color.copy(glow(c, 0.25));
      if (demo) ex.tick(b.state, t, dt, 0.9);
    },
  };
  b.set('ok');
  return b;
}

/** Packet grammar on its own: a sender, a receiver, and what comes back. */
export function packets(): Block {
  const root = new THREE.Group();
  const nodeGeo = new RoundedBoxGeometry(0.26, 0.26, 0.26, 3, 0.05);
  const a = mesh(nodeGeo, metal(0x1b2228), [-1.0, 0.5, 0]);
  const z = mesh(nodeGeo, metal(0x1b2228), [1.0, 0.5, 0]);
  const wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.85, 0.5, 0), new THREE.Vector3(0.85, 0.5, 0)]), new THREE.LineBasicMaterial({ color: 0x2a343c }));
  root.add(a, z, wire);
  const ex = exchange(root, [[-0.85, 0.5, 0], [0.85, 0.5, 0]]);
  const b: Block = { root, state: 'ok', set(s) { b.state = s; }, tick(t, dt) { ex.tick(b.state, t, dt, 0.42); } };
  return b;
}
