// The recovery architecture in 3D: small glass modules standing on a dark
// holographic board, joined by traces that grow as the run reaches each module.
// Tool calls and repairs that touch the system arc over the board between the
// module that made them and the component they read or changed.
//
// Like the twin, this is an imperative Three.js scene. It renders an ArchModel
// (lib/arch.ts) and animates the differences between successive models: new
// connectors grow first, then the module they lead to materializes. Nothing is
// revealed on a timer of its own; it only animates what the model already says.
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { ArchEdge, ArchId, ArchModel, ArchNode, ArchState, EdgeState, ReplicaTone } from '../lib/arch';

type Kind = 'cube' | 'slab' | 'leaf';
type Side = 'right' | 'left' | 'below' | 'above';
interface Slot { x: number; z: number; s: number; kind: Kind; side: Side }

// Two columns joined by a centre lane. Left, the system under repair: demand →
// gateway → serving units on their substrate → telemetry. Right, NEXUS: one
// controller → two tool collections → shadow twin → policy → act → verify. The
// outcomes and the certificate close the story at the bottom; repairs arc back
// across the lane into the system.
const LAYOUT: Record<ArchId, Slot> = {
  users: { x: -2.5, z: -4.14, s: 0.45, kind: 'cube', side: 'above' },
  agents: { x: -1.0, z: -4.14, s: 0.45, kind: 'cube', side: 'above' },
  gateway: { x: -1.75, z: -2.8, s: 0.59, kind: 'cube', side: 'right' },
  serving: { x: -1.75, z: -1.43, s: 0.71, kind: 'cube', side: 'right' },
  gpu: { x: -2.85, z: -0.07, s: 0.38, kind: 'slab', side: 'above' },
  network: { x: -2.15, z: -0.07, s: 0.38, kind: 'slab', side: 'above' },
  cooling: { x: -1.35, z: -0.07, s: 0.38, kind: 'slab', side: 'above' },
  power: { x: -0.65, z: -0.07, s: 0.38, kind: 'slab', side: 'above' },
  telemetry: { x: -1.75, z: 1.3, s: 0.59, kind: 'cube', side: 'right' },
  controller: { x: 1.75, z: -4.14, s: 0.71, kind: 'cube', side: 'above' },
  tooldoc: { x: 0.95, z: -2.8, s: 0.57, kind: 'cube', side: 'above' },
  infradoc: { x: 2.65, z: -2.8, s: 0.57, kind: 'cube', side: 'right' },
  shadow: { x: 1.75, z: -1.43, s: 0.54, kind: 'cube', side: 'right' },
  policy: { x: 1.75, z: -0.07, s: 0.54, kind: 'cube', side: 'right' },
  act: { x: 1.75, z: 1.3, s: 0.59, kind: 'cube', side: 'right' },
  verify: { x: 1.75, z: 2.64, s: 0.59, kind: 'cube', side: 'right' },
  'o-verified': { x: -1.5, z: 3.72, s: 0.31, kind: 'leaf', side: 'below' },
  'o-rolled': { x: -0.4, z: 3.72, s: 0.31, kind: 'leaf', side: 'below' },
  'o-approval': { x: 0.7, z: 3.72, s: 0.31, kind: 'leaf', side: 'below' },
  'o-abstain': { x: 1.8, z: 3.72, s: 0.31, kind: 'leaf', side: 'below' },
  certificate: { x: 0.1, z: 5.3, s: 0.66, kind: 'cube', side: 'below' },
};
const BOUNDS = { minX: -3.15, maxX: 4.25, minZ: -4.95, maxZ: 5.75 };
const LANE_X = 0.05, SIDE_X = 3.15;
const height = (s: Slot) => (s.kind === 'slab' ? s.s * 0.34 : s.kind === 'leaf' ? s.s * 0.62 : s.s * 0.84);

const STATE_HEX: Record<ArchState, number> = {
  active: 0x9eeaff, done: 0x76b900, failed: 0xf43f5e, waiting: 0xf5a524, fault: 0xf43f5e, context: 0x86a2b8, ghost: 0x41525f,
};
const EDGE_HEX: Record<EdgeState, number> = { live: 0x9eeaff, done: 0x76b900, context: 0x5f7a8e, fault: 0xf43f5e, ghost: 0x33424e };
const KIND_HEX = { query: 0x38bdf8, act: 0xc6f36b };
const REPLICA_HEX: Record<ReplicaTone, number> = { ok: 0x76b900, warn: 0xf5a524, bad: 0xf43f5e, info: 0x38bdf8, off: 0x3a4650 };
// How bright each state burns (feeds the bloom).
const GAIN: Record<ArchState, number> = { active: 1.25, done: 0.8, failed: 1.25, waiting: 1.15, fault: 1.3, context: 0.62, ghost: 0.32 };

