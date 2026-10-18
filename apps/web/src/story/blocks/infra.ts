// Serving and physical blocks: the gateway, a vLLM replica rack, and the substrate
// (cooling, power and network) that sits under the glass floor.
import * as THREE from 'three';
import { FLOW, heatColor, STATUS } from '../../twin/palette';
import { additive, basic, canvasTex, curve, edges, glow, label, mesh, metal, Quake, shake, Sparks, Travelers, type V3 } from '../engine/fx';
import type { Block } from './types';

const _c = new THREE.Color(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();

let doorMat: THREE.MeshStandardMaterial | null = null;
/** Perforated steel door, drawn once (same pattern as the twin's racks). */
function door() {
  if (doorMat) return doorMat;
  const { ctx: g, tex } = canvasTex(128, 256);
  g.fillStyle = '#161b1f'; g.fillRect(0, 0, 128, 256);
  g.fillStyle = '#2a333a';
  for (let y = 14; y < 242; y += 5) for (let x = 12 + ((y / 5) % 2) * 2.5; x < 116; x += 5) g.fillRect(x, y, 2, 2);
  g.strokeStyle = '#323c43'; g.lineWidth = 3; g.strokeRect(4, 4, 120, 248);
  doorMat = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.35, roughness: 0.55 });
  return doorMat;
}

const RW = 0.8, RH = 2.2, RD = 1.0, GPN = 8, NODES = 4;

export interface ReplicaOpts { name?: string; out?: V3[]; showOut?: boolean }

/**
 * One vLLM replica as a rack: 4 nodes × 8 GPU bars on the heat ramp, a status LED per
 * node, a ToR strip on top. Broken racks shake and throw earthquake rings; silent ones
 * look healthy while their responses come back hollow.
 */
