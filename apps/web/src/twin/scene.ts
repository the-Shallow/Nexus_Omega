// The living datacenter: a Three.js view of the SimPy twin, driven entirely by
// streamed frames. Nothing here invents state. Colors, particles and labels are
// functions of the latest frame (racks, GPUs, workers, flows, faults).
//
// Written as an imperative scene instead of React Three Fiber: the twin redraws
// hundreds of instanced GPUs and thousands of particles every frame from a 10 Hz
// stream, which is simpler and cheaper without per-frame reconciliation.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { FaultRecord, Frame, Topology, WorkerFrame } from '../lib/types';
import { airColor, exhaustColor, FLOW, heatColor, STATUS, WARM_GLSL } from './palette';

export type EntityType = 'worker' | 'node' | 'rack' | 'crah' | 'ups' | 'gateway';
export interface Entity { type: EntityType; id: string }
export interface HoverEvent { entity: Entity | null; x: number; y: number }

const RW = 0.8, RD = 1.2, RH = 2.2;
const NODE_H = 0.4;
const TRAY_Y = 2.9, BUS_Y = 3.2, CEIL_Y = 3.15;
const BG = 0x07090a;
const nodeY = (slot: number) => 0.52 + slot * 0.47;
const ORBIT_TARGET = new THREE.Vector3(0, 0.6, 0);

const _c = new THREE.Color(), _c2 = new THREE.Color(), _m = new THREE.Matrix4(), _v = new THREE.Vector3();
let _segF = 0;

type V3 = [number, number, number];
export const PRESETS: Record<string, { pos: V3; target: V3 }> = {
  overview: { pos: [9.2, 6.6, -10.4], target: [0, 0.6, 0.2] },
  cold: { pos: [-5.2, 1.4, 0.05], target: [2.5, 1.2, 0] },
  hot: { pos: [-5.0, 1.8, -2.4], target: [2.0, 1.4, -2.4] },
  top: { pos: [0.01, 15.5, 0.6], target: [0, 0, 0] },
  power: { pos: [-5.5, 4.4, 9.6], target: [0, 1.4, 3.0] },
  network: { pos: [3.4, 3.4, -8.4], target: [0, 1.7, -3.2] },
};

interface Route { pts: THREE.Vector3[]; cum: number[]; len: number }
interface AirRoute extends Route { rack: string; row: string; d: number; speed: number }

function polyline(points: (V3 | THREE.Vector3)[]): Route {
  const pts = points.map((p) => (p instanceof THREE.Vector3 ? p : new THREE.Vector3(...p)));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return { pts, cum, len: cum[cum.length - 1] };
}