const ICON: Record<string, string> = {
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.1a3.5 3.5 0 0 1 0 6.8',
  agents: 'M12 4v3M7 7h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3zM9 12.5v1M15 12.5v1M9.5 16.5h5',
  gateway: 'M3 12h6M9 12l4-5h8M9 12l4 5h8M18 4l3 3-3 3M18 14l3 3-3 3',
  serving: 'M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01',
  gpu: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  network: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 8v3M12 11l-5 4M12 11l5 4',
  cooling: 'M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5',
  power: 'M13 2 4 14h7l-1 8 9-12h-7z',
  telemetry: 'M3 12h4l2.5-6 4 12 2.5-6H21',
  controller: 'M7 19h3v-2.2A6 6 0 1 1 14 16.8V19h3',
  tooldoc: 'M8 5 4 12l4 7M16 5l4 7-4 7M13.5 4l-3 16',
  infradoc: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  shadow: 'M4 8.5 10 5l6 3.5v7L10 19l-6-3.5zM14 7.2l6 3.3v7L14 21',
  policy: 'M12 3 5 6v5.5c0 4.2 3 7.7 7 9.5 4-1.8 7-5.3 7-9.5V6zM9 12h6',
  act: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  verify: 'M12 3 5 6v5.5c0 4.2 3 7.7 7 9.5 4-1.8 7-5.3 7-9.5V6zM9 12l2.2 2.2L15.5 10',
  'o-verified': 'M5 12.5l4.5 4.5L19 7.5',
  'o-rolled': 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  'o-approval': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 21a7 7 0 0 1 14 0',
  'o-abstain': 'M6 12h12',
  certificate: 'M12 3a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M9 15.5 7.5 21 12 18.5 16.5 21 15 15.5M9.8 9.6l1.5 1.5 3-3',
};

const iconCache = new Map<string, THREE.CanvasTexture>();
function iconTexture(id: string): THREE.CanvasTexture {
  const hit = iconCache.get(id);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.scale(128 / 24, 128 / 24);
  g.strokeStyle = '#fff';
  g.lineWidth = 1.55;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.shadowColor = 'rgba(255,255,255,0.9)';
  g.shadowBlur = 1.2;
  g.stroke(new Path2D(ICON[id] ?? ICON.controller));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  iconCache.set(id, t);
  return t;
}

let glowTex: THREE.CanvasTexture | null = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,0.85)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

