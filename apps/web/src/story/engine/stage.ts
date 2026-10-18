// The story stage: renderer, bloom, lights, a floor (optionally gridded) that carries expanding
// waves, and a tweened camera. Copied from TwinScene's setup so the story keeps the
// twin's look without needing a live topology or frame stream.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ease, pointScale, type V3 } from './fx';

const BG = 0x07090a;
const _orbit = new THREE.Vector3(), _orbitT = new THREE.Vector3();
const FOV = 36;

const FLOOR_VS = `varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FLOOR_FS = `
uniform float uTime; uniform vec2 uCenter; uniform float uFade; uniform float uGrid;
uniform vec4 uWaves[8]; uniform vec3 uWaveCol[8]; uniform float uWaveSpeed[8];
varying vec3 vW;
void main(){
  vec2 q = vW.xz / 0.6;
  vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float fade = 1.0 - smoothstep(uFade * 0.35, uFade, length(vW.xz - uCenter));
  vec3 col = vec3(0.22, 0.42, 0.10) * line * 0.16 * fade * uGrid;
  for (int i = 0; i < 8; i++) {
    vec4 w = uWaves[i];
    float age = uTime - w.z;
    if (w.z < 0.0 || age < 0.0 || age > w.w) continue;
    float k = age / w.w;
    float r = age * uWaveSpeed[i];
    float d = abs(length(vW.xz - w.xy) - r);
    float ring = exp(-d * d * 10.0) * (1.0 - k) * (1.0 - k);
    col += uWaveCol[i] * ring * 1.3;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export interface StageOpts {
  floor?: [number, number]; center?: [number, number]; fade?: number; camera?: { pos: V3; target: V3 }; fog?: [number, number];
  /** Draw the faint floor grid (the specimen page keeps it; the story floor uses zone tints instead). */
  grid?: boolean;
  /** Bloom strength, radius, threshold. */
  bloom?: [number, number, number];
  ground?: number;
}

export class Stage {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  time = 0;
  disposed = false;
  /** Called every frame with (time, dt) before rendering. */
  tickers = new Set<(t: number, dt: number) => void>();

  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private labels: CSS2DRenderer;
  private floorFx: THREE.ShaderMaterial;
  private waveSlot = 0;
  private tween: { t: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; resolve: () => void } | null = null;
  private last = performance.now();
  private ro: ResizeObserver;
  private viewShift = 0;
  private orbiting: { cx: number; cz: number; r: number; h: number; ty: number; speed: number; a: number } | null = null;
  private viewShiftTarget = 0;

  constructor(private container: HTMLElement, opts: StageOpts = {}) {
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

    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    this.labels.domElement.className = 'twin-labels';
    container.appendChild(this.labels.domElement);

    const s = this.scene;
    s.background = new THREE.Color(BG);
    const [fogNear, fogFar] = opts.fog ?? [16, 46];
    s.fog = new THREE.Fog(BG, fogNear, fogFar);
    const pmrem = new THREE.PMREMGenerator(renderer);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.18;

    const cam = opts.camera ?? { pos: [0, 4, 9], target: [0, 1, 0] };
    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.05, 300);
    this.camera.position.set(...cam.pos);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.target.set(...cam.target);
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.addEventListener('start', () => { this.tween?.resolve(); this.tween = null; this.orbiting = null; });

    s.add(new THREE.HemisphereLight(0xa9bccb, 0x07090a, 0.75));
    const key = new THREE.DirectionalLight(0xe4ecf2, 1.6);
    key.position.set(7, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -26, right: 26, top: 16, bottom: -16, near: 1, far: 60 });
    key.shadow.bias = -0.0005;
    key.shadow.radius = 5;
    s.add(key);
    const rim = new THREE.DirectionalLight(0x9be22d, 0.32);
    rim.position.set(-9, 5, -8);
    s.add(rim);
    const fill = new THREE.DirectionalLight(0x5aa7ff, 0.22);
    fill.position.set(-6, 3, 9);
    s.add(fill);

    // Floor: matte ground, then an additive grid that also carries the waves.
    const [fw, fd] = opts.floor ?? [60, 40];
    const [cx, cz] = opts.center ?? [0, 0];
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(fw * 3, fd * 3), new THREE.MeshStandardMaterial({ color: opts.ground ?? 0x060809, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.01, cz);
    ground.receiveShadow = true;
    s.add(ground);
    this.floorFx = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uGrid: { value: opts.grid === false ? 0 : 1 }, uCenter: { value: new THREE.Vector2(cx, cz) }, uFade: { value: opts.fade ?? Math.max(fw, fd) * 0.6 },
        uWaves: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -1, 1)) },
        uWaveCol: { value: Array.from({ length: 8 }, () => new THREE.Color()) },
        uWaveSpeed: { value: new Array(8).fill(4) },
      },
      vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const fx = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), this.floorFx);
    fx.rotation.x = -Math.PI / 2;
    fx.position.set(cx, 0.003, cz);
    fx.renderOrder = 1;
    s.add(fx);

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.composer.addPass(new RenderPass(s, this.camera));
    const [bs, br, bt] = opts.bloom ?? [0.7, 0.55, 0.82];
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), bs, br, bt);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    renderer.setAnimationLoop(() => this.tick());
  }

  /** Fly the camera; resolves when it lands (or when the user grabs the camera). */
  flyTo(pos: V3, target: V3, dur = 2.2): Promise<void> {
    this.tween?.resolve();
    this.orbiting = null;
    return new Promise((resolve) => {
      if (dur <= 0) {
        this.camera.position.set(...pos);
        this.controls.target.set(...target);
        this.tween = null;
        return resolve();
      }
      this.tween = { t: 0, dur, p0: this.camera.position.clone(), p1: new THREE.Vector3(...pos), t0: this.controls.target.clone(), t1: new THREE.Vector3(...target), resolve };
    });
  }

  /** A slow ambient orbit around a point on the floor, starting from where the camera is. Any fly-to or drag ends it. */
  orbit(center: [number, number], radius: number, height: number, speed = 0.03, targetY = 0.5) {
    const a = Math.atan2(this.camera.position.z - center[1], this.camera.position.x - center[0]);
    this.orbiting = { cx: center[0], cz: center[1], r: radius, h: height, ty: targetY, speed, a };
  }

  /** Shift the picture right by a fraction of the width, clear of a left-hand rail. */
  setFocusInset(fraction: number, instant = false) {
    this.viewShiftTarget = fraction;
    if (instant) { this.viewShift = fraction; this.applyViewOffset(); this.camera.updateProjectionMatrix(); }
  }

  /** Advance every ticker without rendering, so a screenshot shows a scene already in motion. */
  warm(seconds: number, step = 1 / 30) {
    for (let k = 0; k < seconds / step; k++) {
      this.time += step;
      for (const fn of this.tickers) fn(this.time, step);
    }
  }

  /** An expanding ring on the floor. */
  wave(x: number, z: number, color: number, life = 3, speed = 4) {
    const i = this.waveSlot++ % 8;
    (this.floorFx.uniforms.uWaves.value as THREE.Vector4[])[i].set(x, z, this.time, life);
    (this.floorFx.uniforms.uWaveCol.value as THREE.Color[])[i].set(color);
    (this.floorFx.uniforms.uWaveSpeed.value as number[])[i] = speed;
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  private tick() {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.time += dt;
    if (!this.container.clientWidth) return;
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt / tw.dur;
      const e = ease(tw.t);
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.t0, tw.t1, e);
      if (tw.t >= 1) { this.tween = null; tw.resolve(); }
    } else if (this.orbiting) {
      const o = this.orbiting;
      o.a += dt * o.speed;
      this.camera.position.lerp(_orbit.set(o.cx + Math.cos(o.a) * o.r, o.h, o.cz + Math.sin(o.a) * o.r), 0.03);
      this.controls.target.lerp(_orbitT.set(o.cx, o.ty, o.cz), 0.03);
    }
    this.controls.update(dt);
    this.floorFx.uniforms.uTime.value = this.time;
    if (Math.abs(this.viewShiftTarget - this.viewShift) > 0.0005) {
      this.viewShift += (this.viewShiftTarget - this.viewShift) * (1 - Math.exp(-dt * 3));
      this.applyViewOffset();
    }
    for (const fn of this.tickers) fn(this.time, dt);
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }

  private applyViewOffset() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    // A negative x offset moves the picture right, away from the left rail.
    if (Math.abs(this.viewShift) > 0.0005) this.camera.setViewOffset(w, h, -this.viewShift * w, 0, w, h);
    else this.camera.clearViewOffset();
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.applyViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.labels.setSize(w, h);
    pointScale.value = (h * Math.min(window.devicePixelRatio, 2)) / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  }
}
