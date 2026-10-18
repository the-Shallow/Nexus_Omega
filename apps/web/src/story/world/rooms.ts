// The six rooms, each a group of blocks on a plinth, plus a registry of blocks by id
// so the story script can address them ("vllm-0", "doc-tool", "gate", …).
import * as THREE from 'three';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { STATUS } from '../../twin/palette';
import { agent, human } from '../blocks/callers';
import { gateway, replica, underfloor } from '../blocks/infra';
import { certificate, doctor, gate, shadowTwin, type Cert, type Doctor, type Twin } from '../blocks/nexus';
import { canary, dashboards, type Canary } from '../blocks/signals';
import type { Block } from '../blocks/types';
import { basic, edges, glow, label, mesh, metal, Travelers } from '../engine/fx';
import { RACK_X, ROOMS, ROWS, slotX, type Fleet, type RoomId } from './layout';

export interface RoomParts { def: (typeof ROOMS)[number]; group: THREE.Group; edge: THREE.LineBasicMaterial; light: THREE.PointLight; title: CSS2DObject }

export interface Built {
  rooms: Record<RoomId, RoomParts>;
  blocks: Record<string, Block>;
  canary: Canary;
  twin: Twin;
  cert: Cert;
  doctors: Record<'doc-tool' | 'doc-infra', Doctor>;
  /** World points where callers emit requests. */
  callerPts: THREE.Vector3[];
}

/** The doctor manager: a routing ring that pulses toward whichever doctor gets the alarm. */
function manager(targets: Record<string, THREE.Vector3>): Block {
  const root = new THREE.Group();
  const base = mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.1, 40), metal(0x0f1316), [0, 0.05, 0]);
  const ring = mesh(new THREE.TorusGeometry(0.42, 0.02, 10, 64), basic(STATUS.ok, 1.6), [0, 0.75, 0], false);
  const core = mesh(new THREE.SphereGeometry(0.13, 24, 16), basic(STATUS.ok, 1.6), [0, 0.75, 0], false);
  root.add(base, ring, core, label('<b>Doctor manager</b><span class="m">routes each alarm</span>', 'lbl unit', [0, 1.45, 0]));
  const tr = new Travelers(60);
  root.add(tr.points);
  const routes = Object.fromEntries(Object.entries(targets).map(([k, p]) => [k, tr.add([[0, 0.75, 0], [p.x * 0.5, 1.3, p.z * 0.5], [p.x, 1.1, p.z]])]));
  let acc = 0;
  const b: Block = {
    root, state: 'idle',
    set(s) { b.state = s; },
    tick(t, dt) {
      const on = b.state !== 'idle';
      ring.rotation.set(Math.PI / 2 + Math.sin(t * 0.8) * 0.3, t * 0.6, 0);
      ring.material.color.copy(glow(on ? STATUS.ok : STATUS.off, on ? 1.8 : 0.6));
      core.material.color.copy(glow(on ? STATUS.ok : STATUS.off, on ? 1.4 + 0.6 * Math.sin(t * 5) : 0.5));
      acc += dt;
      if (on && acc > 0.25 && routes[b.state] !== undefined) { acc = 0; tr.spawn(routes[b.state], STATUS.ok, { dur: 0.8, size: 0.1, gain: 2 }); }
      tr.update(dt);
    },
  };
  return b;
}

