// Shared visual effects for story mode, lifted from twin/scene.ts so the story
// can run without a live topology: polyline routes, additive point particles,
// travelling packets (solid or hollow), earthquake rings, glow and label helpers.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export type V3 = [number, number, number];

const _v = new THREE.Vector3();

/** Bloom picks up anything above ~0.82 luminance, so glow is just an over-bright basic color. */
export const glow = (hex: number | THREE.Color, k = 2.2) => new THREE.Color(hex).multiplyScalar(k);
export const basic = (hex: number, k = 2.2, extra: THREE.MeshBasicMaterialParameters = {}) => new THREE.MeshBasicMaterial({ color: glow(hex, k), ...extra });
export const additive = (hex: number, opacity: number, k = 1) =>
  new THREE.MeshBasicMaterial({ color: glow(hex, k), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
export const metal = (color = 0x161b20, metalness = 0.55, roughness = 0.45) => new THREE.MeshStandardMaterial({ color, metalness, roughness });

export function mesh<G extends THREE.BufferGeometry, M extends THREE.Material | THREE.Material[]>(geo: G, mat: M, at?: V3, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = true;
  if (at) m.position.set(...at);
  return m;
}

export function edges(geo: THREE.BufferGeometry, color: number, opacity = 1) {
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  return new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
}

export function label(html: string, cls: string, at?: V3) {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  const o = new CSS2DObject(el);
  if (at) o.position.set(...at);
  return o;
}

/** A canvas-backed texture, redrawn on demand. */
export function canvasTex(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { c, ctx, tex };
}

// ------------------------------------------------------------------ routes

export interface Route { pts: THREE.Vector3[]; cum: number[]; len: number }

export function polyline(points: (V3 | THREE.Vector3)[]): Route {
  const pts = points.map((p) => (p instanceof THREE.Vector3 ? p.clone() : new THREE.Vector3(...p)));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return { pts, cum, len: cum[cum.length - 1] };
}

export function sample(route: Route, d: number, out: THREE.Vector3) {
  const { pts, cum } = route;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  return out.copy(pts[i - 1]).lerp(pts[i], Math.min(1, Math.max(0, (d - cum[i - 1]) / seg)));
}

/** A smooth curve through points, flattened to a polyline for constant-speed travel. */
export function curve(points: V3[], divisions = 48): Route {
  const c = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  return polyline(c.getSpacedPoints(divisions));
}

// --------------------------------------------------------------- particles

/** Point size scale shared by every particle system; the stage updates it on resize. */
export const pointScale = { value: 900 };

const POINT_VS = `
attribute float size; attribute float alpha; attribute vec3 color; attribute float ring;
uniform float uPx;
varying vec3 vColor; varying float vAlpha; varying float vRing;
void main() {
  vColor = color; vAlpha = alpha; vRing = ring;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * uPx / -mv.z, 1.0, 40.0);
  gl_Position = projectionMatrix * mv;
}`;
// Solid packets are soft discs. Hollow packets (a 200 OK with nothing inside) are rings.
const POINT_FS = `
varying vec3 vColor; varying float vAlpha; varying float vRing;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a;
  if (vRing > 0.5) { a = exp(-pow((d - 0.36) * 16.0, 2.0)) * 1.25; }
  else { a = smoothstep(0.5, 0.0, d); a = a * a; }
  a *= vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

export class Particles {
  count: number;
  pos: Float32Array; col: Float32Array; size: Float32Array; alpha: Float32Array; ring: Float32Array;
  geo = new THREE.BufferGeometry();
  mat: THREE.ShaderMaterial;
  points: THREE.Points;
  constructor(count: number) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.ring = new Float32Array(count);
    const attrs: [string, Float32Array, number][] = [['position', this.pos, 3], ['color', this.col, 3], ['size', this.size, 1], ['alpha', this.alpha, 1], ['ring', this.ring, 1]];
    for (const [name, arr, n] of attrs) this.geo.setAttribute(name, new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uPx: pointScale }, vertexShader: POINT_VS, fragmentShader: POINT_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  set(i: number, p: THREE.Vector3, c: THREE.Color, size: number, alpha: number, ring = 0) {
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    this.size[i] = size; this.alpha[i] = alpha; this.ring[i] = ring;
  }
  flush() {
    for (const k of ['position', 'color', 'size', 'alpha', 'ring']) (this.geo.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
  }
}

export interface SpawnOpts { reverse?: boolean; dur?: number; delay?: number; size?: number; gain?: number; hollow?: boolean; until?: number }

/** Pooled packets travelling along routes. Coordinates are local to whatever group holds `points`. */
export class Travelers {
  p: Particles;
  route: Int32Array; t: Float32Array; dur: Float32Array; delay: Float32Array; rev: Uint8Array; sz: Float32Array; hollow: Uint8Array; until: Float32Array;
  color: THREE.Color[];
  free: number[];
  routes: Route[] = [];
  constructor(count = 160) {
    this.p = new Particles(count);
    this.route = new Int32Array(count).fill(-1);
    this.t = new Float32Array(count);
    this.dur = new Float32Array(count);
    this.delay = new Float32Array(count);
    this.rev = new Uint8Array(count);
    this.sz = new Float32Array(count);
    this.hollow = new Uint8Array(count);
    this.until = new Float32Array(count);
    this.color = Array.from({ length: count }, () => new THREE.Color());
    this.free = Array.from({ length: count }, (_, i) => count - 1 - i);
  }
  get points() { return this.p.points; }
  add(route: Route | (V3 | THREE.Vector3)[]) {
    this.routes.push(Array.isArray(route) ? polyline(route) : route);
    return this.routes.length - 1;
  }
  spawn(route: number, color: THREE.Color | number, { reverse = false, dur = 1.1, delay = 0, size = 0.09, gain = 1.6, hollow = false, until = 1 }: SpawnOpts = {}) {
    const i = this.free.pop();
    if (i === undefined) return;
    this.route[i] = route; this.t[i] = 0; this.dur[i] = dur; this.delay[i] = delay;
    this.rev[i] = reverse ? 1 : 0; this.sz[i] = size; this.hollow[i] = hollow ? 1 : 0; this.until[i] = until;
    this.color[i].set(color).multiplyScalar(gain);
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
      // `until` < 1 kills a packet part way along its route (a request that never comes back).
      if (this.t[i] >= this.until[i]) { this.route[i] = -1; p.alpha[i] = 0; this.free.push(i); continue; }
      const route = this.routes[r];
      sample(route, (this.rev[i] ? 1 - this.t[i] : this.t[i]) * route.len, _v);
      const end = this.until[i];
      p.set(i, _v, this.color[i], this.sz[i], Math.min(1, this.t[i] * 8, (end - this.t[i]) * 8), this.hollow[i]);
    }
    p.flush();
  }
}

/** Sparks flung outward from a point: the visible death of a failed request. */
export class Sparks {
  p: Particles;
  vel: Float32Array; life: Float32Array; age: Float32Array; origin = new THREE.Vector3(); color = new THREE.Color();
  private next = 0;
  constructor(count = 48) {
    this.p = new Particles(count);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.age = new Float32Array(count).fill(99);
  }
  get points() { return this.p.points; }
  burst(at: THREE.Vector3, color: number, n = 8, speed = 1.4) {
    for (let k = 0; k < n; k++) {
      const i = this.next++ % this.p.count;
      const a = Math.random() * Math.PI * 2, e = (Math.random() - 0.3) * 1.2;
      this.vel[i * 3] = Math.cos(a) * speed * (0.5 + Math.random());
      this.vel[i * 3 + 1] = e * speed;
      this.vel[i * 3 + 2] = Math.sin(a) * speed * (0.5 + Math.random());
      this.p.pos[i * 3] = at.x; this.p.pos[i * 3 + 1] = at.y; this.p.pos[i * 3 + 2] = at.z;
      this.age[i] = 0; this.life[i] = 0.35 + Math.random() * 0.35;
      this.color.set(color).multiplyScalar(2.4);
      this.p.col[i * 3] = this.color.r; this.p.col[i * 3 + 1] = this.color.g; this.p.col[i * 3 + 2] = this.color.b;
      this.p.size[i] = 0.05; this.p.ring[i] = 0;
    }
  }
  update(dt: number) {
    const p = this.p;
    for (let i = 0; i < p.count; i++) {
      this.age[i] += dt;
      const k = this.age[i] / (this.life[i] || 1);
      if (k >= 1) { p.alpha[i] = 0; continue; }
      p.pos[i * 3] += this.vel[i * 3] * dt; p.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; p.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= dt * 2.5;
      p.alpha[i] = (1 - k) * (1 - k);
    }
    p.flush();
  }
}

// ------------------------------------------------------------ fault rings

/**
 * Earthquake rings: concentric red rings expanding across the floor from a broken
 * block, with a bright core. Fades in and out with `active`.
 */
export class Quake {
  group = new THREE.Group();
  active = false;
  private level = 0;
  private rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private core: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  constructor(private radius = 1.6, color = 0xf43f5e, count = 3, private period = 1.5) {
    for (let k = 0; k < count; k++) {
      const r = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 72), additive(color, 0, 2.2));
      r.rotation.x = -Math.PI / 2;
      r.renderOrder = 2;
      this.rings.push(r);
      this.group.add(r);
    }
    this.core = new THREE.Mesh(new THREE.CircleGeometry(0.7, 48), additive(color, 0, 1.2));
    this.core.rotation.x = -Math.PI / 2;
    this.group.add(this.core);
    this.group.position.y = 0.012;
  }
  setColor(hex: number) { for (const r of this.rings) r.material.color.copy(glow(hex, 2.2)); this.core.material.color.copy(glow(hex, 1.2)); }
  update(t: number, dt: number) {
    this.level += ((this.active ? 1 : 0) - this.level) * (1 - Math.exp(-dt * 4));
    this.group.visible = this.level > 0.01;
    if (!this.group.visible) return;
    this.rings.forEach((r, k) => {
      const q = ((t / this.period) + k / this.rings.length) % 1;
      r.scale.setScalar(0.25 + q * this.radius);
      r.material.opacity = (1 - q) * (1 - q) * this.level;
    });
    this.core.material.opacity = (0.14 + 0.08 * Math.sin(t * 9)) * this.level;
  }
}

/** A tiny tremor: offset to add to a broken block's position. */
export function shake(t: number, amp: number, out = new THREE.Vector3()) {
  return out.set(Math.sin(t * 61) * amp + Math.sin(t * 37) * amp * 0.6, 0, Math.cos(t * 53) * amp * 0.7);
}

// --------------------------------------------------------------- hologram

/** Violet wireframe used for anything simulated: the shadow twin and its candidates. */
export function holo(geo: THREE.BufferGeometry, color = 0xa78bfa, faceOpacity = 0.05) {
  const g = new THREE.Group();
  const face = new THREE.Mesh(geo, additive(color, faceOpacity, 1));
  face.renderOrder = 3;
  const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: glow(color, 1.5), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  g.add(face, line);
  return { group: g, face, line };
}

export const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
export const damp = (k: number, dt: number) => 1 - Math.exp(-dt * k);
