// The story world: one floor, six rooms, cross-room traffic, the incident's path on
// the floor, and the finale. The script drives it through a small API; nothing here
// knows about any particular story.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { FLOW, STATUS } from '../../twin/palette';
import type { Candidate, CertRecord } from '../blocks/nexus';
import { curve, glow, Travelers, type V3 } from '../engine/fx';
import { Stage } from '../engine/stage';
import { CAMS, PATHS, ROOM, ROOMS, ROWS, ZONES, slotX, type Fleet, type RoomId } from './layout';
import { buildRooms, type Built } from './rooms';

export type PathKind = 'fault' | 'fix';

export class World {
  stage: Stage;
  built: Built;
  focused: RoomId | null = null;
  finaleOn = false;
  /** Requests per second across the whole floor. */
  rate = 4.5;

  private traffic = new Travelers(2600);
  private routes: { r: number; len: number }[][] = [];
  private next = 0;
  private acc = 0;
  private paths: Record<string, { mats: THREE.MeshBasicMaterial[]; route: number; kind: PathKind | null }> = {};
  private pathTr = new Travelers(400);
  private pathAcc = 0;
  private timers: { at: number; fn: () => void }[] = [];
  private fog: [number, number] = [18, 52];
  private certRise = -1;
  private blockLabels = new Map<RoomId, CSS2DObject[]>();

  fleet: Fleet;

  constructor(container: HTMLElement, fleet: Fleet, subs: Partial<Record<RoomId, string>> = {}) {
    this.fleet = fleet;
    this.stage = new Stage(container, { floor: [64, 34], center: [-1.5, 0], fade: 34, camera: CAMS.wide, fog: this.fog, grid: false, bloom: [0.42, 0.5, 0.86], ground: 0x0a0c0d });
    this.buildZones();
    this.built = buildRooms(this.stage.scene, fleet, subs);
    this.stage.scene.add(this.traffic.points, this.pathTr.points);
    this.buildRoutes();
    this.buildPaths();
    for (const def of ROOMS) {
      const labels: CSS2DObject[] = [];
      this.built.rooms[def.id].group.traverse((o) => {
        if (o instanceof CSS2DObject && o !== this.built.rooms[def.id].title) labels.push(o);
      });
      this.blockLabels.set(def.id, labels);
    }
    this.stage.tickers.add((t, dt) => this.tick(t, dt));
  }

  get blocks() { return this.built.blocks; }

  /** Apply block states: { "vllm-0": "silent", "dash": "ok", … }. Unknown ids are ignored. */
  apply(states: Record<string, string>) {
    for (const [id, s] of Object.entries(states)) {
      const b = this.blocks[id];
      if (b && b.state !== s) b.set(s);
    }
  }

  configureTwin(c: Candidate[]) { this.built.twin.configure(c); }

  /** Name the tool a doctor is calling right now (null for its default orbit). */
  say(doctor: 'doc-tool' | 'doc-infra', tool: string | null) { this.built.doctors[doctor].say(tool); }

  cards(doctor: 'doc-tool' | 'doc-infra', texts: string[]) { this.built.doctors[doctor].setCards(texts); }

  /** Light the focused room, lift it a little, and quiet the labels everywhere else. */
  focus(room: RoomId | null) {
    this.focused = room;
    for (const def of ROOMS) {
      const on = def.id === room;
      const r = this.built.rooms[def.id];
      r.title.element.classList.toggle('on', on);
      r.title.element.style.opacity = room === null ? '' : '0';
      for (const l of this.blockLabels.get(def.id)!) l.element.style.opacity = on && !this.finaleOn ? '' : '0';
    }
  }

  cam(key: string, dur = 2.4) {
    const p = CAMS[key] ?? CAMS.wide;
    return this.stage.flyTo(p.pos, p.target, dur);
  }

  /** Which floor paths are lit, and whether each is the fault's way in or the fix's way back. */
  light(lit: Record<string, PathKind>) {
    for (const [id, p] of Object.entries(this.paths)) p.kind = lit[id] ?? null;
  }

  wave(room: RoomId, color: number, life = 3, speed = 4) {
    const r = ROOM[room];
    this.stage.wave(r.x, r.z, color, life, speed);
  }