export function replica({ name = 'vllm-0', out = [[0.45, 1.3, 0.25], [1.45, 1.3, 0.25]], showOut = true }: ReplicaOpts = {}): Block {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const top = metal(0x111518, 0.5, 0.6);
  const frameGeo = new THREE.BoxGeometry(RW, RH, RD);
  const frame = mesh(frameGeo, [door(), door(), top, top, metal(0x0c0f12, 0.4, 0.6), door()], [0, RH / 2, 0]);
  const outline = edges(frameGeo, STATUS.ok, 1);
  outline.position.copy(frame.position);
  body.add(frame, outline);

  const chassis = new THREE.InstancedMesh(new THREE.BoxGeometry(RW * 0.86, 0.4, 0.03), metal(0x222b33, 0.5, 0.45), NODES);
  const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.22, 0.012), new THREE.MeshBasicMaterial({ color: 0xffffff }), NODES * GPN);
  const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 0.04, 0.012), new THREE.MeshBasicMaterial({ color: 0xffffff }), NODES);
  for (let n = 0; n < NODES; n++) {
    const y = 0.55 + n * 0.47;
    chassis.setMatrixAt(n, _m.makeTranslation(0, y, RD / 2 + 0.012));
    for (let g = 0; g < GPN; g++) bars.setMatrixAt(n * GPN + g, _m.makeTranslation((g - (GPN - 1) / 2) * 0.074 + 0.03, y - 0.02, RD / 2 + 0.032));
    leds.setMatrixAt(n, _m.makeTranslation(-0.32, y + 0.14, RD / 2 + 0.032));
  }
  body.add(chassis, bars, leds);
  const tor = mesh(new THREE.BoxGeometry(RW * 0.84, 0.035, 0.02), basic(STATUS.ok, 1.8), [0, RH - 0.07, RD / 2 + 0.01], false);
  body.add(tor);

  const quake = new Quake(1.9);
  root.add(quake.group);
  const tag = label(`<b>${name}</b><em></em>`, 'lbl wtag', [0, RH + 0.32, 0]);
  root.add(tag);

  const tr = new Travelers(64);
  const sp = new Sparks(40);
  root.add(tr.points, sp.points);
  const r = tr.add(out);
  const outMid = new THREE.Vector3(...out[0]).lerp(new THREE.Vector3(...out[out.length - 1]), 0.4);
  let acc = 0, sparkAt = -1;
  const temp = Array.from({ length: NODES * GPN }, () => 58 + Math.random() * 8);

  const b: Block = {
    root, state: 'ok',
    set(s) {
      b.state = s;
      const em = tag.element.querySelector('em')!;
      const red = s === 'bad' || s === 'caught';
      tag.element.className = 'lbl wtag ' + (red ? 'bad' : s === 'silent' || s === 'hot' || s === 'drain' ? 'warn' : s === 'heal' ? 'restart' : '');
      em.textContent = s === 'ok' ? 'serving' : s === 'silent' ? '200 OK · tool_calls: []' : s === 'caught' ? 'caught · canary 0/4' : s === 'bad' ? 'failing' : s === 'heal' ? 'patched · re-admitting' : s === 'hot' ? 'throttling · 88 °C' : s === 'drain' ? 'draining' : '';
      quake.active = red;
      tr.clear();
    },
    tick(t, dt) {
      const s = b.state;
      const util = s === 'bad' ? 0.05 : s === 'drain' ? 0.25 : 0.75 + 0.2 * Math.sin(t * 3.1);
      for (let i = 0; i < temp.length; i++) {
        const target = s === 'hot' ? 86 + (i % 5) : s === 'bad' ? 40 : 60 + (i % 7);
        temp[i] += (target - temp[i]) * (1 - Math.exp(-dt * 1.5));
        heatColor(temp[i], _c).multiplyScalar((0.25 + 0.95 * util) * (0.9 + 0.2 * Math.sin(t * 7 + i)));
        if (s === 'bad' && (i + Math.floor(t * 6)) % 5 === 0) _c.set(STATUS.bad).multiplyScalar(2);
        bars.setColorAt(i, _c);
      }
      bars.instanceColor!.needsUpdate = true;
      const blink = Math.sin(t * 10) > 0;
      const red = s === 'bad' || s === 'caught';
      const ledC = red ? (blink ? STATUS.bad : 0x2a1016) : s === 'heal' ? STATUS.restart : s === 'hot' ? STATUS.thermal : s === 'drain' ? STATUS.warn : STATUS.ok;
      for (let n = 0; n < NODES; n++) leds.setColorAt(n, _c.copy(glow(ledC, red && !blink ? 1 : 2.2)));
      leds.instanceColor!.needsUpdate = true;
      const lineC = red ? STATUS.bad : s === 'heal' ? STATUS.restart : s === 'hot' ? STATUS.thermal : s === 'drain' ? STATUS.warn : 0x2e3a42;
      (outline.material as THREE.LineBasicMaterial).color.copy(glow(lineC, red ? 1.4 + Math.sin(t * 8) * 0.8 : 1));
      tor.material.color.copy(glow(lineC === 0x2e3a42 ? STATUS.ok : lineC, lineC === 0x2e3a42 ? 0.9 : 1.8));
      body.position.copy(red ? shake(t, s === 'bad' ? 0.018 : 0.01, _s) : _s.set(0, 0, 0));

      if (showOut) {
        acc += dt;
        if (acc > 0.45 && s !== 'drain') {
          acc = 0;
          if (s === 'ok' || s === 'heal' || s === 'hot') tr.spawn(r, FLOW.ok, { dur: 0.9, size: 0.1 });
          else if (s === 'silent' || s === 'caught') tr.spawn(r, FLOW.silent, { dur: 0.9, size: 0.22, hollow: true, gain: 2 });
          else if (s === 'bad') { tr.spawn(r, FLOW.err, { dur: 0.9, size: 0.11, until: 0.4 }); sparkAt = t + 0.36; }
        }
        if (sparkAt > 0 && t >= sparkAt) { sp.burst(outMid, STATUS.bad, 9); sparkAt = -1; }
      }
      tr.update(dt);
      sp.update(dt);
      quake.update(t, dt);
    },
  };
  b.set('ok');
  return b;
}