// Connectors: a length coordinate along the path lets one shader grow them, pulse
// light along them and dash the ghosts.
const EDGE_VS = `attribute float along; varying float vAlong;
void main(){ vAlong = along; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const EDGE_FS = `
uniform float uGrow; uniform float uLen; uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uLive; uniform float uDash; uniform float uSpeed;
varying float vAlong;
void main(){
  if (vAlong > uGrow) discard;
  if (uDash > 0.5 && fract(vAlong * 7.0) > 0.55) discard;
  float growing = step(uGrow, uLen - 0.002);
  float head = exp(-pow((uGrow - vAlong) * 7.0, 2.0)) * growing;
  float period = uLen + 1.4;
  float pos = mod(uTime * uSpeed, period) - 0.35;
  float pulse = uLive * exp(-pow((vAlong - pos) * 6.0, 2.0));
  float pulse2 = uLive * exp(-pow((vAlong - mod(pos + period * 0.5, period)) * 6.0, 2.0)) * 0.6;
  vec3 col = uColor * (uOpacity + head * 2.2 + (pulse + pulse2) * 2.6);
  gl_FragColor = vec4(col, max(col.r, max(col.g, col.b)));
}`;

const FLOOR_FS = `
uniform float uTime; varying vec3 vW;
void main(){
  vec2 q = vW.xz / 0.5;
  vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  vec2 c = vec2((vW.x - 0.1) / 4.2, (vW.z - 0.5) / 5.4);
  float fade = 1.0 - smoothstep(0.55, 1.0, length(c));
  float scan = 0.55 + 0.45 * smoothstep(0.0, 1.0, 1.0 - abs(fract(vW.z * 0.08 - uTime * 0.05) - 0.5) * 2.0);
  vec3 col = vec3(0.30, 0.62, 0.86) * line * 0.10 * fade * scan;
  col += vec3(0.05, 0.11, 0.17) * fade * 0.35;
  gl_FragColor = vec4(col, max(col.r, max(col.g, col.b)) * 1.2);
}`;

interface NodeView {
  data: ArchNode;
  slot: Slot;
  group: THREE.Group;
  glass: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  core: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  lines: LineSegments2;
  lineMat: LineMaterial;
  icon: THREE.Sprite;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[];
  replicas: THREE.InstancedMesh | null;
  label: CSS2DObject;
  color: THREE.Color;
  target: THREE.Color;
  start: number;
  appear: number;
  removing: number;
  hover: number;
}

interface EdgeView {
  data: ArchEdge;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  len: number;
  start: number;
  dur: number;
  removing: number;
  color: THREE.Color;
  target: THREE.Color;
  opacity: number;
  targetOpacity: number;
}

export interface ArchScreenPos { x: number; y: number; visible: boolean }

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export class ArchScene {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.5, 120);
  private target = new THREE.Vector3();
  private dist = 18;
  private time = 0;
  private last = performance.now();
  private ro: ResizeObserver;
  private floor: THREE.ShaderMaterial;
  private nodes = new Map<ArchId, NodeView>();
  private edges = new Map<string, EdgeView>();
  private nextFree = 0;
  /** The run has closed: nothing is executing, so nothing pulses except a failure still in place. */
  private closed = false;
  private parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  private reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  private selectCbs: ((id: ArchId | null) => void)[] = [];
  private hoverId: ArchId | null = null;
  private running = false;
  private disposed = false;
  private boxGeo = new Map<string, THREE.BufferGeometry>();

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    r.setSize(w, h);
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    container.appendChild(r.domElement);
    this.renderer = r;

    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    this.labels.domElement.className = 'arch-labels';
    container.appendChild(this.labels.domElement);

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x0a1220, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(4, 10, 6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fd3ff, 0.9);
    rim.position.set(-6, 4, -8);
    this.scene.add(rim);

    this.floor = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: FLOOR_FS,
      transparent: true, depthWrite: false,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 12), this.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0.1, 0, 0.5);
    floor.renderOrder = -1;
    this.scene.add(floor);

    this.composer = new EffectComposer(r);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.42, 0.7);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.fit();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.bindPointer();
    this.setRunning(true);
  }

  // ------------------------------------------------------------------ camera

  /** Frames the whole board, whatever the panel's shape, so the composition never shifts as modules appear.
   *  Perspective makes the near half of the board larger, so the projected board is re-centred with a view offset. */
  private fit() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    const el = THREE.MathUtils.degToRad(41), yaw = THREE.MathUtils.degToRad(-7);
    this.dir.set(Math.sin(yaw) * Math.cos(el), Math.sin(el), Math.cos(yaw) * Math.cos(el));
    this.target.set((BOUNDS.minX + BOUNDS.maxX) / 2, 0, (BOUNDS.minZ + BOUNDS.maxZ) / 2);
    const corners: THREE.Vector3[] = [];
    for (const x of [BOUNDS.minX, BOUNDS.maxX]) for (const z of [BOUNDS.minZ, BOUNDS.maxZ]) for (const y of [0, 0.8]) corners.push(new THREE.Vector3(x, y, z));
    const box = (d: number) => {
      this.camera.position.copy(this.dir).multiplyScalar(d).add(this.target);
      this.camera.lookAt(this.target);
      this.camera.clearViewOffset();
      this.camera.updateMatrixWorld();
      this.camera.updateProjectionMatrix();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
      for (const c of corners) {
        const p = c.clone().project(this.camera);
        if (p.z > 1) behind = true;
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      return { x0, x1, y0, y1, behind };
    };
    let lo = 4, hi = 90;
    for (let i = 0; i < 26; i++) {
      const d = (lo + hi) / 2;
      const b = box(d);
      if (!b.behind && b.x1 - b.x0 < 1.9 && b.y1 - b.y0 < 1.92) hi = d; else lo = d;
    }
    this.dist = hi;
    const b = box(hi);
    this.center = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    this.place();
  }
  private dir = new THREE.Vector3(0, 1, 1).normalize();
  private center = { x: 0, y: 0 };

  private place() {
    const p = this.parallax;
    const d = this.dir.clone();
    d.applyAxisAngle(new THREE.Vector3(0, 1, 0), p.x * 0.03);
    this.camera.position.copy(d).multiplyScalar(this.dist).add(this.target);
    this.camera.position.y += p.y * 0.22;
    this.camera.lookAt(this.target);
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.camera.setViewOffset(w, h, (this.center.x * w) / 2, (-this.center.y * h) / 2, w, h);
    this.camera.updateProjectionMatrix();
  }

  // ----------------------------------------------------------------- pointer

  private onWindowPointer = (e: PointerEvent) => {
    this.parallax.tx = (e.clientX / window.innerWidth) * 2 - 1;
    this.parallax.ty = (e.clientY / window.innerHeight) * 2 - 1;
  };

  private pick(clientX: number, clientY: number): ArchId | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const glass = [...this.nodes.values()].filter((n) => !n.removing && n.appear > 0.5).map((n) => n.glass);
    const hit = ray.intersectObjects(glass, false)[0];
    return hit ? (hit.object.userData.id as ArchId) : null;
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    window.addEventListener('pointermove', this.onWindowPointer);
    let down: [number, number] | null = null;
    el.addEventListener('pointermove', (e) => {
      const id = this.pick(e.clientX, e.clientY);
      if (id !== this.hoverId) { this.hoverId = id; el.style.cursor = id ? 'pointer' : 'default'; }
    });
    el.addEventListener('pointerleave', () => { this.hoverId = null; });
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const id = this.pick(e.clientX, e.clientY);
      this.selectCbs.forEach((cb) => cb(id));
    });
  }

  onSelect(cb: (id: ArchId | null) => void) {
    this.selectCbs.push(cb);
    return () => { this.selectCbs = this.selectCbs.filter((c) => c !== cb); };
  }

  /** Where a module is on screen, in container pixels (top centre of the module). */
  screenPos(id: ArchId, where: 'top' | 'bottom' = 'top'): ArchScreenPos {
    const n = this.nodes.get(id);
    const slot = LAYOUT[id];
    if (!slot) return { x: 0, y: 0, visible: false };
    const p = new THREE.Vector3(slot.x, where === 'top' ? height(slot) + 0.06 : 0, slot.z + (where === 'bottom' ? slot.s * 0.5 : 0)).project(this.camera);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h, visible: !!n && !n.removing && n.appear > 0.3 };
  }

  // ------------------------------------------------------------------ model

  setModel(m: ArchModel) {
    const now = this.time;
    this.closed = m.current == null && m.nodes.some((n) => n.id === 'certificate');
    const wantN = new Set(m.nodes.map((n) => n.id));
    const wantE = new Set(m.edges.map((e) => e.id));
    for (const [id, v] of this.nodes) if (!wantN.has(id) && !v.removing) v.removing = now;
    for (const [id, v] of this.edges) if (!wantE.has(id) && !v.removing) v.removing = now;

    const freshNodes = m.nodes.filter((n) => !this.nodes.has(n.id) || this.nodes.get(n.id)!.removing);
    const freshEdges = m.edges.filter((e) => !this.edges.has(e.id) || this.edges.get(e.id)!.removing);
    const many = freshNodes.length > 7;
    const instant = this.reduce;
    let cursor = Math.max(now, this.nextFree);
    const nodeStart = new Map<ArchId, number>();
    const edgeStart = new Map<string, number>();

    // Walk new elements in event order: connector first, then the module it leads to.
    const items = [...freshNodes.map((n) => ({ order: n.order, node: n as ArchNode | null, edge: null as ArchEdge | null })), ...freshEdges.map((e) => ({ order: e.order, node: null, edge: e }))]
      .sort((a, b) => a.order - b.order);
    for (const it of items) {
      if (it.node) {
        const n = it.node;
        const incoming = freshEdges.filter((e) => e.to === n.id && e.kind === 'flow' && !edgeStart.has(e.id) && (this.nodes.has(e.from) && !this.nodes.get(e.from)!.removing || nodeStart.has(e.from)));
        const ghost = n.state === 'ghost';
        const grow = ghost || many ? 0.18 : 0.42;
        for (const e of incoming) edgeStart.set(e.id, Math.max(cursor, (nodeStart.get(e.from) ?? 0) + 0.25));
        const start = incoming.length ? Math.max(...incoming.map((e) => edgeStart.get(e.id)!)) + grow : cursor;
        nodeStart.set(n.id, start);
        cursor = start + (ghost ? 0.03 : many ? 0.1 : 0.3);
      } else if (it.edge && !edgeStart.has(it.edge.id)) {
        const e = it.edge;
        const after = Math.max(nodeStart.get(e.from) ?? 0, nodeStart.get(e.to) ?? 0) + (nodeStart.has(e.to) ? 0.5 : 0.2);
        edgeStart.set(e.id, Math.max(cursor - 0.2, after, now));
      }
    }
    this.nextFree = Math.max(now, cursor - 0.15);

    for (const n of m.nodes) {
      let v = this.nodes.get(n.id);
      if (v && v.removing) { this.disposeNode(v); this.nodes.delete(n.id); v = undefined; }
      if (!v) { v = this.makeNode(n, instant ? now - 2 : nodeStart.get(n.id) ?? now); this.nodes.set(n.id, v); }
      this.updateNode(v, n);
    }
    for (const e of m.edges) {
      let v = this.edges.get(e.id);
      if (v && v.removing) { this.disposeEdge(v); this.edges.delete(e.id); v = undefined; }
      if (!v) {
        const made = this.makeEdge(e, instant ? now - 2 : edgeStart.get(e.id) ?? now);
        if (!made) continue;
        v = made;
        this.edges.set(e.id, v);
      }
      this.updateEdge(v, e);
    }
  }

  clear() {
    for (const v of this.nodes.values()) this.disposeNode(v);
    for (const v of this.edges.values()) this.disposeEdge(v);
    this.nodes.clear();
    this.edges.clear();
    this.nextFree = this.time;
  }

  private geo(kind: Kind, s: number) {
    const key = `${kind}:${s}`;
    let g = this.boxGeo.get(key);
    if (!g) {
      const slot: Slot = { x: 0, z: 0, s, kind, side: 'below' };
      const h = height(slot);
      g = new RoundedBoxGeometry(s, h, s, 3, Math.min(0.05, s * 0.12));
      this.boxGeo.set(key, g);
    }
    return g;
  }

  private makeNode(n: ArchNode, start: number): NodeView {
    const slot = LAYOUT[n.id];
    const h = height(slot);
    const group = new THREE.Group();
    group.position.set(slot.x, 0, slot.z);
    this.scene.add(group);

    const glass = new THREE.Mesh(this.geo(slot.kind, slot.s), new THREE.MeshPhysicalMaterial({
      color: 0x16283a, metalness: 0.05, roughness: 0.16, transparent: true, opacity: 0,
      clearcoat: 0.55, clearcoatRoughness: 0.2, envMapIntensity: 0.75, emissive: 0x000000, depthWrite: false,
    }));
    glass.position.y = h / 2;
    glass.userData = { id: n.id };
    glass.renderOrder = 2;
    group.add(glass);

    const core = new THREE.Mesh(new THREE.BoxGeometry(slot.s * 0.5, h * 0.5, slot.s * 0.5), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.position.y = h / 2;
    core.renderOrder = 3;
    group.add(core);

    const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(slot.s * 1.004, h * 1.004, slot.s * 1.004));
    const lg = new LineSegmentsGeometry().setPositions(box.attributes.position.array as Float32Array);
    const lineMat = new LineMaterial({ color: 0xffffff, linewidth: slot.kind === 'leaf' ? 1.1 : 1.4, transparent: true, opacity: 0, depthWrite: false });
    lineMat.resolution.set(this.container.clientWidth, this.container.clientHeight);
    const lines = new LineSegments2(lg, lineMat);
    lines.position.y = h / 2;
    lines.renderOrder = 4;
    group.add(lines);

    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTexture(n.id), color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
    const isz = slot.kind === 'slab' ? slot.s * 0.62 : slot.s * 0.56;
    icon.scale.set(isz, isz, 1);
    icon.position.y = slot.kind === 'slab' ? h + isz * 0.42 : h / 2;
    icon.renderOrder = 5;
    group.add(icon);

    const glow = new THREE.Mesh(new THREE.PlaneGeometry(slot.s * 3.4, slot.s * 3.4), new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.004;
    group.add(glow);

    const rings = [0, 1].map(() => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 72), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.006;
      group.add(ring);
      return ring;
    });

    let replicas: THREE.InstancedMesh | null = null;
    if (n.replicas?.length) {
      const k = n.replicas.length;
      replicas = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }), k);
      const cols = k <= 2 ? k : Math.ceil(k / 2), rows = k <= 2 ? 1 : 2;
      const cell = (slot.s * 0.78) / Math.max(cols, 2);
      const m = new THREE.Matrix4();
      for (let i = 0; i < k; i++) {
        const cx = (i % cols) - (cols - 1) / 2, cz = Math.floor(i / cols) - (rows - 1) / 2;
        m.compose(new THREE.Vector3(cx * cell, h + 0.03, cz * cell * 1.3), new THREE.Quaternion(), new THREE.Vector3(cell * 0.62, 0.04, cell * 0.62));
        replicas.setMatrixAt(i, m);
        replicas.setColorAt(i, new THREE.Color(0x3a4650));
      }
      replicas.renderOrder = 6;
      group.add(replicas);
    }

    const el = document.createElement('div');
    el.className = `anode k-${slot.kind} side-${slot.side}`;
    el.dataset.id = n.id;
    el.innerHTML = '<div class="in"><b></b><span class="v"></span><i class="g"></i></div>';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${n.title}: details`);
    el.addEventListener('click', () => this.selectCbs.forEach((cb) => cb(n.id)));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.selectCbs.forEach((cb) => cb(n.id)); } });
    el.addEventListener('pointerenter', () => { this.hoverId = n.id; });
    el.addEventListener('pointerleave', () => { if (this.hoverId === n.id) this.hoverId = null; });
    const label = new CSS2DObject(el);
    const off = slot.s * 0.5 + 0.03;
    if (slot.side === 'right') label.position.set(off, h * 0.45, 0);
    else if (slot.side === 'left') label.position.set(-off, h * 0.45, 0);
    else if (slot.side === 'above') label.position.set(0, h + 0.04, -slot.s * 0.2);
    else label.position.set(0, 0, off);
    group.add(label);

    return {
      data: n, slot, group, glass, core, lines, lineMat, icon, glow, rings, replicas, label,
      color: new THREE.Color(STATE_HEX[n.state]), target: new THREE.Color(STATE_HEX[n.state]),
      start, appear: 0, removing: 0, hover: 0,
    };
  }

  private updateNode(v: NodeView, n: ArchNode) {
    v.data = n;
    v.target.set(STATE_HEX[n.state]);
    const el = v.label.element;
    el.className = `anode k-${v.slot.kind} side-${v.slot.side} s-${n.state}${el.classList.contains('in-view') ? ' in-view' : ''}`;
    const b = el.querySelector('b')!, sv = el.querySelector('.v')!, g = el.querySelector('.g')!;
    if (b.textContent !== n.title) b.textContent = n.title;
    const doing = n.state === 'active' || n.state === 'waiting' || n.state === 'failed' || n.state === 'fault';
    const line = doing ? n.verb ?? n.sub : n.id === 'serving' && n.state !== 'ghost' ? n.sub : '';
    if (sv.textContent !== line) sv.textContent = line ?? '';
    const tag = n.state === 'ghost' ? '' : n.tag ?? '';
    if (g.textContent !== tag) g.textContent = tag;
    if (v.replicas && n.replicas) {
      const c = new THREE.Color();
      n.replicas.forEach((r, i) => { if (i < v.replicas!.count) v.replicas!.setColorAt(i, c.set(REPLICA_HEX[r.tone])); });
      if (v.replicas.instanceColor) v.replicas.instanceColor.needsUpdate = true;
    }
  }

  private route(e: ArchEdge): THREE.Vector3[] | null {
    const a = LAYOUT[e.from], b = LAYOUT[e.to];
    if (!a || !b) return null;
    const y = 0.012;
    const gap = 0.05;
    const down = b.z >= a.z;
    const V = (x: number, z: number) => new THREE.Vector3(x, y, z);
    if (e.to.startsWith('o-') && e.from !== 'verify') {
      // A run that stopped early: out to the side lane, down past the pipeline, into the outcome.
      return [V(a.x + a.s / 2 + gap, a.z), V(SIDE_X, a.z), V(SIDE_X, b.z - 0.55), V(b.x, b.z - 0.55), V(b.x, b.z - (b.s / 2 + gap))];
    }
    if (a.x < 0 && b.x > 0 && b.z < a.z) {
      // From the system up to NEXUS through the centre lane.
      return [V(a.x + a.s / 2 + gap, a.z), V(LANE_X, a.z), V(LANE_X, b.z), V(b.x - (b.s / 2 + gap), b.z)];
    }
    if (Math.abs(b.z - a.z) < 0.2) {
      const sx = Math.sign(b.x - a.x) || 1;
      return [V(a.x + sx * (a.s / 2 + gap), a.z), V(b.x, a.z), V(b.x, b.z - (b.s / 2 + gap))];
    }
    const z0 = a.z + (down ? 1 : -1) * (a.s / 2 + gap), z1 = b.z - (down ? 1 : -1) * (b.s / 2 + gap);
    if (Math.abs(b.x - a.x) < 0.02) return [new THREE.Vector3(a.x, y, z0), new THREE.Vector3(b.x, y, z1)];
    const mz = (z0 + z1) / 2;
    return [new THREE.Vector3(a.x, y, z0), new THREE.Vector3(a.x, y, mz), new THREE.Vector3(b.x, y, mz), new THREE.Vector3(b.x, y, z1)];
  }

  /** A polyline with rounded corners, sampled densely. */
  private rounded(pts: THREE.Vector3[], r = 0.16): THREE.Vector3[] {
    if (pts.length < 3) return pts;
    const out: THREE.Vector3[] = [pts[0].clone()];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      const da = p.distanceTo(a), db = p.distanceTo(b);
      const rr = Math.min(r, da / 2, db / 2);
      const p0 = p.clone().add(a.clone().sub(p).normalize().multiplyScalar(rr));
      const p1 = p.clone().add(b.clone().sub(p).normalize().multiplyScalar(rr));
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const q = p0.clone().multiplyScalar((1 - t) * (1 - t)).add(p.clone().multiplyScalar(2 * (1 - t) * t)).add(p1.clone().multiplyScalar(t * t));
        out.push(q);
      }
    }
    out.push(pts[pts.length - 1].clone());
    return out;
  }

  private ribbon(pts: THREE.Vector3[], width: number): { geo: THREE.BufferGeometry; len: number } {
    const pos: number[] = [], along: number[] = [], idx: number[] = [];
    let acc = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) acc += pts[i].distanceTo(pts[i - 1]);
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
      const nx = -d.z * width / 2, nz = d.x * width / 2;
      pos.push(pts[i].x + nx, pts[i].y, pts[i].z + nz, pts[i].x - nx, pts[i].y, pts[i].z - nz);
      along.push(acc, acc);
      if (i > 0) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
    geo.setIndex(idx);
    return { geo, len: acc };
  }

  private arc(e: ArchEdge): { geo: THREE.BufferGeometry; len: number } | null {
    const a = LAYOUT[e.from], b = LAYOUT[e.to];
    if (!a || !b) return null;
    const pa = new THREE.Vector3(a.x, height(a) + 0.04, a.z), pb = new THREE.Vector3(b.x, height(b) + 0.04, b.z);
    const mid = pa.clone().lerp(pb, 0.5);
    const dist = pa.distanceTo(pb);
    // Arcs rise over the board and bow towards the top of the view, clear of the modules between.
    const ctrl = new THREE.Vector3(mid.x, 0.9 + dist * 0.2, mid.z - 0.35 - dist * 0.08);
    const curve = new THREE.QuadraticBezierCurve3(pa, ctrl, pb);
    const geo = new THREE.TubeGeometry(curve, 72, 0.011, 6, false);
    const len = curve.getLength();
    const uv = geo.attributes.uv;
    const along = new Float32Array(uv.count);
    for (let i = 0; i < uv.count; i++) along[i] = uv.getX(i) * len;
    geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
    return { geo, len };
  }

  private makeEdge(e: ArchEdge, start: number): EdgeView | null {
    let built: { geo: THREE.BufferGeometry; len: number } | null;
    if (e.kind === 'flow') {
      const pts = this.route(e);
      if (!pts) return null;
      built = this.ribbon(this.rounded(pts), e.state === 'ghost' ? 0.016 : 0.024);
    } else built = this.arc(e);
    if (!built) return null;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uGrow: { value: 0 }, uLen: { value: built.len }, uColor: { value: new THREE.Color(0xffffff) }, uOpacity: { value: 0.5 },
        uTime: { value: 0 }, uLive: { value: 0 }, uDash: { value: e.state === 'ghost' ? 1 : 0 }, uSpeed: { value: e.kind === 'flow' ? 1.6 : 2.4 },
      },
      vertexShader: EDGE_VS, fragmentShader: EDGE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(built.geo, mat);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    const col = new THREE.Color(this.edgeHex(e));
    return { data: e, mesh, len: built.len, start, dur: e.kind === 'flow' ? (e.state === 'ghost' ? 0.3 : 0.45) : 0.38, removing: 0, color: col.clone(), target: col, opacity: 0, targetOpacity: this.edgeOpacity(e) };
  }

  private edgeHex(e: ArchEdge) {
    if (e.kind !== 'flow' && (e.state === 'live' || e.state === 'done')) return KIND_HEX[e.kind];
    return EDGE_HEX[e.state];
  }
  private edgeOpacity(e: ArchEdge) {
    if (e.kind !== 'flow') return e.state === 'live' ? 0.85 : 0.14;
    return { live: 0.8, done: 0.3, context: 0.24, fault: 0.6, ghost: 0.2 }[e.state];
  }

  private updateEdge(v: EdgeView, e: ArchEdge) {
    v.data = e;
    v.target.set(this.edgeHex(e));
    v.targetOpacity = this.edgeOpacity(e);
    v.mesh.material.uniforms.uDash.value = e.state === 'ghost' ? 1 : 0;
  }

  private disposeNode(v: NodeView) {
    this.scene.remove(v.group);
    v.label.element.remove();
    v.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material && !(m.geometry && [...this.boxGeo.values()].includes(m.geometry))) m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
  }
  private disposeEdge(v: EdgeView) {
    this.scene.remove(v.mesh);
    v.mesh.geometry.dispose();
    v.mesh.material.dispose();
  }

  // -------------------------------------------------------------------- tick

  setRunning(on: boolean) {
    if (on === this.running || this.disposed) return;
    this.running = on;
    this.last = performance.now();
    this.renderer.setAnimationLoop(on ? () => this.tick() : null);
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.time += dt;
    const t = this.time;
    if (!this.container.clientWidth) return;
    if (!this.reduce) {
      const f = 1 - Math.exp(-dt * 1.4);
      this.parallax.x += (this.parallax.tx - this.parallax.x) * f;
      this.parallax.y += (this.parallax.ty - this.parallax.y) * f;
      this.place();
    }
    this.floor.uniforms.uTime.value = t;
    const k = 1 - Math.exp(-dt * 4);
    const c = new THREE.Color();

    for (const [id, v] of this.nodes) {
      if (v.removing) {
        const r = clamp01((t - v.removing) / 0.45);
        v.appear = Math.min(v.appear, 1 - r);
        if (r >= 1) { this.disposeNode(v); this.nodes.delete(id); continue; }
      } else v.appear = clamp01((t - v.start) / 0.95);
      const p = v.appear;
      const st = v.data.state;
      v.color.lerp(v.target, k);
      v.hover += ((this.hoverId === id ? 1 : 0) - v.hover) * (1 - Math.exp(-dt * 10));
      const live = st === 'active' || st === 'fault' || (st === 'waiting' && !this.closed);
      const beat = this.reduce ? 0.6 : 0.5 + 0.5 * Math.sin(t * (st === 'waiting' ? 2.2 : 3.4) + v.slot.x);
      const gain = GAIN[st] * (1 + v.hover * 0.25);

      // Materialize: edges trace the cube, the glass fills, the core and icon light, it settles onto the board.
      const pe = easeOut(clamp01(p / 0.35)), pg = easeOut(clamp01((p - 0.2) / 0.55)), pi = easeOut(clamp01((p - 0.38) / 0.5));
      const s = 0.8 + 0.2 * easeOut(p) + v.hover * 0.05;
      v.group.scale.setScalar(s);
      v.group.position.y = (1 - easeOut(p)) * -0.18 + (st === 'active' && !this.reduce ? Math.sin(t * 2.1) * 0.018 : 0);
      const flash = Math.max(0, 1 - Math.abs(p - 0.3) / 0.18);
      v.lineMat.color.copy(c.copy(v.color).multiplyScalar(gain * (1.15 + flash * 1.4 + (live ? beat * 0.45 : 0))));
      v.lineMat.opacity = pe * (st === 'ghost' ? 0.45 : 0.95);
      v.glass.material.opacity = pg * (st === 'ghost' ? 0.18 : 0.5);
      v.glass.material.emissive.copy(c.copy(v.color).multiplyScalar((st === 'ghost' ? 0.02 : 0.1) * gain + (live ? beat * 0.08 : 0)));
      v.core.material.color.copy(v.color);
      v.core.material.opacity = pi * (st === 'ghost' ? 0 : st === 'context' ? 0.05 : 0.1 + (live ? beat * 0.12 : 0));
      v.icon.material.color.copy(c.copy(v.color).multiplyScalar(st === 'ghost' ? 0.55 : 0.85 + (live ? beat * 0.6 : 0.2)));
      v.icon.material.opacity = pi * (st === 'ghost' ? 0.5 : 1);
      v.glow.material.color.copy(v.color);
      v.glow.material.opacity = pg * (st === 'ghost' ? 0.02 : st === 'context' ? 0.07 : 0.13 + (live ? beat * 0.1 : 0));
      if (v.replicas) (v.replicas.material as THREE.MeshBasicMaterial).opacity = pi;
      v.rings.forEach((ring, i) => {
        if (!live || this.reduce || p < 0.8) { ring.material.opacity = 0; return; }
        const ph = ((t / 2.4) + i * 0.5) % 1;
        const r = v.slot.s * (0.75 + ph * 1.5);
        ring.scale.set(r, r, r);
        ring.material.color.copy(v.color);
        ring.material.opacity = (1 - ph) * (1 - ph) * 0.55;
      });
      const inView = p > 0.42 && !v.removing;
      if (inView !== v.label.element.classList.contains('in-view')) v.label.element.classList.toggle('in-view', inView);
    }

    for (const [id, v] of this.edges) {
      const u = v.mesh.material.uniforms;
      if (v.removing) {
        const r = clamp01((t - v.removing) / 0.35);
        v.opacity = (1 - r) * v.targetOpacity;
        if (r >= 1) { this.disposeEdge(v); this.edges.delete(id); continue; }
      } else v.opacity += (v.targetOpacity - v.opacity) * k;
      const g = clamp01((t - v.start) / v.dur);
      u.uGrow.value = (t < v.start ? 0 : easeInOut(g)) * v.len + (g >= 1 ? 0.01 : 0);
      v.color.lerp(v.target, k);
      u.uColor.value.copy(v.color);
      u.uOpacity.value = v.opacity;
      u.uTime.value = t;
      u.uLive.value = this.reduce ? 0 : v.data.state === 'live' ? 1 : v.data.state === 'fault' ? 0.45 : 0;
    }
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.labels.setSize(w, h);
    for (const v of this.nodes.values()) v.lineMat.resolution.set(w, h);
    this.fit();
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    window.removeEventListener('pointermove', this.onWindowPointer);
    this.clear();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