  /** Fly the canary from Signals to a worker's aisle position and back. `rack` indexes the fleet. */
  canaryRun(rack: number, verdict: 'pass' | 'fail', dur = 4.2) {
    const c = this.built.canary;
    c.root.updateWorldMatrix(true, false);
    const dock = c.root.localToWorld(c.dock.clone());
    const target = this.rackFront(rack).add(new THREE.Vector3(0, 0.5, 0));
    const pts = [dock, new THREE.Vector3(ROOM.signals.x - 2.2, 3.4, 0.8), new THREE.Vector3(ROOM.gpu.x + 2.8, 3.6, 0.3), target];
    c.fly(pts.map((p) => c.root.worldToLocal(p.clone())), verdict, dur);
  }

  /** Run fn after `delay` seconds of stage time. */
  after(delay: number, fn: () => void) { this.timers.push({ at: this.stage.time + delay, fn }); }
  clearTimers() { this.timers = []; }

  /** The overview: camera rises, every room label grows, the certificate comes up. */
  finale(outcome: 'verified' | 'human' | CertRecord | null, instant = false) {
    this.finaleOn = outcome !== null;
    document.body.classList.toggle('story-finale', this.finaleOn);
    const cert = this.built.cert;
    if (outcome) {
      if (typeof outcome === 'string') cert.set(outcome);
      else cert.record(outcome);
      // The flow map now carries the verdict; the slab stays hidden so the overview reads as a plan.
      cert.root.visible = false;
      this.certRise = instant ? 1 : 0;
      this.fog = [44, 110];
      this.focus(null);
    } else {
      cert.root.visible = false;
      cert.root.position.y = -3;
      this.certRise = -1;
      this.fog = [18, 52];
    }
  }

  setFog(near: number, far: number) { this.fog = [near, far]; }

  setInset(fraction: number, instant = false) { this.stage.setFocusInset(fraction, instant); }

  dispose() {
    document.body.classList.remove('story-finale');
    this.stage.dispose();
  }

  // ------------------------------------------------------------------ build

  private rackFront(k: number) {
    const w = this.fleet[k];
    const row = ROWS[w.row];
    const g = ROOM.gpu;
    return new THREE.Vector3(g.x + slotX(w.slot), g.h + 1.0, g.z + row.z + (w.row === 0 ? 0.78 : -0.78));
  }

  private buildRoutes() {
    const door = ROOM.door, g = ROOM.gpu;
    const n = this.fleet.length;
    const spread = n > 2 ? 0.9 : 0.45;
    this.routes = this.built.callerPts.map((from) => Array.from({ length: n }, (_, k) => {
      const laneZ = n > 1 ? (k - (n - 1) / 2) * ((spread * 2) / (n - 1)) : 0;
      const rf = this.rackFront(k);
      const pts: V3[] = [
        from.toArray() as V3,
        [door.x - 1.7, door.h + 0.95, 0],
        [door.x + 0.2, door.h + 0.9, laneZ * 0.25],
        [door.x + 1.3, door.h + 0.6, laneZ],
        [g.x - g.w / 2 - 0.4, g.h + 0.9, laneZ * 0.4],
        [g.x - g.w / 2 + 0.6, g.h + 1.0, 0],
        [rf.x - 0.15, rf.y, 0],
        rf.toArray() as V3,
      ];
      const route = curve(pts, 90);
      return { r: this.traffic.add(route), len: route.len };
    }));
  }

  /** Rounded, matte zone tints under each part of the system: the floor reads as a plan, not a grid. */
  private buildZones() {
    for (const z of ZONES) {
      const [x0, x1] = z.x, [z0, z1] = z.z, r = 1.1;
      const s = new THREE.Shape();
      s.moveTo(x0 + r, z0); s.lineTo(x1 - r, z0); s.quadraticCurveTo(x1, z0, x1, z0 + r);
      s.lineTo(x1, z1 - r); s.quadraticCurveTo(x1, z1, x1 - r, z1); s.lineTo(x0 + r, z1);
      s.quadraticCurveTo(x0, z1, x0, z1 - r); s.lineTo(x0, z0 + r); s.quadraticCurveTo(x0, z0, x0 + r, z0);
      const m = new THREE.Mesh(new THREE.ShapeGeometry(s, 12), new THREE.MeshStandardMaterial({ color: z.color, roughness: 0.92, metalness: 0.05, side: THREE.DoubleSide }));
      m.rotation.x = Math.PI / 2;
      m.position.y = 0.002;
      m.receiveShadow = true;
      this.stage.scene.add(m);
    }
  }