/**
 * The front door: an arch that takes all traffic and fans it into 8 lanes, one per
 * replica. Lane brightness is route weight; a drained lane gets a barrier.
 */
export function gateway(lanes = 8, reach = 2.4, spread = 1.5, demo = true): Block {
  const root = new THREE.Group();
  const pillarGeo = new THREE.BoxGeometry(0.2, 2.1, 0.5);
  const m = metal(0x14181c, 0.75, 0.36);
  const left = mesh(pillarGeo, m, [0, 1.05, -0.95]);
  const right = mesh(pillarGeo, m, [0, 1.05, 0.95]);
  const lintel = mesh(new THREE.BoxGeometry(0.34, 0.24, 2.3), m, [0, 2.22, 0]);
  root.add(left, right, lintel);
  const frameLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([[0, 0.02, -0.82], [0, 2.06, -0.82], [0, 2.06, 0.82], [0, 0.02, 0.82]].map((p) => new THREE.Vector3(...(p as V3)))), new THREE.LineBasicMaterial({ color: glow(STATUS.ok, 1.6) }));
  frameLine.position.x = 0.11;
  const portal = mesh(new THREE.PlaneGeometry(1.64, 2.04), additive(0x38bdf8, 0.06), [0, 1.04, 0], false);
  portal.rotation.y = Math.PI / 2;
  root.add(frameLine, portal);
  const name = label('<b>Gateway</b><span class="m">route · drain · reweight</span>', 'lbl unit', [0, 2.75, 0]);
  root.add(name);

  // Queue column: grows when traffic piles up at the door.
  const queue = mesh(new THREE.CylinderGeometry(0.08, 0.08, 1, 20), basic(STATUS.warn, 1.6), [-0.55, 0, -1.25], false);
  const sleeve = mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.0, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0x3a4650, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }), [-0.55, 1.0, -1.25], false);
  root.add(queue, sleeve);

  const tr = new Travelers(260);
  root.add(tr.points);
  const ingress = tr.add([[-reach, 0.9, 0], [-0.1, 0.9, 0]]);
  const laneRoutes: number[] = [];
  const laneMats: THREE.LineBasicMaterial[] = [];
  const barriers: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>[] = [];
  for (let k = 0; k < lanes; k++) {
    const z = (k - (lanes - 1) / 2) * ((spread * 2) / (lanes - 1));
    const pts: V3[] = [[0.12, 0.9, z * 0.25], [reach * 0.45, 0.6, z * 0.8], [reach, 0.45, z]];
    const route = curve(pts, 24);
    laneRoutes.push(tr.add(route));
    const mat = new THREE.LineBasicMaterial({ color: glow(0x38bdf8, 0.6), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
    root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(route.pts), mat));
    laneMats.push(mat);
    const bar = mesh(new THREE.BoxGeometry(0.04, 0.32, 0.22), basic(STATUS.warn, 2), [reach * 0.45, 0.62, z * 0.8], false);
    bar.visible = false;
    root.add(bar);
    barriers.push(bar);
  }
  let acc = 0, lane = 0;
  let drained: number[] = [];
  const b: Block = {
    root, state: 'ok',
    set(s) {
      b.state = s;
      drained = s === 'drain' ? [0, 1] : s.startsWith('drain:') ? s.slice(6).split(',').map(Number) : [];
      barriers.forEach((bar, k) => (bar.visible = drained.includes(k)));
    },
    tick(t, dt) {
      const s = b.state;
      acc += dt;
      const every = s === 'bad' ? 0.04 : 0.09;
      while (demo && acc > every) {
        acc -= every;
        tr.spawn(ingress, FLOW.ingress, { dur: 0.7, size: 0.07, gain: 0.9 });
        if (s === 'bad') {
          if (Math.random() < 0.4) tr.spawn(ingress, FLOW.shed, { reverse: true, dur: 0.7, size: 0.1, gain: 1.8 });
          continue;
        }
        lane = (lane + 1) % lanes;
        if (drained.includes(lane)) continue;
        tr.spawn(laneRoutes[lane], FLOW.request, { dur: 0.8, delay: 0.7, size: 0.08 });
      }
      laneMats.forEach((m, k) => {
        const off = drained.includes(k);
        m.color.copy(glow(off ? STATUS.warn : s === 'bad' ? STATUS.bad : 0x38bdf8, off ? 0.35 : 0.6));
      });
      const qh = s === 'bad' ? 1.9 + 0.08 * Math.sin(t * 6) : 0.12;
      queue.scale.y += (qh - queue.scale.y) * (1 - Math.exp(-dt * 3));
      queue.position.y = queue.scale.y / 2;
      queue.material.color.copy(glow(s === 'bad' ? STATUS.bad : STATUS.warn, 1.6));
      (frameLine.material as THREE.LineBasicMaterial).color.copy(glow(s === 'bad' ? STATUS.bad : drained.length ? STATUS.warn : 0x3a4650, s === 'bad' ? 1.4 + Math.sin(t * 8) : drained.length ? 1.6 : 1.2));
      portal.material.color.copy(glow(s === 'bad' ? STATUS.bad : 0x38bdf8, 1));
      tr.update(dt);
    },
  };
  return b;
}