export function buildRooms(scene: THREE.Scene, fleet: Fleet, subs: Partial<Record<RoomId, string>> = {}): Built {
  const rooms = {} as Record<RoomId, RoomParts>;
  const blocks: Record<string, Block> = {};
  const callerPts: THREE.Vector3[] = [];
  const add = (id: string, b: Block, room: THREE.Group, x: number, y: number, z: number, ry = 0) => {
    b.root.position.set(x, y, z);
    b.root.rotation.y = ry;
    room.add(b.root);
    blocks[id] = b;
    return b;
  };

  for (const def of ROOMS) {
    const group = new THREE.Group();
    group.position.set(def.x, 0, def.z);
    scene.add(group);
    if (def.id !== 'gpu') {
      group.add(mesh(new THREE.BoxGeometry(def.w, def.h, def.d), metal(0x0b0e11, 0.45, 0.6), [0, def.h / 2, 0]));
    }
    const y = def.h + 0.006;
    const hw = def.w / 2, hd = def.d / 2;
    const edge = new THREE.LineBasicMaterial({ color: glow(0x2a343c, 1) });
    group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-hw, y, -hd], [hw, y, -hd], [hw, y, hd], [-hw, y, hd]].map((p) => new THREE.Vector3(...(p as [number, number, number])))), edge));
    const light = new THREE.PointLight(0xdfe8ee, 0, 11, 1.6);
    light.position.set(0, 6.5, 0.6);
    group.add(light);
    const title = label(`<i>${def.n}</i><b>${def.name}</b><span>${subs[def.id] ?? def.sub}</span>`, 'lbl story-room', [0, 0.02, hd + 0.6]);
    group.add(title);
    rooms[def.id] = { def, group, edge, light, title };
  }

  // 01 Callers: four agents in front, three people behind, all facing the door (+x).
  const C = rooms.callers, ch = C.def.h;
  [-2.0, -0.7, 0.7, 2.0].forEach((z, i) => {
    add(`agent-${i}`, agent(undefined, false), C.group, 0.9, ch, z, Math.PI / 2);
    callerPts.push(new THREE.Vector3(C.def.x + 1.3, ch + 0.48, C.def.z + z));
  });
  [-1.4, 0, 1.4].forEach((z, i) => {
    add(`human-${i}`, human(undefined, false), C.group, -1.0, ch, z, Math.PI / 2);
    callerPts.push(new THREE.Vector3(C.def.x - 0.7, ch + 0.8, C.def.z + z));
  });

  // 02 Front door: the gateway, its lanes short stubs that the world's routes continue.
  add('gateway', gateway(fleet.length, 1.3, fleet.length > 2 ? 0.9 : 0.45, false), rooms.door.group, 0, rooms.door.def.h, 0);

  // 03 GPU floor: glass over the substrate, two rows of four racks facing a cold aisle.
  const G = rooms.gpu, H = G.def.h;
  add('floor', underfloor({ W: G.def.w, D: G.def.d, H, rows: ROWS, rackXs: RACK_X }), G.group, 0, 0, 0);
  for (const w of fleet) {
    const row = ROWS[w.row];
    add(w.id, replica({ name: w.label, showOut: false }), G.group, slotX(w.slot), H, row.z, w.row === 0 ? 0 : Math.PI).root.scale.setScalar(0.85);
  }
  // A smaller fleet leaves rack spaces empty: draw them as faint outlines, not as racks.
  if (fleet.length < 8) {
    const ghost = new THREE.BoxGeometry(0.8 * 0.85, 2.2 * 0.85, 1.0 * 0.85);
    ROWS.forEach((row) => RACK_X.forEach((x) => {
      if (fleet.some((w) => Math.abs(slotX(w.slot) - x) < 0.7 && ROWS[w.row] === row)) return;
      const e = edges(ghost, 0x1c252b, 0.6);
      e.position.set(x, H + 1.1 * 0.85, row.z);
      G.group.add(e);
    }));
  }

  // 04 Signals: the dashboard wall and the canary dock.
  const S = rooms.signals, sh = S.def.h;
  add('dash', dashboards(), S.group, 0.5, sh, -1.2).root.scale.setScalar(1.4);
  const can = canary(false);
  add('canary', can, S.group, -1.7, sh, 1.2);

  // 05 Doctors: manager at the back, two doctors, the policy gate at the front.
  const D = rooms.doctors, dh = D.def.h;
  const docTool = new THREE.Vector3(-2.3, 0, 0.1), docInfra = new THREE.Vector3(2.3, 0, 0.1), mgrAt = new THREE.Vector3(0, 0, -1.5);
  add('mgr', manager({ tool: docTool.clone().sub(mgrAt), infra: docInfra.clone().sub(mgrAt) }), D.group, mgrAt.x, dh, mgrAt.z);
  const doctors = {
    'doc-tool': doctor('Tool-Calling Doctor', ['get_change_history', 'read_raw_generation', 'read_serving_config', 'run_canary']),
    'doc-infra': doctor('Infrastructure Doctor', ['inspect_facility', 'query_metrics', 'list_workers', 'inspect_gpu']),
  };
  add('doc-tool', doctors['doc-tool'], D.group, docTool.x, dh, docTool.z);
  add('doc-infra', doctors['doc-infra'], D.group, docInfra.x, dh, docInfra.z);
  add('gate', gate(), D.group, -0.1, dh, 1.55, 0);

  // 06 Shadow twin.
  const tw = shadowTwin();
  tw.root.scale.setScalar(1.2);
  add('twin', tw, rooms.twin.group, 0.2, rooms.twin.def.h, 0.4);

  // The certificate waits below the floor until the finale.
  const cert = certificate();
  // Tipped back so it faces the finale's overhead camera.
  cert.root.position.set(-1.2, -3, 9.4);
  cert.root.rotation.x = -0.75;
  cert.root.scale.setScalar(3.2);
  cert.root.visible = false;
  scene.add(cert.root);
  blocks.cert = cert;

  return { rooms, blocks, canary: can, twin: tw, cert, doctors, callerPts };
}