  private buildPaths() {
    for (const [id, pts] of Object.entries(PATHS)) {
      const mats: THREE.MeshBasicMaterial[] = [];
      for (let i = 1; i < pts.length; i++) {
        const a = new THREE.Vector3(...pts[i - 1]), b = new THREE.Vector3(...pts[i]);
        const len = a.distanceTo(b);
        const mat = new THREE.MeshBasicMaterial({ color: glow(0x2a343c, 0.6), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
        const seg = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.04), mat);
        seg.rotation.x = -Math.PI / 2;
        seg.rotation.z = -Math.atan2(b.z - a.z, b.x - a.x);
        seg.position.copy(a).lerp(b, 0.5);
        this.stage.scene.add(seg);
        mats.push(mat);
      }
      this.paths[id] = { mats, route: this.pathTr.add(pts.map((p) => [p[0], 0.06, p[2]] as V3)), kind: null };
    }
  }

  // ------------------------------------------------------------------- tick

  private tick(t: number, dt: number) {
    const due = this.timers.filter((x) => x.at <= t);
    if (due.length) {
      this.timers = this.timers.filter((x) => x.at > t);
      due.forEach((x) => x.fn());
    }
    for (const b of Object.values(this.blocks)) b.tick(t, dt);

    const k = 1 - Math.exp(-dt * 4);
    for (const def of ROOMS) {
      const r = this.built.rooms[def.id];
      const on = def.id === this.focused;
      r.group.position.y += ((on ? 0.12 : 0) - r.group.position.y) * k;
      r.light.intensity += ((on ? 16 : this.finaleOn ? 5 : 0) - r.light.intensity) * k;
      r.pool.material.opacity += ((on ? 0.16 : this.finaleOn ? 0.05 : 0) - r.pool.material.opacity) * k;
      r.edge.color.lerp(_c.copy(glow(on ? STATUS.ok : 0x2a343c, on ? 0.9 : 0.7)), k);
    }

    this.tickTraffic(dt);
    this.tickPaths(t, dt);

    const fog = this.stage.scene.fog as THREE.Fog;
    fog.near += (this.fog[0] - fog.near) * (1 - Math.exp(-dt * 1.5));
    fog.far += (this.fog[1] - fog.far) * (1 - Math.exp(-dt * 1.5));

    if (this.certRise >= 0 && this.certRise < 1) this.certRise = Math.min(1, this.certRise + dt / 2.6);
    if (this.certRise >= 0) {
      const e = 1 - (1 - this.certRise) ** 3;
      this.built.cert.root.position.y = -3 + 3.6 * e;
    }
  }

  private tickTraffic(dt: number) {
    const tr = this.traffic;
    this.acc += dt * this.rate;
    while (this.acc >= 1) {
      this.acc -= 1;
      const c = Math.floor(Math.random() * this.routes.length);
      const caller = this.blocks[c < 4 ? `agent-${c}` : `human-${c - 4}`];
      // A stalled agent has stopped acting, so it mostly stops asking.
      if (caller?.state === 'silent' && Math.random() < 0.75) continue;
      let rack = -1;
      const n = this.fleet.length;
      for (let tries = 0; tries < n; tries++) {
        const k = this.next++ % n;
        const s = this.blocks[this.fleet[k].id]?.state;
        if (s !== 'drain' && s !== 'off') { rack = k; break; }
      }
      if (rack < 0) continue;
      const { r, len } = this.routes[c][rack];
      const s = this.blocks[this.fleet[rack].id].state;
      const slow = s === 'hot' ? 1.7 : 1;
      const dur = (len / 8.5) * slow;
      tr.spawn(r, FLOW.request, { dur, size: 0.08, gain: 1.3 });
      const back = { reverse: true, dur, delay: dur + 0.15 * slow };
      if (s === 'silent' || s === 'caught') tr.spawn(r, FLOW.silent, { ...back, size: 0.2, hollow: true, gain: 2 });
      else if (s === 'bad') tr.spawn(r, FLOW.err, { ...back, size: 0.1, until: 0.3 });
      else tr.spawn(r, FLOW.ok, { ...back, size: 0.08, gain: 1.3 });
    }
    tr.update(dt);
  }

  private tickPaths(t: number, dt: number) {
    this.pathAcc += dt;
    const pulse = this.pathAcc > 0.6;
    if (pulse) this.pathAcc = 0;
    for (const p of Object.values(this.paths)) {
      const c = p.kind === 'fault' ? STATUS.warn : p.kind === 'fix' ? STATUS.ok : 0x2a343c;
      const kk = p.kind ? 1.3 + 0.3 * Math.sin(t * 3) : 0.9;
      p.mats.forEach((m) => m.color.copy(glow(c, kk)));
      if (pulse && p.kind) this.pathTr.spawn(p.route, c, { dur: 2.2, size: 0.11, gain: 1.8 });
    }
    this.pathTr.update(dt);
  }
}

const _c = new THREE.Color();