/** A small CRAH unit with spinning fans on top. */
function crahUnit() {
  const g = new THREE.Group();
  const body = mesh(new THREE.BoxGeometry(0.6, 0.62, 0.9), metal(0x161b20, 0.6, 0.45), [0, 0.31, 0]);
  const e = edges(body.geometry, 0x27313a);
  e.position.copy(body.position);
  const status = mesh(new THREE.BoxGeometry(0.02, 0.04, 0.7), basic(0x38bdf8, 2), [0.31, 0.52, 0], false);
  g.add(body, e, status);
  const fans: THREE.Group[] = [];
  for (const z of [-0.22, 0.22]) {
    const fan = new THREE.Group();
    const ring = mesh(new THREE.TorusGeometry(0.15, 0.012, 8, 28), metal(0x3a4650), undefined, false);
    ring.rotation.x = Math.PI / 2;
    fan.add(ring);
    for (let k = 0; k < 5; k++) {
      const arm = new THREE.Group();
      const blade = mesh(new THREE.BoxGeometry(0.13, 0.006, 0.04), metal(0x55606a), [0.07, 0, 0], false);
      blade.rotation.x = 0.4;
      arm.rotation.y = (k / 5) * Math.PI * 2;
      arm.add(blade);
      fan.add(arm);
    }
    fan.position.set(0, 0.64, z);
    g.add(fan);
    fans.push(fan);
  }
  return { group: g, fans, status };
}

/**
 * The physical substrate under a glass floor: a CRAH pushing cold air down a duct,
 * a power rail and a network fibre, all feeding the rack standing on the glass.
 * Heat from a failed CRAH rises through the glass into the rack.
 */