function sample(route: Route, d: number, out: THREE.Vector3): number {
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
  gl_PointSize = clamp(size * uPx / -mv.z, 1.0, 22.0);
  gl_Position = projectionMatrix * mv;
}`;
const POINT_FS = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

class Particles {
  count: number;
  pos: Float32Array; col: Float32Array; size: Float32Array; alpha: Float32Array;
  geo = new THREE.BufferGeometry();
  mat: THREE.ShaderMaterial;
  points: THREE.Points;
  constructor(count: number, px: number) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    const attrs: [string, Float32Array, number][] = [['position', this.pos, 3], ['color', this.col, 3], ['size', this.size, 1], ['alpha', this.alpha, 1]];
    for (const [name, arr, n] of attrs) this.geo.setAttribute(name, new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uPx: { value: px } }, vertexShader: POINT_VS, fragmentShader: POINT_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  set(i: number, p: THREE.Vector3, c: THREE.Color, size: number, alpha: number) {
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    this.size[i] = size; this.alpha[i] = alpha;
  }
  flush() {
    for (const k of ['position', 'color', 'size', 'alpha']) (this.geo.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Short-lived particles travelling along shared routes (requests, responses, power). */
class Travelers {
  p: Particles;
  route: Int32Array; t: Float32Array; dur: Float32Array; delay: Float32Array; rev: Uint8Array; sz: Float32Array;
  color: THREE.Color[];
  free: number[];
  routes: Route[] = [];
  constructor(count: number, px: number) {
    this.p = new Particles(count, px);
    this.route = new Int32Array(count).fill(-1);
    this.t = new Float32Array(count);
    this.dur = new Float32Array(count);
    this.delay = new Float32Array(count);
    this.rev = new Uint8Array(count);
    this.sz = new Float32Array(count);
    this.color = Array.from({ length: count }, () => new THREE.Color());
    this.free = Array.from({ length: count }, (_, i) => count - 1 - i);
  }
  addRoute(points: (V3 | THREE.Vector3)[]) {
    this.routes.push(polyline(points));
    return this.routes.length - 1;
  }
  spawn(route: number, color: THREE.Color, { reverse = false, dur = 1.1, delay = 0, size = 0.07, gain = 1 } = {}) {
    const i = this.free.pop();
    if (i === undefined) return;
    this.route[i] = route; this.t[i] = 0; this.dur[i] = dur; this.delay[i] = delay;
    this.rev[i] = reverse ? 1 : 0; this.sz[i] = size; this.color[i].copy(color).multiplyScalar(gain);
  }
  clear() {
    for (let i = 0; i < this.route.length; i++) if (this.route[i] >= 0) { this.route[i] = -1; this.free.push(i); }
  }
  update(dt: number) {
    const p = this.p;
    for (let i = 0; i < p.count; i++) {
      const r = this.route[i];
      if (r < 0) { p.alpha[i] = 0; continue; }
      if (this.delay[i] > 0) { this.delay[i] -= dt; p.alpha[i] = 0; continue; }
      this.t[i] += dt / this.dur[i];
      if (this.t[i] >= 1) { this.route[i] = -1; p.alpha[i] = 0; this.free.push(i); continue; }
      const route = this.routes[r];
      sample(route, (this.rev[i] ? 1 - this.t[i] : this.t[i]) * route.len, _v);
      p.set(i, _v, this.color[i], this.sz[i], Math.min(1, this.t[i] * 8, (1 - this.t[i]) * 8));
    }
    p.flush();
  }
}

// Floor overlay: faint grid, thermal map, and expanding rings for faults and recovery.
const FLOOR_VS = `varying vec2 vUv; varying vec3 vW;
void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FLOOR_FS = `
uniform float uTime; uniform sampler2D uHeat; uniform float uHeatGain;
uniform vec4 uWaves[6]; uniform vec3 uWaveCol[6];
varying vec2 vUv; varying vec3 vW;
void main(){
  vec2 q = vW.xz / 0.6;
  vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float fade = 1.0 - smoothstep(5.0, 15.0, length(vW.xz));
  vec3 col = vec3(0.22, 0.42, 0.10) * line * 0.16 * fade;
  vec4 h = texture2D(uHeat, vUv);
  col += h.rgb * h.a * uHeatGain;
  for (int i = 0; i < 6; i++) {
    vec4 w = uWaves[i];
    float age = uTime - w.z;
    if (w.z < 0.0 || age < 0.0 || age > w.w) continue;
    float k = age / w.w;
    float r = age * (w.w > 3.0 ? 5.5 : 3.6);
    float d = abs(length(vW.xz - w.xy) - r);
    float ring = exp(-d * d * 14.0) * (1.0 - k) * (1.0 - k);
    float core = exp(-dot(vW.xz - w.xy, vW.xz - w.xy) * 1.5) * (1.0 - k) * 0.5;
    col += uWaveCol[i] * (ring * 1.4 + core);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class TwinScene {
  topo: Topology;
  container: HTMLElement;
  frame: Frame | null = null;
  time = 0;
  idleOrbit = true;
  incident = false;
  disposed = false;

  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private labelRenderer: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private lastTick = performance.now();
  private ro: ResizeObserver;
  private listeners: { hover: ((e: HoverEvent) => void)[]; select: ((e: Entity | null) => void)[] } = { hover: [], select: [] };
  private tween: { t: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3 } | null = null;
  private orbitAngle = 0;
  private lastInteraction = -999;

  // layout
  private halfLen = 0;
  private hallW = 0; private hallD = 0;
  private row: Record<string, { z: number; front: number; back: number; hot: number; dir: number }> = {};
  private rackById = new Map<string, Topology['racks'][number]>();
  private nodeById = new Map<string, Topology['nodes'][number]>();
  private workerNode = new Map<string, string>();
  private crahPos = new Map<string, THREE.Vector3>();
  private upsPos = new Map<string, THREE.Vector3>();
  private gatewayPos = new THREE.Vector3(0, 0, -4.7);
  private rackX = (_i: number) => 0;

  // meshes
  private pickables: THREE.Object3D[] = [];
  private rackMeshes = new Map<string, { exhaust: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; tor: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>; outline: THREE.LineBasicMaterial; target: THREE.Color }>();
  private chassis!: THREE.InstancedMesh;
  private gpuBars!: THREE.InstancedMesh;
  private leds!: THREE.InstancedMesh;
  private workerTags = new Map<string, CSS2DObject>();
  private crahs = new Map<string, { status: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>; fans: THREE.Group[]; label: CSS2DObject; on: boolean }>();
  private ups = new Map<string, { bars: THREE.MeshBasicMaterial[]; label: CSS2DObject; on: boolean }>();
  private busZ: Record<string, number> = {};
  private trayZ: Record<string, number> = {};
  private gatewayPorts!: THREE.MeshBasicMaterial;
  private queueCol!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  private throttleRing!: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private gatewayLabel!: CSS2DObject;
  private containment: Record<string, THREE.ShaderMaterial> = {};
  private aisleLights: Record<string, THREE.PointLight> = {};
  private floorFx!: THREE.ShaderMaterial;
  private waveSlot = 0;
  private heatCanvas!: HTMLCanvasElement;
  private heatCtx!: CanvasRenderingContext2D;
  private heatTex!: THREE.CanvasTexture;
  private packets!: Travelers;
  private power!: Travelers;
  private air!: Particles;
  private airRoutes: AirRoute[] = [];
  private ingressRoute = 0;
  private workerRoute = new Map<string, number>();
  private workerLine = new Map<string, { mat: THREE.LineBasicMaterial; target: THREE.Color; opacity: number }>();
  private powerRoute = new Map<string, number>();
  private powerAcc = new Map<string, number>();
  private rackColor = new Map<string, { inlet: THREE.Color; exhaust: THREE.Color }>();
  private returnColor: Record<string, THREE.Color> = {};
  private hoverBox!: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  private markers = new Map<string, { group: THREE.Group; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; beam: THREE.Mesh; callout: CSS2DObject }>();
  private flashUntil = -1;
  private viewShift = 0;
  private viewShiftTarget = 0;

  constructor(container: HTMLElement, topo: Topology) {
    this.topo = topo;
    this.container = container;
    const w = container.clientWidth || 1, h = container.clientHeight || 1;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.setSize(w, h);
    labels.domElement.className = 'twin-labels';
    container.appendChild(labels.domElement);
    this.labelRenderer = labels;

    const scene = this.scene;
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, 16, 46);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.18;

    this.camera = new THREE.PerspectiveCamera(36, w / h, 0.05, 200);
    this.camera.position.set(...PRESETS.overview.pos);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(...PRESETS.overview.target);
    controls.maxDistance = 34;
    controls.minDistance = 1.2;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.addEventListener('start', () => { this.tween = null; this.idleOrbit = false; this.lastInteraction = this.time; });
    this.controls = controls;
    this.orbitAngle = Math.atan2(this.camera.position.z, this.camera.position.x);

    scene.add(new THREE.HemisphereLight(0xa9bccb, 0x07090a, 0.75));
    const key = new THREE.DirectionalLight(0xe4ecf2, 1.6);
    key.position.set(7, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -12, right: 12, top: 10, bottom: -10, near: 1, far: 40 });
    key.shadow.bias = -0.0005;
    key.shadow.radius = 5;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9be22d, 0.32);
    rim.position.set(-9, 5, -8);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0x5aa7ff, 0.22);
    fill.position.set(-6, 3, 9);
    scene.add(fill);

    this.layout();
    this.buildFloor();
    this.buildRacks();
    this.buildCooling();
    this.buildPower();
    this.buildNetwork();
    this.buildContainment();
    this.buildFlows();
    this.hoverBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    this.hoverBox.visible = false;
    scene.add(this.hoverBox);

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.7, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.bindPointer();
    renderer.setAnimationLoop(() => this.tick());
  }

  // ------------------------------------------------------------------ layout

  private layout() {
    const n = this.topo.hall.racks_per_row;
    this.halfLen = (n * RW) / 2;
    this.row = {
      A: { z: -1.2, front: -0.6, back: -1.8, hot: -2.4, dir: 1 },
      B: { z: 1.2, front: 0.6, back: 1.8, hot: 2.4, dir: -1 },
    };
    this.rackX = (i: number) => (i - (n - 1) / 2) * RW;
    this.rackById = new Map(this.topo.racks.map((r) => [r.id, r]));
    this.nodeById = new Map(this.topo.nodes.map((nd) => [nd.id, nd]));
    this.workerNode = new Map(this.topo.workers.map((w) => [w.id, w.node]));
    this.crahPos = new Map(this.topo.crahs.map((c, k) => [c.id, new THREE.Vector3((k % 2 === 0 ? -1 : 1) * (this.halfLen + 1.5), 0, this.row[c.row].z)]));
    this.upsPos = new Map(this.topo.ups.map((u, k) => [u, new THREE.Vector3(k === 0 ? -2.1 : 2.1, 0, 4.7)]));
  }

  private nodePos(nodeId: string, out = new THREE.Vector3()) {
    const node = this.nodeById.get(nodeId)!;
    const rack = this.rackById.get(node.rack)!;
    return out.set(this.rackX(rack.index), nodeY(node.slot), this.row[rack.row].front);
  }

  entityPos(e: Entity): THREE.Vector3 {
    if (e.type === 'worker') return this.nodePos(this.workerNode.get(e.id)!);
    if (e.type === 'node') return this.nodePos(e.id);
    if (e.type === 'rack') {
      const r = this.rackById.get(e.id)!;
      return new THREE.Vector3(this.rackX(r.index), 1.1, this.row[r.row].z);
    }
    if (e.type === 'crah') return this.crahPos.get(e.id)!.clone().setY(1.1);
    if (e.type === 'ups') return this.upsPos.get(e.id)!.clone().setY(1.0);
    return this.gatewayPos.clone().setY(1.3);
  }

  // ------------------------------------------------------------------- build

  private mesh<G extends THREE.BufferGeometry, M extends THREE.Material | THREE.Material[]>(geo: G, mat: M, { cast = true, receive = false } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  }

  private edges(geo: THREE.BufferGeometry, color: number, at: THREE.Vector3, opacity = 1) {
    const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
    line.position.copy(at);
    this.scene.add(line);
    return mat;
  }

  private label(html: string, cls: string) {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    return new CSS2DObject(el);
  }

  private buildFloor() {
    const s = this.scene;
    const W = this.halfLen * 2 + 5.4, D = 10.2;
    this.hallW = W; this.hallD = D;

    const ground = this.mesh(new THREE.PlaneGeometry(140, 140), new THREE.MeshStandardMaterial({ color: 0x060809, roughness: 1 }), { cast: false, receive: true });
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.13;
    s.add(ground);

    const slab = this.mesh(new THREE.BoxGeometry(W, 0.12, D), new THREE.MeshStandardMaterial({ color: 0x0b0e11, roughness: 0.42, metalness: 0.35 }), { cast: false, receive: true });
    slab.position.y = -0.06;
    s.add(slab);
    this.edges(slab.geometry, 0x1f282e, slab.position);

    // Thermal floor map, redrawn from rack exhaust temperatures each frame.
    const hc = document.createElement('canvas');
    hc.width = 384; hc.height = 300;
    this.heatCanvas = hc;
    this.heatCtx = hc.getContext('2d')!;
    this.heatTex = new THREE.CanvasTexture(hc);
    this.heatTex.colorSpace = THREE.SRGBColorSpace;

    this.floorFx = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uHeat: { value: this.heatTex }, uHeatGain: { value: 0.55 },
        uWaves: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, -1, 1)) },
        uWaveCol: { value: Array.from({ length: 6 }, () => new THREE.Color()) },
      },
      vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const fx = new THREE.Mesh(new THREE.PlaneGeometry(W, D), this.floorFx);
    fx.rotation.x = -Math.PI / 2;
    fx.position.y = 0.004;
    fx.renderOrder = 1;
    s.add(fx);

    // Cold-aisle floor strip: perforated tiles glowing faintly blue.
    const tiles = new THREE.Mesh(new THREE.PlaneGeometry(this.halfLen * 2, 1.2), new THREE.MeshBasicMaterial({ color: 0x0b2a3a, transparent: true, opacity: 0.55, depthWrite: false }));
    tiles.rotation.x = -Math.PI / 2;
    tiles.position.y = 0.003;
    s.add(tiles);
  }

  private buildRacks() {
    const s = this.scene;
    const nodes = this.topo.nodes;
    const gpn = this.topo.hall.gpus_per_node;

    const frameGeo = new THREE.BoxGeometry(RW * 0.97, RH, RD);
    // Perforated steel doors on the sides and back; plain tops.
    const dc = document.createElement('canvas');
    dc.width = 128; dc.height = 256;
    const g = dc.getContext('2d')!;
    g.fillStyle = '#161b1f'; g.fillRect(0, 0, 128, 256);
    g.fillStyle = '#2a333a';
    for (let y = 14; y < 242; y += 5) for (let x = 12 + ((y / 5) % 2) * 2.5; x < 116; x += 5) g.fillRect(x, y, 2, 2);
    g.strokeStyle = '#323c43'; g.lineWidth = 3; g.strokeRect(4, 4, 120, 248);
    g.fillStyle = '#2a343b'; g.fillRect(108, 112, 4, 32);
    const doorTex = new THREE.CanvasTexture(dc);
    doorTex.colorSpace = THREE.SRGBColorSpace;
    doorTex.anisotropy = 4;
    const door = new THREE.MeshStandardMaterial({ map: doorTex, metalness: 0.35, roughness: 0.55 });
    const top = new THREE.MeshStandardMaterial({ color: 0x111518, metalness: 0.5, roughness: 0.6 });
    const frameMat = [door, door, top, top, door, door];
    const exhaustGeo = new THREE.PlaneGeometry(RW * 0.86, RH * 0.88);
    for (const r of this.topo.racks) {
      const row = this.row[r.row];
      const x = this.rackX(r.index);
      const frame = this.mesh(frameGeo, frameMat, { receive: true });
      frame.position.set(x, RH / 2, row.z);
      frame.userData = { type: 'rack', id: r.id };
      s.add(frame);
      this.pickables.push(frame);
      const outline = this.edges(frameGeo, STATUS.neutral, frame.position);

      const exhaust = new THREE.Mesh(exhaustGeo, new THREE.MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      exhaust.position.set(x, RH / 2, row.back - row.dir * 0.012);
      s.add(exhaust);

      const tor = new THREE.Mesh(new THREE.BoxGeometry(RW * 0.84, 0.03, 0.02), new THREE.MeshBasicMaterial({ color: STATUS.ok }));
      tor.position.set(x, RH - 0.06, row.front + row.dir * 0.004);
      s.add(tor);
      this.rackMeshes.set(r.id, { exhaust, tor, outline, target: new THREE.Color(STATUS.neutral) });
    }

    const chassis = new THREE.InstancedMesh(
      new THREE.BoxGeometry(RW * 0.86, NODE_H, 0.03),
      new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.45 }),
      nodes.length,
    );
    const gpuBars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.046, 0.2, 0.012), new THREE.MeshBasicMaterial({ color: 0xffffff }), nodes.length * gpn);
    const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 0.035, 0.012), new THREE.MeshBasicMaterial({ color: 0xffffff }), nodes.length);
    nodes.forEach((nd, i) => {
      const p = this.nodePos(nd.id);
      const dir = this.row[this.rackById.get(nd.rack)!.row].dir;
      _m.makeTranslation(p.x, p.y, p.z + dir * 0.012);
      chassis.setMatrixAt(i, _m);
      chassis.setColorAt(i, _c.set(nd.role === 'inference' ? 0x222b33 : 0x1a2026));
      nd.gpus.forEach((gi, local) => {
        const off = (local - (gpn - 1) / 2) * 0.072 * dir;
        _m.makeTranslation(p.x + off + dir * 0.03, p.y - 0.02, p.z + dir * 0.032);
        gpuBars.setMatrixAt(gi, _m);
        gpuBars.setColorAt(gi, _c.set(0x050505));
      });
      _m.makeTranslation(p.x - dir * 0.34, p.y + 0.14, p.z + dir * 0.032);
      leds.setMatrixAt(i, _m);
      leds.setColorAt(i, _c.set(STATUS.ok));
    });
    s.add(chassis, gpuBars, leds);
    this.pickables.push(chassis);
    this.chassis = chassis; this.gpuBars = gpuBars; this.leds = leds;

    for (const w of this.topo.workers) {
      const nd = this.nodeById.get(w.node)!;
      const dir = this.row[this.rackById.get(nd.rack)!.row].dir;
      const p = this.nodePos(w.node);
      const tag = this.label(`<b>${w.id}</b><em></em>`, 'lbl wtag');
      tag.position.set(p.x, p.y + 0.02, p.z + dir * 0.55);
      tag.visible = false;
      s.add(tag);
      this.workerTags.set(w.id, tag);
    }
  }

  private buildCooling() {
    const s = this.scene;
    for (const c of this.topo.crahs) {
      const pos = this.crahPos.get(c.id)!;
      const inward = -Math.sign(pos.x);
      const body = this.mesh(new THREE.BoxGeometry(0.9, 2.3, 1.9), new THREE.MeshStandardMaterial({ color: 0x161b20, metalness: 0.6, roughness: 0.45 }), { receive: true });
      body.position.set(pos.x, 1.15, pos.z);
      body.userData = { type: 'crah', id: c.id };
      s.add(body);
      this.pickables.push(body);
      this.edges(body.geometry, 0x27313a, body.position);
      for (let k = 0; k < 14; k++) {
        const slat = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.035, 1.6), new THREE.MeshStandardMaterial({ color: 0x232c34 }));
        slat.position.set(pos.x + inward * 0.452, 0.35 + k * 0.11, pos.z);
        s.add(slat);
      }
      const status = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 1.6), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
      status.position.set(pos.x + inward * 0.456, 2.1, pos.z);
      s.add(status);
      const fans: THREE.Group[] = [];
      for (let k = -1; k <= 1; k++) {
        const fan = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.016, 8, 32), new THREE.MeshStandardMaterial({ color: 0x3a4650, metalness: 0.6, roughness: 0.4 }));
        ring.rotation.x = Math.PI / 2;
        fan.add(ring);
        for (let b = 0; b < 5; b++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.008, 0.05), new THREE.MeshStandardMaterial({ color: 0x55606a, metalness: 0.5 }));
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
      label.position.set(pos.x, 2.85, pos.z);
      s.add(label);
      this.crahs.set(c.id, { status, fans, label, on: true });
    }
  }

  private buildPower() {
    const s = this.scene;
    for (const [id, pos] of this.upsPos) {
      const body = this.mesh(new THREE.BoxGeometry(1.6, 2.0, 0.8), new THREE.MeshStandardMaterial({ color: 0x161b20, metalness: 0.6, roughness: 0.45 }), { receive: true });
      body.position.set(pos.x, 1.0, pos.z);
      body.userData = { type: 'ups', id };
      s.add(body);
      this.pickables.push(body);
      this.edges(body.geometry, 0x27313a, body.position);
      const bars: THREE.MeshBasicMaterial[] = [];
      for (let k = 0; k < 6; k++) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xf5a623 });
        for (const face of [-1, 1]) {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.01), mat);
          bar.position.set(pos.x, 0.45 + k * 0.2, pos.z + face * 0.405);
          s.add(bar);
        }
        bars.push(mat);
      }
      const label = this.label(`<b>${id}</b><span class="m"></span>`, 'lbl unit');
      label.position.set(pos.x, 2.4, pos.z);
      s.add(label);
      this.ups.set(id, { bars, label, on: true });
    }
    const busMat = new THREE.MeshStandardMaterial({ color: 0x3b3326, metalness: 0.7, roughness: 0.4 });
    for (const [rowId, row] of Object.entries(this.row)) {
      [...this.upsPos.keys()].forEach((u, k) => {
        const z = row.z + (k === 0 ? -0.22 : 0.22);
        this.busZ[`${rowId}:${u}`] = z;
        const bus = this.mesh(new THREE.BoxGeometry(this.halfLen * 2 + 0.2, 0.025, 0.04), busMat);
        bus.position.set(0, BUS_Y, z);
        s.add(bus);
      });
    }
    for (const [, pos] of this.upsPos) {
      const trunk = this.mesh(new THREE.BoxGeometry(0.04, 0.025, 6.2), busMat);
      trunk.position.set(pos.x, BUS_Y, (pos.z - 1.5) / 2 + 0.05);
      s.add(trunk);
    }
  }

  private buildNetwork() {
    const s = this.scene;
    const gp = this.gatewayPos;
    const body = this.mesh(new THREE.BoxGeometry(0.9, 2.6, 0.9), new THREE.MeshStandardMaterial({ color: 0x14181c, metalness: 0.75, roughness: 0.36 }), { receive: true });
    body.position.set(gp.x, 1.3, gp.z);
    body.userData = { type: 'gateway', id: 'gateway' };
    s.add(body);
    this.pickables.push(body);
    this.edges(body.geometry, 0x2a343c, body.position);
    const portMat = new THREE.MeshBasicMaterial({ color: 0x76b900 });
    for (let k = 0; k < 10; k++) {
      const port = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.02, 0.01), portMat);
      port.position.set(gp.x, 0.4 + k * 0.2, gp.z + 0.456);
      s.add(port);
    }
    this.gatewayPorts = portMat;
    this.queueCol = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1, 24), new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 1.2 }));
    this.queueCol.position.set(gp.x + 0.75, 0.01, gp.z);
    s.add(this.queueCol);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 2.4, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x3a4650, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    sleeve.position.set(gp.x + 0.75, 1.2, gp.z);
    s.add(sleeve);
    this.throttleRing = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.018, 8, 64), new THREE.MeshBasicMaterial({ color: 0xa78bfa }));
    this.throttleRing.rotation.x = Math.PI / 2;
    this.throttleRing.position.set(gp.x, 2.75, gp.z);
    this.throttleRing.visible = false;
    s.add(this.throttleRing);
    this.gatewayLabel = this.label('<b>Gateway</b><span class="m"></span>', 'lbl unit');
    this.gatewayLabel.position.set(gp.x, 3.1, gp.z);
    s.add(this.gatewayLabel);
    for (const [rowId, row] of Object.entries(this.row)) this.trayZ[rowId] = row.front + row.dir * 0.32;
  }

  private buildContainment() {
    const n = this.topo.hall.racks_per_row;
    for (const [rowId, row] of Object.entries(this.row)) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uT: { value: new Array(n).fill(30) }, uX0: { value: -this.halfLen }, uRW: { value: RW }, uN: { value: n }, uTime: { value: 0 } },
        vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `
          uniform float uT[${n}]; uniform float uX0; uniform float uRW; uniform int uN; uniform float uTime;
          varying vec3 vW;
          ${WARM_GLSL}
          void main(){
            float fi = clamp((vW.x - uX0) / uRW - 0.5, 0.0, float(uN - 1));
            int i0 = int(floor(fi)); int i1 = min(i0 + 1, uN - 1);
            float t = mix(uT[i0], uT[i1], fract(fi));
            float hot = smoothstep(34.0, 56.0, t);
            float yf = clamp(vW.y / 2.7, 0.0, 1.0);
            float shimmer = 0.85 + 0.15 * sin(uTime * 2.3 + vW.x * 3.1 + vW.y * 6.0);
            float a = (0.015 + 0.16 * hot) * (0.3 + 0.7 * yf) * shimmer;
            gl_FragColor = vec4(warm(t) * a, 1.0);
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      const box = new THREE.Mesh(new THREE.BoxGeometry(this.halfLen * 2, 2.7, 1.2), mat);
      box.position.set(0, 1.35, row.hot);
      box.renderOrder = 2;
      this.scene.add(box);
      this.edges(box.geometry, 0x1e272e, box.position, 0.8);
      this.containment[rowId] = mat;
      const light = new THREE.PointLight(0xf97316, 0, 6, 2);
      light.position.set(0, 2.2, row.hot);
      this.scene.add(light);
      this.aisleLights[rowId] = light;
    }
  }

  private buildFlows() {
    const px = this.pointScale();
    this.packets = new Travelers(1800, px);
    this.scene.add(this.packets.p.points);
    const gp = this.gatewayPos;
    this.ingressRoute = this.packets.addRoute([[0, 4.6, -11], [0, 3.4, -7.5], [gp.x, 2.62, gp.z]]);
    for (const w of this.topo.workers) {
      const nd = this.nodeById.get(w.node)!;
      const rack = this.rackById.get(nd.rack)!;
      const row = this.row[rack.row];
      const x = this.rackX(rack.index), y = nodeY(nd.slot), tz = this.trayZ[rack.row];
      const pts: V3[] = [[gp.x, 2.62, gp.z], [gp.x, TRAY_Y + 0.05, gp.z], [gp.x, TRAY_Y + 0.05, tz], [x, TRAY_Y + 0.05, tz], [x, y, tz], [x, y, row.front + row.dir * 0.04]];
      this.workerRoute.set(w.id, this.packets.addRoute(pts));
      // The fibre a request takes: lit by the state of the replica at its end.
      const mat = new THREE.LineBasicMaterial({ color: STATUS.ok, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p))), mat);
      this.scene.add(line);
      this.workerLine.set(w.id, { mat, target: new THREE.Color(STATUS.ok), opacity: 0.18 });
    }

    this.power = new Travelers(700, px);
    this.scene.add(this.power.p.points);
    for (const r of this.topo.racks) {
      for (const [u, pos] of this.upsPos) {
        const z = this.busZ[`${r.row}:${u}`], x = this.rackX(r.index);
        this.powerRoute.set(`${r.id}:${u}`, this.power.addRoute([[pos.x, 2.0, pos.z], [pos.x, BUS_Y, pos.z], [pos.x, BUS_Y, z], [x, BUS_Y, z], [x, RH + 0.03, z]]));
      }
    }

    // Air: CRAH → under-floor → tile → rack front → rack back → hot aisle → ceiling → CRAH.
    const N = 1500;
    this.air = new Particles(N, px);
    this.scene.add(this.air.points);
    const crahFor = (rowId: string) => this.topo.crahs.find((c) => c.row === rowId)?.id ?? this.topo.crahs[0].id;
    for (let i = 0; i < N; i++) {
      const r = this.topo.racks[i % this.topo.racks.length];
      const row = this.row[r.row];
      const cp = this.crahPos.get(crahFor(r.row))!;
      const x = this.rackX(r.index) + (Math.random() - 0.5) * RW * 0.85;
      const h = 0.2 + Math.random() * 1.9;
      const zc = row.front + row.dir * (0.1 + Math.random() * 0.45);
      const route = polyline([
        [cp.x - Math.sign(cp.x) * 0.5, -0.3, cp.z + (Math.random() - 0.5) * 1.4],
        [x, -0.3, zc], [x, 0.04, zc], [x, h, row.front + row.dir * 0.05], [x, h, row.back],
        [x + (Math.random() - 0.5) * 0.3, Math.min(2.6, h + 0.5), row.hot + (Math.random() - 0.5) * 0.8],
        [x, CEIL_Y - 0.1, row.hot], [cp.x, CEIL_Y - 0.05, row.hot + (Math.random() - 0.5) * 0.6], [cp.x, 2.45, cp.z],
      ]) as AirRoute;
      route.rack = r.id; route.row = r.row; route.d = Math.random() * route.len; route.speed = 0.75 + Math.random() * 0.5;
      this.airRoutes.push(route);
    }
    this.rackColor = new Map(this.topo.racks.map((r) => [r.id, { inlet: new THREE.Color(0x2563eb), exhaust: new THREE.Color(0xf97316) }]));
    this.returnColor = { A: new THREE.Color(), B: new THREE.Color() };
  }

  private pointScale() {
    const h = (this.container.clientHeight || 1) * Math.min(window.devicePixelRatio, 2);
    return h / 2 / Math.tan(THREE.MathUtils.degToRad(36 / 2));
  }

  // ----------------------------------------------------------------- pointer

  private pick(clientX: number, clientY: number): Entity | null {
    const el = this.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.pickables, false)[0];
    if (!hit) return null;
    if (hit.object === this.chassis && hit.instanceId != null) {
      const nd = this.topo.nodes[hit.instanceId];
      return nd.worker ? { type: 'worker', id: nd.worker } : { type: 'node', id: nd.id };
    }
    return hit.object.userData as Entity;
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    let down: [number, number] | null = null;
    let last = 0;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointermove', (e) => {
      const now = performance.now();
      if (now - last < 50 || e.buttons) return;
      last = now;
      const entity = this.pick(e.clientX, e.clientY);
      this.showHover(entity);
      const rect = this.container.getBoundingClientRect();
      el.style.cursor = entity ? 'pointer' : 'grab';
      this.listeners.hover.forEach((cb) => cb({ entity, x: e.clientX - rect.left, y: e.clientY - rect.top }));
    });
    el.addEventListener('pointerleave', () => { this.showHover(null); this.listeners.hover.forEach((cb) => cb({ entity: null, x: 0, y: 0 })); });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const entity = this.pick(e.clientX, e.clientY);
      if (entity) this.focus(entity);
      this.listeners.select.forEach((cb) => cb(entity));
    });
  }

  private showHover(e: Entity | null) {
    this.hoverBox.visible = !!e;
    if (!e) return;
    const p = this.entityPos(e);
    const b = this.hoverBox;
    if (e.type === 'worker' || e.type === 'node') {
      const id = e.type === 'worker' ? this.workerNode.get(e.id)! : e.id;
      const dir = this.row[this.rackById.get(this.nodeById.get(id)!.rack)!.row].dir;
      b.position.set(p.x, p.y, p.z - dir * RD * 0.47);
      b.scale.set(RW * 0.95, NODE_H + 0.05, RD * 0.98);
    } else if (e.type === 'rack') { b.position.copy(p).setY(RH / 2); b.scale.set(RW + 0.04, RH + 0.04, RD + 0.04); }
    else if (e.type === 'crah') { b.position.copy(p).setY(1.15); b.scale.set(0.98, 2.38, 1.98); }
    else if (e.type === 'ups') { b.position.copy(p).setY(1.0); b.scale.set(1.68, 2.08, 0.88); }
    else { b.position.copy(p).setY(1.3); b.scale.set(0.98, 2.68, 0.98); }
  }

  on(event: 'hover', cb: (e: HoverEvent) => void): void;
  on(event: 'select', cb: (e: Entity | null) => void): void;
  on(event: 'hover' | 'select', cb: any) { (this.listeners[event] as any[]).push(cb); }

  // ------------------------------------------------------------------ camera

  flyTo(pos: V3, target: V3, dur = 2.2) {
    this.idleOrbit = false;
    this.tween = { t: 0, dur, p0: this.camera.position.clone(), p1: new THREE.Vector3(...pos), t0: this.controls.target.clone(), t1: new THREE.Vector3(...target) };
  }

  preset(name: keyof typeof PRESETS) {
    const p = PRESETS[name];
    if (p) this.flyTo(p.pos, p.target);
  }

  focus(e: Entity) {
    const p = this.entityPos(e);
    if (e.type === 'worker' || e.type === 'node' || e.type === 'rack') {
      const rackId = e.type === 'rack' ? e.id : this.nodeById.get(e.type === 'worker' ? this.workerNode.get(e.id)! : e.id)!.rack;
      const row = this.row[this.rackById.get(rackId)!.row];
      // The cold aisle is only 1.2 m wide: look down into it from above the opposite row.
      const along = p.x > 0 ? -1 : 1;
      return this.flyTo([p.x + along * 3.2, Math.max(4.6, p.y + 3.4), row.front + row.dir * 3.0], [p.x, p.y, row.front]);
    }
    if (e.type === 'crah') return this.flyTo([p.x + Math.sign(p.x) * 2.8, 4.2, p.z - Math.sign(p.z) * 5.2], [p.x * 0.6, 1.0, p.z * 0.5]);
    if (e.type === 'ups') return this.flyTo([p.x * 0.6, 2.8, p.z + 4.6], [p.x, 1.0, p.z]);
    return this.flyTo([3.2, 3.4, -9.0], [0, 1.4, -4.7]);
  }

  /** Frame the blast radius of a fault. */
  focusFault(f: { kind: string; target?: string | null; targets?: string[] }) {
    const t = f.targets?.[0] ?? f.target ?? '';
    if (f.kind === 'tool_parser') return this.flyTo([7.6, 4.2, -7.8], [0, 1.0, -0.4]);
    if (f.kind === 'traffic_burst') return this.preset('network');
    if (f.kind === 'power_feed_loss') return this.preset('power');
    if (f.kind === 'compound') return this.focus({ type: 'crah', id: this.topo.crahs[0].id });
    if (this.crahPos.has(t)) return this.focus({ type: 'crah', id: t });
    if (this.workerNode.has(t)) return this.focus({ type: 'worker', id: t });
    if (this.nodeById.has(t)) return this.focus({ type: 'node', id: t });
    if (this.rackById.has(t)) return this.focus({ type: 'rack', id: t });
    this.preset('overview');
  }

  /** Shift the picture left by a fraction of the width, to keep incidents clear of side panels. */
  setFocusInset(fraction: number) { this.viewShiftTarget = fraction; }

  home() {
    this.preset('overview');
    this.lastInteraction = this.time;
  }

  // ----------------------------------------------------------------- effects

  /** An expanding ring on the floor. kind 'fault' is short and red; 'recovery' sweeps the hall. */
  wave(pos: THREE.Vector3, color: number, life: number) {
    const i = this.waveSlot++ % 6;
    (this.floorFx.uniforms.uWaves.value as THREE.Vector4[])[i].set(pos.x, pos.z, this.time, life);
    (this.floorFx.uniforms.uWaveCol.value as THREE.Color[])[i].set(color);
  }

  recoveryWave() {
    this.wave(new THREE.Vector3(0, 0, 0), STATUS.ok, 4.2);
    this.wave(new THREE.Vector3(0, 0, 0), 0x38bdf8, 3.4);
    this.flashUntil = this.time + 1.8;
  }

  // ------------------------------------------------------------------ update

  update(frame: Frame) {
    this.frame = frame;
    const P = this.packets;
    const cap = (n: number, m: number) => Math.min(n, m);
    for (let k = 0; k < cap(frame.gateway.in, 14); k++) P.spawn(this.ingressRoute, FLOW.ingress, { dur: 0.9, delay: Math.random() * 0.1, size: 0.035, gain: 0.45 });
    for (let k = 0; k < cap(frame.gateway.shed, 10); k++) P.spawn(this.ingressRoute, FLOW.shed, { reverse: true, dur: 0.9, delay: Math.random() * 0.1, size: 0.085, gain: 1.4 });
    for (const [wid, f] of Object.entries(frame.flows)) {
      const r = this.workerRoute.get(wid);
      if (r == null) continue;
      for (let k = 0; k < cap(f.disp, 8); k++) P.spawn(r, FLOW.request, { dur: 1.1, delay: Math.random() * 0.1, size: 0.06, gain: 0.9 });
      for (let k = 0; k < cap(f.ok, 8); k++) P.spawn(r, FLOW.ok, { reverse: true, dur: 1.1, delay: Math.random() * 0.1, size: 0.06, gain: 0.9 });
      for (let k = 0; k < cap(f.silent, 8); k++) P.spawn(r, FLOW.silent, { reverse: true, dur: 1.1, delay: Math.random() * 0.1, size: 0.095, gain: 1.6 });
      for (let k = 0; k < cap(f.err, 8); k++) P.spawn(r, FLOW.err, { reverse: true, dur: 0.8, delay: Math.random() * 0.1, size: 0.1, gain: 1.8 });
    }

    for (const r of frame.racks) {
      const meshes = this.rackMeshes.get(r.id);
      const cols = this.rackColor.get(r.id);
      if (!meshes || !cols) continue;
      airColor(r.inlet, cols.inlet);
      exhaustColor(r.exhaust, cols.exhaust);
      meshes.exhaust.material.color.copy(cols.exhaust);
      meshes.exhaust.material.opacity = 0.04 + 0.3 * THREE.MathUtils.smoothstep(r.exhaust, 32, 58);
      meshes.tor.material.color.set(r.net ? STATUS.bad : r.capped ? STATUS.warn : STATUS.ok).multiplyScalar(r.net ? 2.2 : 1.1);
    }
    this.rackTargets(frame);
    for (const [rowId, mat] of Object.entries(this.containment)) {
      const temps = frame.racks.filter((r) => r.id.startsWith(rowId)).map((r) => r.exhaust);
      mat.uniforms.uT.value = temps;
      const mean = temps.reduce((a, b) => a + b, 0) / temps.length;
      exhaustColor(mean, this.returnColor[rowId]);
      const light = this.aisleLights[rowId];
      light.color.copy(this.returnColor[rowId]);
      light.intensity = 6 * THREE.MathUtils.smoothstep(mean, 34, 58);
    }

    const byCrah = new Map(frame.hall.crahs.map((c) => [c.id, c]));
    for (const [id, u] of this.crahs) {
      u.on = !!byCrah.get(id)?.running;
      u.status.material.color.set(u.on ? 0x38bdf8 : STATUS.bad).multiplyScalar(u.on ? 1.3 : 2.4);
      u.label.element.classList.toggle('bad', !u.on);
      u.label.element.querySelector('.m')!.textContent = u.on ? `${frame.hall.supply_c.toFixed(1)} °C supply` : 'tripped';
    }
    const liveFeeds = Object.values(frame.hall.ups).filter(Boolean).length || 1;
    for (const [id, u] of this.ups) {
      u.on = !!frame.hall.ups[id];
      u.label.element.classList.toggle('bad', !u.on);
      u.label.element.querySelector('.m')!.textContent = u.on ? `${(frame.hall.it_kw / liveFeeds).toFixed(0)} kW` : 'feed lost';
      const load = u.on ? frame.hall.it_kw / liveFeeds / 400 : 0;
      u.bars.forEach((b, k) => b.color.set(u.on ? (k / u.bars.length < load ? (load > 0.85 ? 0xf97316 : 0xf5a623) : 0x1c2228) : 0x2a1016));
    }
    const q = frame.kpi.queue + frame.gateway.queue;
    const hq = q > 0 ? Math.max(0.03, (Math.log10(q + 1) / Math.log10(5000)) * 2.4) : 0.001;
    this.queueCol.scale.y = hq;
    this.queueCol.position.y = hq / 2;
    this.queueCol.material.color.set(q > 500 ? STATUS.bad : STATUS.warn);
    this.queueCol.material.emissive.set(q > 500 ? STATUS.bad : STATUS.warn);
    this.throttleRing.visible = frame.gateway.throttle_rps != null;
    this.gatewayLabel.element.querySelector('.m')!.textContent =
      `${frame.kpi.rps_in.toFixed(0)} rps` + (q ? ` · queue ${q}` : '') + (frame.gateway.throttle_rps != null ? ` · limit ${frame.gateway.throttle_rps.toFixed(0)}` : '');

    const feeds = Object.entries(frame.hall.ups).filter(([, on]) => on).map(([u]) => u);
    for (const r of frame.racks) {
      for (const u of feeds) {
        const key = `${r.id}:${u}`;
        const acc = (this.powerAcc.get(key) ?? 0) + (r.power_kw / feeds.length) * 0.01;
        const n = Math.floor(acc);
        this.powerAcc.set(key, acc - n);
        for (let k = 0; k < n; k++) this.power.spawn(this.powerRoute.get(key)!, r.capped ? FLOW.powerCapped : FLOW.power, { dur: 1.6, delay: Math.random() * 0.1, size: 0.04, gain: 0.55 });
      }
    }

    this.drawHeat(frame);
    this.updateWorkers(frame);
    this.syncMarkers(frame);
  }

  /** Rack outline color = the worst condition among its nodes. */
  private rackTargets(frame: Frame) {
    const workers = new Map(frame.workers.map((w) => [w.id, w]));
    const worst = new Map<string, [number, number]>();
    const bump = (rack: string, prio: number, color: number) => {
      const cur = worst.get(rack);
      if (!cur || prio > cur[0]) worst.set(rack, [prio, color]);
    };
    for (const nd of this.topo.nodes) {
      const flags = nd.gpus.map((g) => frame.gpu.flag[g]);
      const [cordoned] = frame.nodes[nd.id] ?? [0, 0];
      if (flags.includes(3)) bump(nd.rack, 7, STATUS.xid);
      if (nd.worker) {
        const w = workers.get(nd.worker);
        if (w?.state === 'crashed') bump(nd.rack, 6, STATUS.bad);
        else if (w && (w.state === 'hung' || !w.canary)) bump(nd.rack, 4, STATUS.warn);
        else if (w && (w.state === 'restarting' || w.draining)) bump(nd.rack, 3, STATUS.restart);
      }
      if (flags.includes(1)) bump(nd.rack, 5, STATUS.thermal);
      if (cordoned) bump(nd.rack, 2, STATUS.off);
    }
    for (const r of frame.racks) {
      if (r.net) bump(r.id, 5, STATUS.bad);
      if (r.capped) bump(r.id, 4, STATUS.warn);
    }
    for (const [id, m] of this.rackMeshes) {
      const w = worst.get(id);
      m.target.set(w ? w[1] : STATUS.neutral);
      if (w) m.target.multiplyScalar(w[0] >= 5 ? 1.8 : 1.3);
    }
  }

  private drawHeat(frame: Frame) {
    const ctx = this.heatCtx, cw = this.heatCanvas.width, ch = this.heatCanvas.height;
    const W = this.hallW, D = this.hallD;
    const u = (x: number) => ((x + W / 2) / W) * cw, v = (z: number) => ((z + D / 2) / D) * ch;
    ctx.clearRect(0, 0, cw, ch);
    frame.racks.forEach((r, i) => {
      const meta = this.topo.racks[i];
      const row = this.row[meta.row];
      const x = this.rackX(meta.index);
      const c = exhaustColor(r.exhaust, _c2);
      const col = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
      const a = 0.5 * THREE.MathUtils.smoothstep(r.exhaust, 30, 52) + 0.05;
      const rad = (1.0 / W) * cw;
      const g = ctx.createRadialGradient(u(x), v(row.hot), 0, u(x), v(row.hot), rad);
      g.addColorStop(0, `rgba(${col},${a})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(u(x) - rad, v(row.hot) - rad, 2 * rad, 2 * rad);
    });
    this.heatTex.needsUpdate = true;
  }

  private workerState(w: WorkerFrame): { cls: string; text: string; color: number; opacity: number } | null {
    if (w.state === 'crashed') return { cls: 'bad', text: 'crashed', color: STATUS.bad, opacity: 0.7 };
    if (w.state === 'hung') return { cls: 'warn', text: 'health ✓ · 0 tok/s', color: STATUS.warn, opacity: 0.6 };
    if (w.draining) return { cls: 'restart', text: `draining · ${w.running + w.waiting} in flight`, color: STATUS.restart, opacity: 0.45 };
    if (w.state === 'restarting') return { cls: 'restart', text: `restarting · ${Math.ceil(w.ready_in ?? 0)}s`, color: STATUS.restart, opacity: 0.45 };
    if (w.state === 'cordoned') return { cls: 'off', text: 'cordoned', color: STATUS.off, opacity: 0.12 };
    if (!w.canary) return { cls: 'warn', text: w.tool_ok ? 'canary ✗' : '200 OK · tool_calls: []', color: STATUS.warn, opacity: 0.6 };
    if (w.weight === 0) return { cls: 'off', text: 'drained', color: STATUS.off, opacity: 0.12 };
    return null;
  }

  private updateWorkers(frame: Frame) {
    for (const w of frame.workers) {
      const st = this.workerState(w);
      const tag = this.workerTags.get(w.id);
      if (tag) {
        tag.visible = !!st;
        if (st) {
          tag.element.className = `lbl wtag ${st.cls}`;
          tag.element.querySelector('em')!.textContent = st.text;
        }
      }
      const line = this.workerLine.get(w.id);
      if (line) {
        line.target.set(st ? st.color : STATUS.ok);
        line.opacity = st ? st.opacity : 0.16;
      }
    }
  }

  private syncMarkers(frame: Frame) {
    const active = new Set<string>();
    for (const f of frame.faults) {
      if (f.resolved_at != null) continue;
      active.add(f.id);
      if (this.markers.has(f.id)) continue;
      const pos = this.faultPos(f);
      const group = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.47, 64), new THREE.MeshBasicMaterial({ color: STATUS.bad, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, 0.02, pos.z);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 3.4, 8), new THREE.MeshBasicMaterial({ color: STATUS.bad, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending }));
      beam.position.set(pos.x, 1.9, pos.z);
      beam.visible = f.kind !== 'tool_parser';
      const callout = this.label(`<b>${f.title}</b>${f.candidate_id ? `<span>${f.candidate_id}</span>` : ''}`, 'lbl callout');
      callout.position.set(pos.x, 3.75, pos.z);
      group.add(ring, beam, callout);
      this.scene.add(group);
      this.markers.set(f.id, { group, ring, beam, callout });
      // A fault that just happened gets a shockwave and the camera; one that is already
      // old (a replay scrubbed into the middle of an incident) only gets its marker.
      if (frame.t - f.t < 3) {
        this.wave(pos, STATUS.bad, 2.6);
        this.incident = true;
        this.focusFault(f);
      }
    }
    for (const [id, m] of this.markers) {
      if (active.has(id)) continue;
      m.group.remove(m.callout);
      m.callout.element.remove();
      this.scene.remove(m.group);
      this.markers.delete(id);
    }
  }

  private faultPos(f: FaultRecord): THREE.Vector3 {
    const t = f.targets?.[0] ?? f.target ?? '';
    if (f.kind === 'tool_parser' && f.targets?.length) {
      const ps = f.targets.filter((w) => this.workerNode.has(w)).map((w) => this.nodePos(this.workerNode.get(w)!));
      return ps.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, ps.length)).setZ(0);
    }
    if (this.workerNode.has(t)) return this.nodePos(this.workerNode.get(t)!);
    if (this.nodeById.has(t)) return this.nodePos(t);
    if (this.rackById.has(t)) return this.entityPos({ type: 'rack', id: t });
    if (this.crahPos.has(t)) return this.crahPos.get(t)!.clone();
    if (this.upsPos.has(t)) return this.upsPos.get(t)!.clone();
    if (f.kind === 'compound') return this.crahPos.get(this.topo.crahs[0].id)!.clone();
    return this.gatewayPos.clone();
  }

  /** Drop transient particles, e.g. when switching between live and replay. */
  clearFlows() { this.packets.clear(); this.power.clear(); }

  // -------------------------------------------------------------------- tick

  private tick() {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.1);
    this.lastTick = now;
    this.time += dt;
    if (!this.container.clientWidth) return;
    const f = this.frame;

    if (this.tween) {
      const tw = this.tween;
      tw.t += dt / tw.dur;
      const e = tw.t >= 1 ? 1 : tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.t0, tw.t1, e);
      if (tw.t >= 1) { this.tween = null; this.lastInteraction = this.time; }
    } else {
      // Ambient: a slow orbit while the hall is calm and nobody is driving the camera.
      if (!this.idleOrbit && !this.incident && this.time - this.lastInteraction > 28) {
        this.idleOrbit = true;
        this.orbitAngle = Math.atan2(this.camera.position.z - this.controls.target.z, this.camera.position.x - this.controls.target.x);
      }
      if (this.idleOrbit && !this.incident) {
        this.orbitAngle += dt * 0.045;
        const r = 14.2;
        _v.set(Math.cos(this.orbitAngle) * r, 6.4 + Math.sin(this.time * 0.17) * 0.6, Math.sin(this.orbitAngle) * r);
        this.camera.position.lerp(_v, 0.02);
        this.controls.target.lerp(ORBIT_TARGET, 0.02);
      }
    }
    this.controls.update();
    this.floorFx.uniforms.uTime.value = this.time;
    if (Math.abs(this.viewShiftTarget - this.viewShift) > 0.0005) {
      this.viewShift += (this.viewShiftTarget - this.viewShift) * (1 - Math.exp(-dt * 3));
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.camera.setViewOffset(w, h, this.viewShift * w, 0, w, h);
    }

    // Rack outlines and fibres ease toward their state colors.
    const flash = this.time < this.flashUntil ? Math.sin(((this.flashUntil - this.time) / 1.8) * Math.PI) : 0;
    const k = 1 - Math.exp(-dt * 5);
    for (const [, m] of this.rackMeshes) {
      _c.copy(m.target);
      if (flash > 0) _c.lerp(_c2.set(STATUS.ok).multiplyScalar(2), flash);
      m.outline.color.lerp(_c, k);
    }
    for (const [, l] of this.workerLine) {
      l.mat.color.lerp(l.target, k);
      l.mat.opacity += (l.opacity - l.mat.opacity) * k;
    }

    if (f) {
      this.updateGpus(f);
      this.updateAir(dt, f);
      for (const [, u] of this.crahs) if (u.on) u.fans.forEach((fan) => (fan.rotation.y += dt * 9));
      for (const [, u] of this.ups) if (!u.on) u.bars.forEach((b) => b.color.set(Math.sin(this.time * 6) > 0 ? STATUS.bad : 0x2a1016).multiplyScalar(Math.sin(this.time * 6) > 0 ? 1.8 : 1));
      for (const [, m] of this.markers) {
        const q = (this.time * 0.7) % 1;
        m.ring.scale.setScalar(1 + q * 1.8);
        m.ring.material.color.set(STATUS.bad).multiplyScalar(2.2 * (1 - q));
      }
      this.throttleRing.rotation.z += dt * 1.5;
      this.gatewayPorts.color.setHSL(0.24, 1, 0.32 + 0.06 * Math.sin(this.time * 9));
      for (const m of Object.values(this.containment)) m.uniforms.uTime.value = this.time;
    }
    this.packets.update(dt);
    this.power.update(dt);
    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }

  private updateGpus(f: Frame) {
    const { temp, util, flag } = f.gpu;
    const blink = Math.sin(this.time * 10) > 0;
    for (let i = 0; i < temp.length; i++) {
      if (flag[i] === 3) { this.gpuBars.setColorAt(i, _c.set(blink ? STATUS.xid : 0x1a0620).multiplyScalar(blink ? 2.4 : 1)); continue; }
      heatColor(temp[i], _c);
      let b = 0.18 + 0.95 * util[i];
      if (flag[i] === 1) b *= 0.7 + 0.5 * Math.sin(this.time * 14 + i);
      this.gpuBars.setColorAt(i, _c.multiplyScalar(b * (temp[i] > 80 ? 1.8 : 1.15)));
    }
    if (this.gpuBars.instanceColor) this.gpuBars.instanceColor.needsUpdate = true;

    const workers = new Map(f.workers.map((w) => [w.id, w]));
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
    this.topo.nodes.forEach((nd, i) => {
      const [cordoned, paused] = f.nodes[nd.id] ?? [0, 0];
      let col: number | null = STATUS.batch;
      let gain = 1;
      const xid = nd.gpus.some((g) => flag[g] === 3);
      if (xid) { col = blink ? STATUS.xid : 0x1a0620; gain = 2.2; }
      else if (cordoned) col = STATUS.off;
      else if (nd.worker) {
        const w = workers.get(nd.worker);
        if (w?.state === 'crashed') { col = blink ? STATUS.bad : 0x2a0810; gain = 2.4; }
        else if (w?.state === 'restarting' || w?.draining) col = null;
        else if (w?.state === 'hung') col = STATUS.ok; // the health check still says OK
        else { col = w?.canary ? STATUS.ok : STATUS.warn; gain = w?.canary ? 1.4 : 2.2; }
      } else if (paused) col = STATUS.off;
      if (col === null) _c.set(STATUS.restart).multiplyScalar(0.5 + pulse * 1.5);
      else _c.set(col).multiplyScalar(gain);
      this.leds.setColorAt(i, _c);
    });
    if (this.leds.instanceColor) this.leds.instanceColor.needsUpdate = true;
  }

  private updateAir(dt: number, f: Frame) {
    const air = this.air;
    const sup = airColor(f.hall.supply_c, new THREE.Color());
    for (let i = 0; i < this.airRoutes.length; i++) {
      const r = this.airRoutes[i];
      const flow = f.hall.airflow[r.row] ?? 1;
      r.d = (r.d + dt * 1.25 * r.speed * flow) % r.len;
      const seg = sample(r, r.d, _v);
      const cols = this.rackColor.get(r.rack)!;
      let a: number, size = 0.04;
      if (seg <= 1) a = 0;
      else if (seg <= 3) { _c.copy(sup).lerp(cols.inlet, seg === 3 ? _segF : 0); a = 0.22; }
      else if (seg === 4) { _c.copy(cols.inlet).lerp(cols.exhaust, _segF); a = 0.18; }
      else if (seg <= 6) { _c.copy(cols.exhaust); a = 0.34; size = 0.05; }
      else { _c.copy(cols.exhaust).lerp(this.returnColor[r.row], _segF); a = 0.16; }
      air.set(i, _v, _c, size, a * (0.4 + 0.6 * flow));
    }
    air.flush();
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    if (this.viewShift) this.camera.setViewOffset(w, h, this.viewShift * w, 0, w, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    const px = this.pointScale();
    for (const sys of [this.air, this.packets.p, this.power.p]) sys.mat.uniforms.uPx.value = px;
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}
