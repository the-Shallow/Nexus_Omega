// Three.js view of the twin in a light "architectural model" style: graphite racks on
// a white raised floor, hot-aisle containment, CRAH cooling, UPS busways, and live
// request / air / power flows.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { heatColor, airColor, HEAT_GLSL, COLORS, STATUS } from './palette.js';

const RW = 0.8, RD = 1.2, RH = 2.2;
const NODE_H = 0.4;
const TRAY_Y = 2.9, BUS_Y = 3.2, CEIL_Y = 3.15;
const BG = 0xf2f4f7;
const nodeY = (slot) => 0.52 + slot * 0.47;

const _c = new THREE.Color(), _c2 = new THREE.Color(), _m = new THREE.Matrix4(), _v = new THREE.Vector3();
let _segF = 0;

export const PRESETS = {
  overview: { pos: [8.4, 7.4, -9.6], target: [0, 0.5, 0.4] },
  cold: { pos: [-5.2, 1.4, 0.05], target: [2.5, 1.2, 0] },
  hot: { pos: [-5.0, 1.8, -2.4], target: [2.0, 1.4, -2.4] },
  top: { pos: [0.01, 15.5, 0.6], target: [0, 0, 0] },
  power: { pos: [-5.5, 4.4, 9.6], target: [0, 1.4, 3.0] },
  network: { pos: [3.4, 3.4, -8.4], target: [0, 1.7, -3.2] },
};

function polyline(points) {
  const pts = points.map((p) => (p.isVector3 ? p : new THREE.Vector3(...p)));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return { pts, cum, len: cum[cum.length - 1] };
}

function sample(route, d, out) {
  const { pts, cum } = route;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  _segF = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
  out.copy(pts[i - 1]).lerp(pts[i], _segF);
  return i - 1;
}