export function substrate(): Block {
  const root = new THREE.Group();
  const W = 2.8, D = 1.7, GY = 0.62;
  // Glass floor with its frame.
  const glass = mesh(new THREE.BoxGeometry(W, 0.03, D), new THREE.MeshStandardMaterial({ color: 0x0e1a20, transparent: true, opacity: 0.22, metalness: 0.1, roughness: 0.05, depthWrite: false }), [0, GY, 0], false);
  const glassEdge = edges(glass.geometry, 0x2a3a44);
  glassEdge.position.copy(glass.position);
  const pit = mesh(new THREE.BoxGeometry(W, 0.02, D), metal(0x090b0d, 0.3, 0.9), [0, 0.0, 0], false);
  root.add(pit, glass, glassEdge);
  // Rack standing on the glass.
  const rackGeo = new THREE.BoxGeometry(0.5, 1.1, 0.6);
  const rack = mesh(rackGeo, metal(0x14191d, 0.5, 0.5), [0.75, GY + 0.56, 0]);
  const rackLine = edges(rackGeo, STATUS.ok);
  rackLine.position.copy(rack.position);
  root.add(rack, rackLine);

  const crah = crahUnit();
  crah.group.position.set(-W / 2 + 0.4, 0, -0.35);
  crah.group.scale.setScalar(0.8);
  root.add(crah.group);
  const crahTag = label('<b>CRAH-1</b><span class="m">cooling</span>', 'lbl unit', [-W / 2 + 0.4, 1.0, -0.35]);
  root.add(crahTag);

  const ductGeo = new THREE.BoxGeometry(W - 0.9, 0.16, 0.26);
  const duct = mesh(ductGeo, new THREE.MeshStandardMaterial({ color: 0x10212a, metalness: 0.5, roughness: 0.4, emissive: new THREE.Color(0x0b3a52), emissiveIntensity: 0.6 }), [0.35, 0.16, -0.35]);
  const rail = mesh(new THREE.BoxGeometry(W - 0.3, 0.035, 0.05), basic(STATUS.warn, 0.9), [0.05, 0.12, 0.25], false);
  const fibre = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-W / 2 + 0.15, 0.08, 0.6), new THREE.Vector3(W / 2 - 0.15, 0.08, 0.6)]), new THREE.LineBasicMaterial({ color: glow(0x38bdf8, 1.2) }));
  root.add(duct, rail, fibre);
  root.add(label('<span class="m">air · power · network</span>', 'lbl unit', [0, -0.08, 0.95]));

  const tr = new Travelers(260);
  root.add(tr.points);
  const air = tr.add([[-W / 2 + 0.75, 0.16, -0.35], [0.75, 0.16, -0.35], [0.75, GY + 0.1, -0.15]]);
  const pwr = tr.add([[-W / 2 + 0.2, 0.12, 0.25], [0.75, 0.12, 0.25], [0.75, GY + 0.1, 0.15]]);
  const net = tr.add([[-W / 2 + 0.15, 0.08, 0.6], [0.75, 0.08, 0.6], [0.75, GY + 0.1, 0.25]]);
  const heat = [0, 1, 2, 3].map((k) => tr.add([[0.6 + k * 0.1, GY - 0.3, -0.2 + k * 0.12], [0.62 + k * 0.08, GY + 1.3, -0.1 + k * 0.06]]));
  const quake = new Quake(1.5);
  quake.group.position.set(-W / 2 + 0.4, 0.01, -0.35);
  root.add(quake.group);
  let acc = 0, n = 0;

  const b: Block = {
    root, state: 'ok',
    set(s) {
      b.state = s;
      quake.active = s === 'bad';
      crahTag.element.className = 'lbl unit' + (s === 'bad' ? ' bad' : '');
      crahTag.element.querySelector('.m')!.textContent = s === 'bad' ? 'tripped' : s === 'hot' ? 'degraded' : 'cooling';
    },
    tick(t, dt) {
      const s = b.state;
      if (s !== 'bad') crah.fans.forEach((f) => (f.rotation.y += dt * (s === 'hot' ? 3 : 9)));
      crah.status.material.color.copy(glow(s === 'bad' ? STATUS.bad : s === 'hot' ? STATUS.warn : 0x38bdf8, s === 'bad' ? 1 + Math.sin(t * 8) : 2));
      const ductC = s === 'bad' ? STATUS.bad : s === 'hot' ? STATUS.thermal : 0x0b3a52;
      duct.material.emissive.set(ductC);
      duct.material.emissiveIntensity = s === 'ok' ? 0.6 : 0.5 + 0.3 * Math.sin(t * 4);
      (rackLine.material as THREE.LineBasicMaterial).color.copy(glow(s === 'bad' ? STATUS.bad : s === 'hot' ? STATUS.thermal : STATUS.ok, 1));
      acc += dt;
      while (acc > 0.08) {
        acc -= 0.08;
        n++;
        if (s !== 'bad') tr.spawn(air, s === 'hot' ? STATUS.thermal : 0x38bdf8, { dur: s === 'hot' ? 2.2 : 1.3, size: 0.07, gain: 1.2 });
        if (n % 2 === 0) tr.spawn(pwr, FLOW.power, { dur: 1.0, size: 0.05, gain: 1.4 });
        if (n % 3 === 0) tr.spawn(net, 0x9fdcff, { dur: 0.6, size: 0.045, gain: 1.6 });
        if (s !== 'ok' && n % 2 === 0) tr.spawn(heat[n % heat.length], s === 'bad' ? STATUS.bad : STATUS.thermal, { dur: 1.6, size: 0.16, gain: 0.9 });
      }
      tr.update(dt);
      quake.update(t, dt);
    },
  };
  return b;
}

export interface UnderfloorOpts { W: number; D: number; H: number; rows: { id: string; z: number; crah: string }[]; rackXs: number[] }

/**
 * Room-scale substrate for the GPU floor: a glass-topped pit with one cold-air duct
 * per rack row fed by that row's CRAH, power rails and the aisle fibre. Racks stand
 * on the glass at y = H. States: 'ok', 'trip' (row A's CRAH down, heat rising into
 * row A), 'cooled' (batch paused, row A cooling, CRAH still down).
 */
export function underfloor({ W, D, H, rows, rackXs }: UnderfloorOpts): Block {
  const root = new THREE.Group();
  const wallM = metal(0x0b0e11, 0.4, 0.7);
  const floorM = metal(0x07090b, 0.3, 0.9);
  root.add(mesh(new THREE.BoxGeometry(W, 0.04, D), floorM, [0, 0.02, 0], false));
  for (const [w, d, x, z] of [[W, 0.08, 0, -D / 2], [W, 0.08, 0, D / 2], [0.08, D, -W / 2, 0], [0.08, D, W / 2, 0]] as [number, number, number, number][]) {
    root.add(mesh(new THREE.BoxGeometry(w, H, d), wallM, [x, H / 2, z]));
  }
  const glass = mesh(new THREE.BoxGeometry(W, 0.03, D), new THREE.MeshStandardMaterial({ color: 0x0f1d24, transparent: true, opacity: 0.2, metalness: 0.1, roughness: 0.05, depthWrite: false }), [0, H, 0], false);
  const glassEdge = edges(glass.geometry, 0x2a3a44);
  glassEdge.position.copy(glass.position);
  root.add(glass, glassEdge);

  const tr = new Travelers(900);
  root.add(tr.points);
  const x0 = -W / 2 + 0.9, x1 = W / 2 - 0.4;
  const rowFx = rows.map((row) => {
    const duct = mesh(new THREE.BoxGeometry(x1 - x0, 0.16, 0.3), new THREE.MeshStandardMaterial({ color: 0x10212a, metalness: 0.5, roughness: 0.4, emissive: new THREE.Color(0x0b3a52), emissiveIntensity: 0.6 }), [(x0 + x1) / 2, H * 0.4, row.z]);
    const rail = mesh(new THREE.BoxGeometry(x1 - x0, 0.03, 0.05), basic(STATUS.warn, 0.4), [(x0 + x1) / 2, H * 0.22, row.z + Math.sign(row.z) * 0.38], false);
    root.add(duct, rail);
    // The row's CRAH stands on the glass at the row's end.
    const crah = crahUnit();
    crah.group.position.set(-W / 2 + 0.55, H, row.z);
    crah.group.rotation.y = Math.PI / 2;
    root.add(crah.group);
    const tag = label(`<b>${row.crah}</b><span class="m">cooling row ${row.id}</span>`, 'lbl unit', [-W / 2 + 0.55, H + 1.15, row.z]);
    root.add(tag);
    const quake = new Quake(1.5);
    quake.group.position.set(-W / 2 + 0.55, H + 0.01, row.z);
    root.add(quake.group);
    const air = rackXs.map((x) => tr.add([[x0, H * 0.4, row.z], [x, H * 0.4, row.z], [x, H + 0.15, row.z]]));
    const pwr = rackXs.map((x) => tr.add([[x0, H * 0.22, row.z + Math.sign(row.z) * 0.38], [x, H * 0.22, row.z + Math.sign(row.z) * 0.38], [x, H + 0.1, row.z + Math.sign(row.z) * 0.3]]));
    const haze = rackXs.map((x) => tr.add([[x, H + 0.1, row.z], [x + 0.05, H + 2.9, row.z + Math.sign(row.z) * 0.3]]));
    return { ...row, duct, crah, tag, quake, air, pwr, haze };
  });
  const fibre = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x0, H * 0.15, 0), new THREE.Vector3(x1, H * 0.15, 0)]), new THREE.LineBasicMaterial({ color: glow(0x38bdf8, 1.2) }));
  root.add(fibre);
  const net = tr.add([[x0, H * 0.15, 0], [x1, H * 0.15, 0]]);
  let acc = 0, n = 0;

  // Row A is the one that loses its CRAH in the story.
  const rowState = (id: string, s: string) => (id !== rows[0].id || s === 'ok' ? 'ok' : s);
  const b: Block = {
    root, state: 'ok',
    set(s) {
      b.state = s;
      rowFx.forEach((r) => {
        const rs = rowState(r.id, s);
        r.quake.active = rs !== 'ok';
        r.tag.element.className = 'lbl unit' + (rs !== 'ok' ? ' bad' : '');
        r.tag.element.querySelector('.m')!.textContent = rs === 'ok' ? `cooling row ${r.id}` : 'tripped · fans stopped';
      });
    },
    tick(t, dt) {
      acc += dt;
      const spawn = acc > 0.07;
      if (spawn) { acc = 0; n++; }
      rowFx.forEach((r) => {
        const rs = rowState(r.id, b.state);
        if (rs === 'ok') r.crah.fans.forEach((f) => (f.rotation.y += dt * 9));
        r.crah.status.material.color.copy(glow(rs === 'ok' ? 0x38bdf8 : STATUS.bad, rs === 'ok' ? 2 : 1 + Math.sin(t * 8)));
        const dc = rs === 'trip' ? STATUS.bad : rs === 'cooled' ? STATUS.thermal : 0x0b3a52;
        r.duct.material.emissive.set(dc);
        r.duct.material.emissiveIntensity = rs === 'ok' ? 0.6 : 0.55 + 0.3 * Math.sin(t * 4);
        r.quake.update(t, dt);
        if (!spawn) return;
        const k = n % r.air.length;
        if (rs === 'ok') tr.spawn(r.air[k], 0x38bdf8, { dur: 1.4, size: 0.08, gain: 1.2 });
        if (n % 2 === 0) tr.spawn(r.pwr[k], FLOW.power, { dur: 1.1, size: 0.05, gain: 1.3 });
        if (rs === 'trip') tr.spawn(r.haze[k], n % 3 ? STATUS.thermal : STATUS.bad, { dur: 1.8, size: 0.2, gain: 0.8 });
        if (rs === 'cooled' && n % 3 === 0) tr.spawn(r.haze[k], STATUS.warn, { dur: 2.2, size: 0.14, gain: 0.5 });
      });
      if (spawn && n % 2 === 0) tr.spawn(net, 0x9fdcff, { dur: 0.7, size: 0.045, gain: 1.5 });
      tr.update(dt);
    },
  };
  b.set('ok');
  return b;
}