const POINT_VS = `
attribute float size; attribute float alpha; attribute vec3 color;
uniform float uPx;
varying vec3 vColor; varying float vAlpha;
void main() {
  vColor = color; vAlpha = alpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, size * uPx / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const POINT_FS = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.18, d) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

class Particles {
  constructor(count, px) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    for (const [name, arr, n] of [['position', this.pos, 3], ['color', this.col, 3], ['size', this.size, 1], ['alpha', this.alpha, 1]]) {
      geo.setAttribute(name, new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage));
    }
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({ uniforms: { uPx: { value: px } }, vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  set(i, p, c, size, alpha) {
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    this.size[i] = size; this.alpha[i] = alpha;
  }
  flush() {
    for (const k of ['position', 'color', 'size', 'alpha']) this.geo.attributes[k].needsUpdate = true;
  }
}

// Short-lived particles that travel along shared routes (requests, responses, power pulses).
class Travelers {
  constructor(count, px) {
    this.p = new Particles(count, px);
    this.route = new Int32Array(count).fill(-1);
    this.t = new Float32Array(count);
    this.dur = new Float32Array(count);
    this.delay = new Float32Array(count);
    this.rev = new Uint8Array(count);
    this.sz = new Float32Array(count);
    this.color = Array.from({ length: count }, () => new THREE.Color());
    this.free = Array.from({ length: count }, (_, i) => count - 1 - i);
    this.routes = [];
  }
  addRoute(points) {
    this.routes.push(polyline(points));
    return this.routes.length - 1;
  }
  spawn(route, color, { reverse = false, dur = 1.1, delay = 0, size = 0.075 } = {}) {
    const i = this.free.pop();
    if (i === undefined) return;
    this.route[i] = route; this.t[i] = 0; this.dur[i] = dur; this.delay[i] = delay;
    this.rev[i] = reverse ? 1 : 0; this.sz[i] = size; this.color[i].copy(color);
  }
  update(dt) {
    const p = this.p;
    for (let i = 0; i < p.count; i++) {
      const r = this.route[i];
      if (r < 0) { p.alpha[i] = 0; continue; }
      if (this.delay[i] > 0) { this.delay[i] -= dt; p.alpha[i] = 0; continue; }
      this.t[i] += dt / this.dur[i];
      if (this.t[i] >= 1) { this.route[i] = -1; p.alpha[i] = 0; this.free.push(i); continue; }
      const route = this.routes[r];
      sample(route, (this.rev[i] ? 1 - this.t[i] : this.t[i]) * route.len, _v);
      p.set(i, _v, this.color[i], this.sz[i], 0.95 * Math.min(1, this.t[i] * 8, (1 - this.t[i]) * 8));
    }
    p.flush();
  }
}

export class Twin3D {
  constructor(container, topo) {
    this.topo = topo;
    this.container = container;
    this.frame = null;
    this.selected = null;
    this.thermal = true;
    this.cinematic = false;
    this.time = 0;
    this.listeners = { select: [], cinematic: [] };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.setSize(container.clientWidth || 1, container.clientHeight || 1);
    labels.domElement.className = 'labels';
    container.appendChild(labels.domElement);
    this.labelRenderer = labels;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, 22, 60);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(36, (container.clientWidth || 1) / (container.clientHeight || 1), 0.05, 200);
    camera.position.set(...PRESETS.overview.pos);
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(...PRESETS.overview.target);
    controls.maxDistance = 40;
    controls.minDistance = 0.8;
    controls.maxPolarAngle = Math.PI * 0.49;
    this.controls = controls;
    controls.addEventListener('start', () => { this.tween = null; this.setCinematic(false); });

    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6e0, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(7, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -12, right: 12, top: 10, bottom: -10, near: 1, far: 40 });
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xe8f1ff, 0.5);
    fill.position.set(-8, 6, -6);
    scene.add(fill);

    this.layout();
    this.buildFloor();
    this.buildRacks();
    this.buildCooling();
    this.buildPower();
    this.buildNetwork();
    this.buildContainment();
    this.buildFlows();
    this.buildSelection();
    this.markers = new Map();

    new ResizeObserver(() => this.resize()).observe(container);
    this.bindPicking();
    this.clock = new THREE.Clock();
    renderer.setAnimationLoop(() => this.tick());
  }

  // ------------------------------------------------------------------ layout

  layout() {
    const n = this.topo.hall.racks_per_row;
    this.halfLen = (n * RW) / 2;
    this.row = {
      A: { z: -1.2, front: -0.6, back: -1.8, hot: -2.4, dir: 1 },
      B: { z: 1.2, front: 0.6, back: 1.8, hot: 2.4, dir: -1 },
    };
    this.rackX = (i) => (i - (n - 1) / 2) * RW;
    this.rackById = new Map(this.topo.racks.map((r) => [r.id, r]));
    this.nodeById = new Map(this.topo.nodes.map((nd) => [nd.id, nd]));
    this.workerNode = new Map(this.topo.workers.map((w) => [w.id, w.node]));
    this.crahPos = new Map(this.topo.crahs.map((c, k) => [c.id, new THREE.Vector3((k % 2 === 0 ? -1 : 1) * (this.halfLen + 1.5), 0, this.row[c.row].z)]));
    this.upsPos = new Map(this.topo.ups.map((u, k) => [u, new THREE.Vector3(k === 0 ? -2.1 : 2.1, 0, 4.7)]));
    this.gatewayPos = new THREE.Vector3(0, 0, -4.7);
  }

  nodePos(nodeId, out = new THREE.Vector3()) {
    const node = this.nodeById.get(nodeId);
    const rack = this.rackById.get(node.rack);
    return out.set(this.rackX(rack.index), nodeY(node.slot), this.row[rack.row].front);
  }

  entityPos(type, id) {
    if (type === 'worker') return this.nodePos(this.workerNode.get(id));
    if (type === 'node') return this.nodePos(id);
    if (type === 'rack') {
      const r = this.rackById.get(id);
      return new THREE.Vector3(this.rackX(r.index), 1.1, this.row[r.row].z);
    }
    if (type === 'crah') return this.crahPos.get(id).clone().setY(1.1);
    if (type === 'ups') return this.upsPos.get(id).clone().setY(1.0);
    if (type === 'gateway') return this.gatewayPos.clone().setY(1.3);
    return new THREE.Vector3(0, 0.8, 0);
  }

  // ------------------------------------------------------------------- build

  mesh(geo, mat, { cast = true, receive = false } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  }

  buildFloor() {
    const s = this.scene;
    const W = this.halfLen * 2 + 5.4, D = 10.2;
    this.hallW = W; this.hallD = D;

    const ground = this.mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0xe9edf2, roughness: 1 }), { cast: false, receive: true });
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    s.add(ground);

    // Raised floor slab with a crisp edge.
    const slab = this.mesh(new THREE.BoxGeometry(W, 0.12, D), new THREE.MeshStandardMaterial({ color: 0xfbfcfd, roughness: 0.85 }), { cast: false, receive: true });
    slab.position.y = -0.06;
    s.add(slab);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), new THREE.LineBasicMaterial({ color: 0xcbd3de }));
    edge.position.copy(slab.position);
    s.add(edge);

    const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D) / 0.6), 0xdfe4ea, 0xe8ecf1);
    grid.position.y = 0.003;
    grid.scale.set(W / Math.max(W, D), 1, D / Math.max(W, D));
    s.add(grid);

    // Perforated cold-aisle tiles.
    const tc = document.createElement('canvas');
    tc.width = tc.height = 64;
    const g = tc.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#7dd3fc';
    for (let x = 4; x < 64; x += 8) for (let y = 4; y < 64; y += 8) { g.beginPath(); g.arc(x, y, 2.1, 0, Math.PI * 2); g.fill(); }
    const tileTex = new THREE.CanvasTexture(tc);
    tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
    tileTex.repeat.set((this.halfLen * 2) / 0.6, 2);
    tileTex.colorSpace = THREE.SRGBColorSpace;
    this.tileMat = new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.8 });
    const tiles = this.mesh(new THREE.PlaneGeometry(this.halfLen * 2, 1.2), this.tileMat, { cast: false, receive: true });
    tiles.rotation.x = -Math.PI / 2;
    tiles.position.y = 0.005;
    s.add(tiles);

    // Thermal floor map, redrawn from rack inlet / exhaust temperatures.
    const hc = document.createElement('canvas');
    hc.width = 384; hc.height = 300;
    this.heatCanvas = hc;
    this.heatCtx = hc.getContext('2d');
    this.heatTex = new THREE.CanvasTexture(hc);
    this.heatTex.colorSpace = THREE.SRGBColorSpace;
    this.heatPlane = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: this.heatTex, transparent: true, opacity: 0.55, depthWrite: false }));
    this.heatPlane.rotation.x = -Math.PI / 2;
    this.heatPlane.position.y = 0.009;
    this.heatPlane.renderOrder = 1;
    s.add(this.heatPlane);
  }

  buildRacks() {
    const s = this.scene;
    const nodes = this.topo.nodes;
    const gpn = this.topo.hall.gpus_per_node;
    this.pickables = [];
    this.rackMeshes = new Map();

    const frameGeo = new THREE.BoxGeometry(RW * 0.97, RH, RD);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1f2633, metalness: 0.35, roughness: 0.55 });
    const capGeo = new THREE.BoxGeometry(RW * 0.97, 0.03, RD);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x2d3646, roughness: 0.4 });
    const exhaustGeo = new THREE.PlaneGeometry(RW * 0.86, RH * 0.88);
    for (const r of this.topo.racks) {
      const row = this.row[r.row];
      const x = this.rackX(r.index);
      const frame = this.mesh(frameGeo, frameMat, { receive: true });
      frame.position.set(x, RH / 2, row.z);
      frame.userData = { type: 'rack', id: r.id };
      s.add(frame);
      this.pickables.push(frame);
      const cap = this.mesh(capGeo, capMat);
      cap.position.set(x, RH + 0.015, row.z);
      s.add(cap);

      const exhaust = new THREE.Mesh(exhaustGeo, new THREE.MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }));
      exhaust.position.set(x, RH / 2, row.back - row.dir * 0.012);
      s.add(exhaust);

      // Top-of-rack switch status strip.
      const tor = new THREE.Mesh(new THREE.BoxGeometry(RW * 0.84, 0.045, 0.02), new THREE.MeshBasicMaterial({ color: STATUS.ok, toneMapped: false }));
      tor.position.set(x, RH - 0.06, row.front + row.dir * 0.004);
      s.add(tor);

      const label = this.label(`<span>${r.id}</span>`, 'lbl rack');
      label.position.set(x, RH + 0.16, row.front);
      s.add(label);
      this.rackMeshes.set(r.id, { frame, exhaust, tor });
    }

    // Node bezels (instanced), GPU light bars (instanced), node status LEDs.
    this.nodeIndex = new Map(nodes.map((nd, i) => [nd.id, i]));
    const chassis = new THREE.InstancedMesh(
      new THREE.BoxGeometry(RW * 0.86, NODE_H, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x343e50, metalness: 0.3, roughness: 0.5 }),
      nodes.length,
    );
    const gpuBars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.046, 0.22, 0.012), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), nodes.length * gpn);
    const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 0.04, 0.012), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), nodes.length);
    const rails = [];
    nodes.forEach((nd, i) => {
      const p = this.nodePos(nd.id);
      const dir = this.row[this.rackById.get(nd.rack).row].dir;
      _m.makeTranslation(p.x, p.y, p.z + dir * 0.012);
      chassis.setMatrixAt(i, _m);
      chassis.setColorAt(i, _c.set(nd.role === 'inference' ? 0x3b4a62 : 0x343e50));
      nd.gpus.forEach((gi, local) => {
        const off = (local - (gpn - 1) / 2) * 0.072 * dir;
        _m.makeTranslation(p.x + off + dir * 0.03, p.y - 0.02, p.z + dir * 0.032);
        gpuBars.setMatrixAt(gi, _m);
        gpuBars.setColorAt(gi, _c.set(0x111111));
      });
      _m.makeTranslation(p.x - dir * 0.34, p.y + 0.14, p.z + dir * 0.032);
      leds.setMatrixAt(i, _m);
      leds.setColorAt(i, _c.set(STATUS.ok));
      if (nd.role === 'inference') rails.push(new THREE.Vector3(p.x, p.y + 0.16, p.z + dir * 0.032));
    });
    chassis.userData = { type: 'node' };
    s.add(chassis, gpuBars, leds);
    this.pickables.push(chassis);
    this.chassis = chassis; this.gpuBars = gpuBars; this.leds = leds;

    const rail = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.014, 0.01), new THREE.MeshBasicMaterial({ color: 0x9be22d, toneMapped: false }), rails.length);
    rails.forEach((p, i) => { _m.makeTranslation(p.x, p.y, p.z); rail.setMatrixAt(i, _m); });
    s.add(rail);

    this.workerTags = new Map();
    for (const w of this.topo.workers) {
      const nd = this.nodeById.get(w.node);
      const dir = this.row[this.rackById.get(nd.rack).row].dir;
      const p = this.nodePos(w.node);
      const tag = this.label(`<b>${w.id}</b><em></em><span class="m"></span>`, 'lbl wtag');
      tag.position.set(p.x, p.y + 0.02, p.z + dir * 0.5);
      s.add(tag);
      this.workerTags.set(w.id, tag);
    }
  }

  buildCooling() {
    const s = this.scene;
    this.crahs = new Map();
    const gc = document.createElement('canvas');
    gc.width = 64; gc.height = 128;
    const g = gc.getContext('2d');
    g.fillStyle = '#e2e8f0'; g.fillRect(0, 0, 64, 128);
    g.fillStyle = '#94a3b8';
    for (let y = 4; y < 128; y += 8) g.fillRect(4, y, 56, 3);
    const grilleTex = new THREE.CanvasTexture(gc);
    for (const c of this.topo.crahs) {
      const pos = this.crahPos.get(c.id);
      const inward = -Math.sign(pos.x);
      const body = this.mesh(new THREE.BoxGeometry(0.9, 2.3, 1.9), new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 }), { receive: true });
      body.position.set(pos.x, 1.15, pos.z);
      body.userData = { type: 'crah', id: c.id };
      s.add(body);
      this.pickables.push(body);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0xcbd5e1 }));
      edges.position.copy(body.position);
      s.add(edges);
      const grille = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.7), new THREE.MeshStandardMaterial({ map: grilleTex }));
      grille.position.set(pos.x + inward * 0.452, 1.1, pos.z);
      grille.rotation.y = inward * Math.PI / 2;
      s.add(grille);
      const status = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.08, 1.6), new THREE.MeshBasicMaterial({ color: 0x0ea5e9, toneMapped: false }));
      status.position.set(pos.x + inward * 0.456, 2.08, pos.z);
      s.add(status);
      const fans = [];
      for (let k = -1; k <= 1; k++) {
        const fan = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.02, 8, 32), new THREE.MeshStandardMaterial({ color: 0x94a3b8 }));
        ring.rotation.x = Math.PI / 2;
        fan.add(ring);
        for (let b = 0; b < 5; b++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.01, 0.05), new THREE.MeshStandardMaterial({ color: 0x64748b }));
          blade.position.x = 0.1;
          blade.rotation.x = 0.4;
          const arm = new THREE.Group();
          arm.rotation.y = (b / 5) * Math.PI * 2;
          arm.add(blade);
          fan.add(arm);
        }
        fan.position.set(pos.x, 2.32, pos.z + k * 0.58);
        s.add(fan);
        fans.push(fan);
      }
      const label = this.label(`<b>${c.id}</b><span class="m"></span>`, 'lbl unit');
      label.position.set(pos.x, 2.8, pos.z);
      s.add(label);
      this.crahs.set(c.id, { body, status, fans, label, on: true });
    }
  }

  buildPower() {
    const s = this.scene;
    this.ups = new Map();
    for (const [id, pos] of this.upsPos) {
      const body = this.mesh(new THREE.BoxGeometry(1.6, 2.0, 0.8), new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 }), { receive: true });
      body.position.set(pos.x, 1.0, pos.z);
      body.userData = { type: 'ups', id };
      s.add(body);
      this.pickables.push(body);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0xcbd5e1 }));
      edges.position.copy(body.position);
      s.add(edges);
      const bars = [];
      for (let k = 0; k < 6; k++) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, toneMapped: false });
        for (const face of [-1, 1]) {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.01), mat);
          bar.position.set(pos.x, 0.45 + k * 0.2, pos.z + face * 0.405);
          s.add(bar);
        }
        bars.push({ material: mat });
      }
      const label = this.label(`<b>${id}</b><span class="m"></span>`, 'lbl unit');
      label.position.set(pos.x, 2.4, pos.z);
      s.add(label);
      this.ups.set(id, { body, bars, label, on: true });
    }
    const busMat = new THREE.MeshStandardMaterial({ color: 0xdccaa4, metalness: 0.3, roughness: 0.5 });
    this.busZ = {};
    for (const [rowId, row] of Object.entries(this.row)) {
      [...this.upsPos.keys()].forEach((u, k) => {
        const z = row.z + (k === 0 ? -0.22 : 0.22);
        this.busZ[`${rowId}:${u}`] = z;
        const bus = this.mesh(new THREE.BoxGeometry(this.halfLen * 2 + 0.2, 0.03, 0.05), busMat);
        bus.position.set(0, BUS_Y, z);
        s.add(bus);
      });
    }
    for (const [, pos] of this.upsPos) {
      const trunk = this.mesh(new THREE.BoxGeometry(0.05, 0.03, 6.2), busMat);
      trunk.position.set(pos.x, BUS_Y, (pos.z - 1.5) / 2 + 0.05);
      s.add(trunk);
    }
  }

  buildNetwork() {
    const s = this.scene;
    const gp = this.gatewayPos;
    const body = this.mesh(new THREE.BoxGeometry(0.9, 2.6, 0.9), new THREE.MeshStandardMaterial({ color: 0x1f2633, metalness: 0.4, roughness: 0.5 }), { receive: true });
    body.position.set(gp.x, 1.3, gp.z);
    body.userData = { type: 'gateway', id: 'gateway' };
    s.add(body);
    this.pickables.push(body);
    const portMat = new THREE.MeshBasicMaterial({ color: 0x76b900, toneMapped: false });
    for (let k = 0; k < 10; k++) {
      const port = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.025, 0.01), portMat);
      port.position.set(gp.x, 0.4 + k * 0.2, gp.z + 0.456);
      s.add(port);
    }
    this.gatewayPorts = portMat;
    this.queueCol = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1, 24), new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.25 }));
    this.queueCol.position.set(gp.x + 0.75, 0.01, gp.z);
    s.add(this.queueCol);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 2.4, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    sleeve.position.set(gp.x + 0.75, 1.2, gp.z);
    s.add(sleeve);
    this.throttleRing = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.025, 8, 64), new THREE.MeshBasicMaterial({ color: COLORS.shed, toneMapped: false }));
    this.throttleRing.rotation.x = Math.PI / 2;
    this.throttleRing.position.set(gp.x, 2.75, gp.z);
    this.throttleRing.visible = false;
    s.add(this.throttleRing);
    this.gatewayLabel = this.label('<b>Edge gateway</b><span class="m"></span>', 'lbl unit');
    this.gatewayLabel.position.set(gp.x, 3.1, gp.z);
    s.add(this.gatewayLabel);

    const trayMat = new THREE.MeshStandardMaterial({ color: 0xcfd6df, metalness: 0.3, roughness: 0.5 });
    this.trayZ = {};
    for (const [rowId, row] of Object.entries(this.row)) {
      const z = row.front + row.dir * 0.32;
      this.trayZ[rowId] = z;
      const tray = this.mesh(new THREE.BoxGeometry(this.halfLen * 2 + 0.2, 0.03, 0.22), trayMat);
      tray.position.set(0, TRAY_Y, z);
      s.add(tray);
    }
    const spine = this.mesh(new THREE.BoxGeometry(0.22, 0.03, Math.abs(gp.z - this.trayZ.B) + 0.2), trayMat);
    spine.position.set(0, TRAY_Y, (gp.z + this.trayZ.B) / 2);
    s.add(spine);
  }

  buildContainment() {
    this.containment = {};
    const n = this.topo.hall.racks_per_row;
    for (const [rowId, row] of Object.entries(this.row)) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uT: { value: new Array(n).fill(30) }, uX0: { value: -this.halfLen }, uRW: { value: RW }, uN: { value: n }, uTime: { value: 0 }, uGain: { value: 1 } },
        vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `
          uniform float uT[${n}]; uniform float uX0; uniform float uRW; uniform int uN; uniform float uTime; uniform float uGain;
          varying vec3 vW;
          ${HEAT_GLSL}
          void main(){
            float fi = clamp((vW.x - uX0) / uRW - 0.5, 0.0, float(uN - 1));
            int i0 = int(floor(fi)); int i1 = min(i0 + 1, uN - 1);
            float t = mix(uT[i0], uT[i1], fract(fi));
            float hot = smoothstep(30.0, 56.0, t);
            float yf = clamp(vW.y / 2.7, 0.0, 1.0);
            float shimmer = 0.85 + 0.15 * sin(uTime * 2.3 + vW.x * 3.1 + vW.y * 6.0);
            float a = (0.04 + 0.22 * hot) * (0.35 + 0.65 * yf) * shimmer * uGain;
            gl_FragColor = vec4(heat(18.0 + (t - 18.0) * 1.7), a);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const box = new THREE.Mesh(new THREE.BoxGeometry(this.halfLen * 2, 2.7, 1.2), mat);
      box.position.set(0, 1.35, row.hot);
      box.renderOrder = 2;
      this.scene.add(box);
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0xc3ccd8 }));
      frame.position.copy(box.position);
      this.scene.add(frame);
      this.containment[rowId] = mat;
    }
  }

  buildFlows() {
    const px = this.pointScale();
    this.packets = new Travelers(1800, px);
    this.scene.add(this.packets.p.points);
    const gp = this.gatewayPos;
    this.ingressRoute = this.packets.addRoute([[0, 6, -16], [0, 3.6, -9], [gp.x, 2.62, gp.z]]);
    this.workerRoute = new Map();
    for (const w of this.topo.workers) {
      const nd = this.nodeById.get(w.node);
      const rack = this.rackById.get(nd.rack);
      const row = this.row[rack.row];
      const x = this.rackX(rack.index), y = nodeY(nd.slot), tz = this.trayZ[rack.row];
      this.workerRoute.set(w.id, this.packets.addRoute([
        [gp.x, 2.62, gp.z], [gp.x, TRAY_Y + 0.05, gp.z], [gp.x, TRAY_Y + 0.05, tz], [x, TRAY_Y + 0.05, tz], [x, y, tz], [x, y, row.front + row.dir * 0.04],
      ]));
    }

    this.power = new Travelers(700, px);
    this.scene.add(this.power.p.points);
    this.powerRoute = new Map();
    for (const r of this.topo.racks) {
      for (const [u, pos] of this.upsPos) {
        const z = this.busZ[`${r.row}:${u}`], x = this.rackX(r.index);
        this.powerRoute.set(`${r.id}:${u}`, this.power.addRoute([[pos.x, 2.0, pos.z], [pos.x, BUS_Y, pos.z], [pos.x, BUS_Y, z], [x, BUS_Y, z], [x, RH + 0.03, z]]));
      }
    }
    this.powerAcc = new Map();

    // Air: CRAH → under-floor → tile → rack front → rack back → hot aisle → ceiling → CRAH.
    const N = 2200;
    this.air = new Particles(N, px);
    this.scene.add(this.air.points);
    this.airRoutes = [];
    const crahFor = (rowId) => this.topo.crahs.find((c) => c.row === rowId)?.id ?? this.topo.crahs[0].id;
    for (let i = 0; i < N; i++) {
      const r = this.topo.racks[i % this.topo.racks.length];
      const row = this.row[r.row];
      const cp = this.crahPos.get(crahFor(r.row));
      const x = this.rackX(r.index) + (Math.random() - 0.5) * RW * 0.85;
      const h = 0.2 + Math.random() * 1.9;
      const zc = row.front + row.dir * (0.1 + Math.random() * 0.45);
      const route = polyline([
        [cp.x - Math.sign(cp.x) * 0.5, -0.3, cp.z + (Math.random() - 0.5) * 1.4],
        [x, -0.3, zc],
        [x, 0.04, zc],
        [x, h, row.front + row.dir * 0.05],
        [x, h, row.back],
        [x + (Math.random() - 0.5) * 0.3, Math.min(2.6, h + 0.5), row.hot + (Math.random() - 0.5) * 0.8],
        [x, CEIL_Y - 0.1, row.hot],
        [cp.x, CEIL_Y - 0.05, row.hot + (Math.random() - 0.5) * 0.6],
        [cp.x, 2.45, cp.z],
      ]);
      route.rack = r.id;
      route.row = r.row;
      route.d = Math.random() * route.len;
      route.speed = 0.75 + Math.random() * 0.5;
      this.airRoutes.push(route);
    }
    this.rackColor = new Map(this.topo.racks.map((r) => [r.id, { inlet: new THREE.Color(0x2563eb), exhaust: new THREE.Color(0xf97316) }]));
    this.returnColor = { A: new THREE.Color(), B: new THREE.Color() };
  }

  buildSelection() {
    this.selBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x76b900, linewidth: 2 }));
    this.selBox.visible = false;
    this.scene.add(this.selBox);
  }

  label(html, cls) {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    return new CSS2DObject(el);
  }

  pointScale() {
    const h = (this.container.clientHeight || 1) * this.renderer.getPixelRatio();
    return h / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
  }

  // ----------------------------------------------------------------- picking

  bindPicking() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const rect = el.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this.pickables, false)[0];
      if (!hit) return this.select(null);
      if (hit.object === this.chassis) {
        const nd = this.topo.nodes[hit.instanceId];
        return this.select(nd.worker ? { type: 'worker', id: nd.worker } : { type: 'node', id: nd.id });
      }
      this.select(hit.object.userData);
    });
  }

  on(event, cb) { (this.listeners[event] ??= []).push(cb); }

  select(sel) {
    this.selected = sel;
    this.selBox.visible = !!sel;
    if (sel) {
      const p = this.entityPos(sel.type, sel.id);
      if (sel.type === 'worker' || sel.type === 'node') {
        const id = sel.type === 'worker' ? this.workerNode.get(sel.id) : sel.id;
        const dir = this.row[this.rackById.get(this.nodeById.get(id).rack).row].dir;
        this.selBox.position.set(p.x, p.y, p.z - dir * RD * 0.47);
        this.selBox.scale.set(RW * 0.95, NODE_H + 0.05, RD * 0.98);
      } else if (sel.type === 'rack') {
        this.selBox.position.copy(p).setY(RH / 2);
        this.selBox.scale.set(RW + 0.05, RH + 0.05, RD + 0.05);
      } else if (sel.type === 'crah') {
        this.selBox.position.copy(p).setY(1.15);
        this.selBox.scale.set(0.98, 2.38, 1.98);
      } else if (sel.type === 'ups') {
        this.selBox.position.copy(p).setY(1.0);
        this.selBox.scale.set(1.68, 2.08, 0.88);
      } else if (sel.type === 'gateway') {
        this.selBox.position.copy(p).setY(1.3);
        this.selBox.scale.set(0.98, 2.68, 0.98);
      }
    }
    for (const cb of this.listeners.select) cb(sel);
  }

  // ------------------------------------------------------------------ camera

  flyTo(pos, target, dur = 1.8) {
    this.setCinematic(false);
    this.tween = { t: 0, dur, p0: this.camera.position.clone(), p1: new THREE.Vector3(...pos), t0: this.controls.target.clone(), t1: new THREE.Vector3(...target) };
  }

  preset(name) {
    const p = PRESETS[name];
    if (p) this.flyTo(p.pos, p.target);
  }

  focus(type, id) {
    const p = this.entityPos(type, id);
    if (type === 'worker' || type === 'node' || type === 'rack') {
      const rackId = type === 'rack' ? id : this.nodeById.get(type === 'worker' ? this.workerNode.get(id) : id).rack;
      const row = this.row[this.rackById.get(rackId).row];
      const along = p.x > 0 ? -1 : 1;
      return this.flyTo([p.x + along * 2.6, Math.max(1.4, p.y + 0.8), row.front + row.dir * 1.1], [p.x, p.y, row.front]);
    }
    if (type === 'crah') return this.flyTo([p.x + Math.sign(p.x) * 2.6, 3.9, p.z - Math.sign(p.z) * 4.6], [p.x * 0.7, 1.0, p.z * 0.5]);
    if (type === 'ups') return this.flyTo([p.x * 0.6, 2.4, p.z + 4.2], [p.x, 1.0, p.z]);
    if (type === 'gateway') return this.flyTo([2.8, 3.0, -8.2], [0, 1.4, -4.7]);
    this.preset('overview');
  }

  setCinematic(on) {
    this.cinematic = on;
    if (on) { this.tween = null; this.orbitAngle = Math.atan2(this.camera.position.z, this.camera.position.x); }
    for (const cb of this.listeners.cinematic) cb(on);
  }

  setThermal(on) {
    this.thermal = on;
    this.heatPlane.visible = on;
    for (const m of Object.values(this.containment)) m.uniforms.uGain.value = on ? 1 : 0.35;
  }

  setLabels(on) {
    this.labelRenderer.domElement.style.display = on ? '' : 'none';
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    const px = this.pointScale();
    for (const sys of [this.air, this.packets.p, this.power.p]) sys.mat.uniforms.uPx.value = px;
  }

  // ------------------------------------------------------------------ update

  update(frame) {
    this.frame = frame;
    const P = this.packets;
    const cap = (n, m) => Math.min(n, m);
    for (let k = 0; k < cap(frame.gateway.in, 14); k++) P.spawn(this.ingressRoute, COLORS.ingress, { dur: 0.9, delay: Math.random() * 0.1, size: 0.06 });
    for (let k = 0; k < cap(frame.gateway.shed, 10); k++) P.spawn(this.ingressRoute, COLORS.shed, { reverse: true, dur: 0.9, delay: Math.random() * 0.1, size: 0.09 });
    for (const [wid, f] of Object.entries(frame.flows)) {
      const r = this.workerRoute.get(wid);
      for (let k = 0; k < cap(f.disp, 8); k++) P.spawn(r, COLORS.request, { dur: 1.1, delay: Math.random() * 0.1 });
      for (let k = 0; k < cap(f.ok, 8); k++) P.spawn(r, COLORS.ok, { reverse: true, dur: 1.1, delay: Math.random() * 0.1, size: 0.065 });
      for (let k = 0; k < cap(f.silent, 8); k++) P.spawn(r, COLORS.silent, { reverse: true, dur: 1.1, delay: Math.random() * 0.1, size: 0.1 });
      for (let k = 0; k < cap(f.err, 8); k++) P.spawn(r, COLORS.err, { reverse: true, dur: 0.8, delay: Math.random() * 0.1, size: 0.11 });
    }

    for (const r of frame.racks) {
      const meshes = this.rackMeshes.get(r.id);
      const cols = this.rackColor.get(r.id);
      airColor(r.inlet, cols.inlet);
      airColor(r.exhaust, cols.exhaust);
      meshes.exhaust.material.color.copy(cols.exhaust);
      meshes.exhaust.material.opacity = 0.12 + 0.35 * THREE.MathUtils.smoothstep(r.exhaust, 30, 58);
      meshes.tor.material.color.set(r.net ? STATUS.bad : r.capped ? STATUS.warn : STATUS.ok);
    }
    for (const [rowId, mat] of Object.entries(this.containment)) {
      const temps = frame.racks.filter((r) => r.id.startsWith(rowId)).map((r) => r.exhaust);
      mat.uniforms.uT.value = temps;
      airColor(temps.reduce((a, b) => a + b, 0) / temps.length, this.returnColor[rowId]);
    }

    const byCrah = new Map(frame.hall.crahs.map((c) => [c.id, c]));
    for (const [id, u] of this.crahs) {
      u.on = byCrah.get(id)?.running;
      u.status.material.color.set(u.on ? 0x0ea5e9 : STATUS.bad);
      u.label.element.classList.toggle('bad', !u.on);
      u.label.element.querySelector('.m').textContent = u.on ? `${frame.hall.supply_c.toFixed(1)} °C supply` : 'TRIPPED';
    }
    const liveFeeds = Object.values(frame.hall.ups).filter(Boolean).length || 1;
    for (const [id, u] of this.ups) {
      u.on = frame.hall.ups[id];
      u.label.element.classList.toggle('bad', !u.on);
      u.label.element.querySelector('.m').textContent = u.on ? `${(frame.hall.it_kw / liveFeeds).toFixed(0)} kW` : 'FEED LOST';
      const load = u.on ? frame.hall.it_kw / liveFeeds / 400 : 0;
      u.bars.forEach((b, k) => b.material.color.set(u.on ? (k / u.bars.length < load ? (load > 0.85 ? 0xea580c : 0xf59e0b) : 0xe2e8f0) : 0xfecdd3));
    }
    const q = frame.kpi.queue + frame.gateway.queue;
    const hq = q > 0 ? Math.max(0.03, (Math.log10(q + 1) / Math.log10(5000)) * 2.4) : 0.001;
    this.queueCol.scale.y = hq;
    this.queueCol.position.y = hq / 2;
    this.queueCol.material.color.set(q > 500 ? 0xe11d48 : 0xf59e0b);
    this.throttleRing.visible = frame.gateway.throttle_rps != null;
    this.gatewayLabel.element.querySelector('.m').textContent =
      `${frame.kpi.rps_in.toFixed(0)} rps · queue ${q}` + (frame.gateway.throttle_rps != null ? ` · limit ${frame.gateway.throttle_rps.toFixed(0)}` : '');

    const feeds = Object.entries(frame.hall.ups).filter(([, on]) => on).map(([u]) => u);
    for (const r of frame.racks) {
      for (const u of feeds) {
        const key = `${r.id}:${u}`;
        const acc = (this.powerAcc.get(key) ?? 0) + (r.power_kw / feeds.length) * 0.012;
        const n = Math.floor(acc);
        this.powerAcc.set(key, acc - n);
        for (let k = 0; k < n; k++) this.power.spawn(this.powerRoute.get(key), r.capped ? COLORS.powerCapped : COLORS.power, { dur: 1.6, delay: Math.random() * 0.1, size: 0.05 });
      }
    }

    this.drawHeat(frame);
    this.updateTags(frame);
    this.syncMarkers(frame);
  }

  drawHeat(frame) {
    const ctx = this.heatCtx, cw = this.heatCanvas.width, ch = this.heatCanvas.height;
    const W = this.hallW, D = this.hallD;
    const u = (x) => ((x + W / 2) / W) * cw, v = (z) => ((z + D / 2) / D) * ch;
    ctx.clearRect(0, 0, cw, ch);
    const blob = (x, z, rx, temp, a) => {
      const c = airColor(temp, _c2);
      const col = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
      const r = (rx / W) * cw;
      const g = ctx.createRadialGradient(u(x), v(z), 0, u(x), v(z), r);
      g.addColorStop(0, `rgba(${col},${a})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(u(x) - r, v(z) - r, 2 * r, 2 * r);
    };
    frame.racks.forEach((r, i) => {
      const meta = this.topo.racks[i];
      const row = this.row[meta.row];
      const x = this.rackX(meta.index);
      blob(x, row.hot, 1.0, r.exhaust, 0.55 * THREE.MathUtils.smoothstep(r.exhaust, 26, 50) + 0.1);
    });
    this.heatTex.needsUpdate = true;
  }

  updateTags(frame) {
    for (const w of frame.workers) {
      const tag = this.workerTags.get(w.id);
      if (!tag) continue;
      const el = tag.element;
      let cls = 'ok', state;
      if (w.draining) { cls = 'restart'; state = `draining · ${w.running + w.waiting} in flight`; }
      else if (w.state === 'restarting') { cls = 'restart'; state = `restarting · ${Math.ceil(w.ready_in ?? 0)}s`; }
      else if (w.state === 'crashed') { cls = 'bad'; state = 'crashed'; }
      else if (w.state === 'cordoned') { cls = 'off'; state = 'cordoned'; }
      else if (w.state === 'hung') { cls = 'warn'; state = 'health ✓ · 0 tok/s'; }
      else if (!w.canary) { cls = 'warn'; state = w.tool_ok ? 'canary ✗' : '200 OK · tools ✗'; }
      else state = `${w.ttft_p95 != null ? (w.ttft_p95 * 1000).toFixed(0) + ' ms' : '–'}`;
      if (!w.draining && w.weight === 0 && w.state !== 'cordoned') state += ' · drained';
      el.className = `lbl wtag ${cls}`;
      el.querySelector('em').textContent = state;
      el.querySelector('.m').textContent = w.state === 'ready' ? `${(w.tps / 1000).toFixed(1)}k tok/s` : '';
    }
  }

  syncMarkers(frame) {
    const active = new Set();
    for (const f of frame.faults) {
      if (f.resolved_at != null) continue;
      active.add(f.id);
      if (this.markers.has(f.id)) continue;
      const pos = this.faultPos(f);
      const group = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), new THREE.MeshBasicMaterial({ color: 0xe11d48, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, 0.02, pos.z);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 3.4, 8), new THREE.MeshBasicMaterial({ color: 0xe11d48, transparent: true, opacity: 0.5 }));
      beam.position.set(pos.x, 1.9, pos.z);
      beam.visible = f.kind !== 'tool_parser';
      const callout = this.label(`<b>${f.title}</b><span>${f.candidate_id ?? ''}</span>`, 'lbl callout');
      callout.position.set(pos.x, 3.7, pos.z);
      group.add(ring, beam, callout);
      this.scene.add(group);
      this.markers.set(f.id, { group, ring, beam, callout });
    }
    for (const [id, m] of this.markers) {
      if (active.has(id)) continue;
      m.group.remove(m.callout);
      m.callout.element.remove();
      this.scene.remove(m.group);
      this.markers.delete(id);
    }
  }

  faultPos(f) {
    const t = f.targets?.[0] ?? f.target;
    if (f.kind === 'tool_parser') {
      const ps = f.targets.map((w) => this.nodePos(this.workerNode.get(w)));
      return ps.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / ps.length).setZ(0);
    }
    if (this.workerNode.has(t)) return this.nodePos(this.workerNode.get(t));
    if (this.nodeById.has(t)) return this.nodePos(t);
    if (this.rackById.has(t)) return this.entityPos('rack', t);
    if (this.crahPos.has(t)) return this.crahPos.get(t).clone();
    if (this.upsPos.has(t)) return this.upsPos.get(t).clone();
    if (f.kind === 'compound') return this.crahPos.get(this.topo.crahs[0].id).clone();
    return this.gatewayPos.clone();
  }

  // -------------------------------------------------------------------- tick

  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    if (!this.container.clientWidth) return; // hidden view: skip rendering
    const f = this.frame;

    if (this.tween) {
      const tw = this.tween;
      tw.t += dt / tw.dur;
      const e = tw.t >= 1 ? 1 : tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.t0, tw.t1, e);
      if (tw.t >= 1) this.tween = null;
    } else if (this.cinematic) {
      this.orbitAngle += dt * 0.07;
      const r = 13;
      this.camera.position.set(Math.cos(this.orbitAngle) * r, 6.2 + Math.sin(this.time * 0.21) * 1.0, Math.sin(this.orbitAngle) * r);
      this.controls.target.lerp(_v.set(0, 0.8, 0), 0.05);
    }
    this.controls.update();

    if (f) {
      this.updateGpus(f);
      this.updateAir(dt, f);
      for (const [, u] of this.crahs) if (u.on) u.fans.forEach((fan) => (fan.rotation.y += dt * 9));
      for (const [, u] of this.ups) if (!u.on) u.bars.forEach((b) => b.material.color.set(Math.sin(this.time * 7) > 0 ? 0xe11d48 : 0xfecdd3));
      for (const [, m] of this.markers) {
        const k = (this.time * 0.8) % 1;
        m.ring.scale.setScalar(1 + k * 1.6);
        m.ring.material.opacity = 1 - k;
      }
      this.throttleRing.rotation.z += dt * 1.5;
      this.gatewayPorts.color.setHSL(0.24, 1, 0.36 + 0.08 * Math.sin(this.time * 12));
      for (const m of Object.values(this.containment)) m.uniforms.uTime.value = this.time;
    }
    this.packets.update(dt);
    this.power.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  updateGpus(f) {
    const { temp, util, flag } = f.gpu;
    const blink = Math.sin(this.time * 10) > 0;
    for (let i = 0; i < temp.length; i++) {
      if (flag[i] === 3) { this.gpuBars.setColorAt(i, _c.set(blink ? STATUS.xid : 0x2a0d2e)); continue; }
      heatColor(temp[i], _c);
      let b = 0.3 + 0.85 * util[i];
      if (flag[i] === 1) b *= 0.65 + 0.35 * Math.sin(this.time * 14 + i);
      this.gpuBars.setColorAt(i, _c.multiplyScalar(b));
    }
    this.gpuBars.instanceColor.needsUpdate = true;

    const workers = new Map(f.workers.map((w) => [w.id, w]));
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
    this.topo.nodes.forEach((nd, i) => {
      const [cordoned, paused] = f.nodes[nd.id];
      let col = STATUS.batch;
      const xid = nd.gpus.some((g) => flag[g] === 3);
      if (xid) col = blink ? STATUS.xid : 0x2a0d2e;
      else if (cordoned) col = STATUS.off;
      else if (nd.worker) {
        const w = workers.get(nd.worker);
        if (w.state === 'crashed') col = blink ? STATUS.bad : 0x3b0a14;
        else if (w.state === 'restarting' || w.draining) col = null;
        else if (w.state === 'hung') col = STATUS.ok; // the health check still says OK
        else col = w.canary ? STATUS.ok : STATUS.warn;
      } else if (paused) col = STATUS.off;
      if (col === null) _c.set(STATUS.restart).multiplyScalar(0.4 + pulse * 0.6);
      else _c.set(col);
      this.leds.setColorAt(i, _c);
    });
    this.leds.instanceColor.needsUpdate = true;
  }

  updateAir(dt, f) {
    const air = this.air;
    const sup = airColor(f.hall.supply_c, _c2.clone());
    for (let i = 0; i < this.airRoutes.length; i++) {
      const r = this.airRoutes[i];
      const flow = f.hall.airflow[r.row] ?? 1;
      r.d = (r.d + dt * 1.25 * r.speed * flow) % r.len;
      const seg = sample(r, r.d, _v);
      const cols = this.rackColor.get(r.rack);
      let a, size = 0.045;
      if (seg <= 1) { a = 0; }
      else if (seg <= 3) { _c.copy(sup).lerp(cols.inlet, seg === 3 ? _segF : 0); a = 0.35; }
      else if (seg === 4) { _c.copy(cols.inlet).lerp(cols.exhaust, _segF); a = 0.25; }
      else if (seg <= 6) { _c.copy(cols.exhaust); a = 0.5; size = 0.055; }
      else { _c.copy(cols.exhaust).lerp(this.returnColor[r.row], _segF); a = 0.3; }
      air.set(i, _v, _c, size, a * (0.4 + 0.6 * flow));
    }
    air.flush();
  }
}
