// Color language of the dark twin. Status colors are semantic and shared with the UI.
import * as THREE from 'three';

// GPU temperature ramp (°C), tuned to glow on graphite:
// deep blue → teal → NVIDIA green → amber → orange → red → magenta near shutdown.
const HEAT_STOPS: [number, THREE.Color][] = (
  [
    [16, 0x2552d9],
    [30, 0x0e8fb0],
    [48, 0x12a88f],
    [64, 0x76b900],
    [76, 0xe6b30a],
    [86, 0xf97316],
    [92, 0xef4444],
    [97, 0xd946ef],
  ] as [number, number][]
).map(([t, hex]) => [t, new THREE.Color(hex)]);

export function heatColor(t: number, out = new THREE.Color()): THREE.Color {
  if (t <= HEAT_STOPS[0][0]) return out.copy(HEAT_STOPS[0][1]);
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [t1, c1] = HEAT_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = HEAT_STOPS[i - 1];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(HEAT_STOPS[HEAT_STOPS.length - 1][1]);
}

// Air runs cooler than silicon: stretch its range so a 55 °C hot aisle reads orange.
export const airColor = (t: number, out = new THREE.Color()) => heatColor(18 + (t - 18) * 1.7, out);

// Hot exhaust air gets its own warm ramp (ember → amber → orange → red) so rising
// heat never passes through the green that means "healthy" elsewhere.
const WARM_STOPS: [number, THREE.Color][] = (
  [
    [26, 0x2a1606],
    [36, 0x8a4a0a],
    [44, 0xf59e0b],
    [52, 0xf97316],
    [60, 0xef4444],
  ] as [number, number][]
).map(([t, hex]) => [t, new THREE.Color(hex)]);

export function exhaustColor(t: number, out = new THREE.Color()): THREE.Color {
  if (t <= WARM_STOPS[0][0]) return out.copy(WARM_STOPS[0][1]);
  for (let i = 1; i < WARM_STOPS.length; i++) {
    const [t1, c1] = WARM_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = WARM_STOPS[i - 1];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(WARM_STOPS[WARM_STOPS.length - 1][1]);
}

export const WARM_GLSL = `
vec3 warm(float t) {
  ${WARM_STOPS.map(([, c], i) => `vec3 w${i} = vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)});`).join('\n  ')}
  ${WARM_STOPS.map(([t], i) => `float s${i} = ${t.toFixed(1)};`).join('\n  ')}
  if (t <= s0) return w0;
  ${WARM_STOPS.slice(1).map((_, k) => {
    const i = k + 1;
    return `if (t <= s${i}) return mix(w${i - 1}, w${i}, (t - s${i - 1}) / (s${i} - s${i - 1}));`;
  }).join('\n  ')}
  return w${WARM_STOPS.length - 1};
}`;

export const HEAT_GLSL = `
vec3 heat(float t) {
  ${HEAT_STOPS.map(([, c], i) => `vec3 c${i} = vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)});`).join('\n  ')}
  ${HEAT_STOPS.map(([t], i) => `float t${i} = ${t.toFixed(1)};`).join('\n  ')}
  if (t <= t0) return c0;
  ${HEAT_STOPS.slice(1).map((_, k) => {
    const i = k + 1;
    return `if (t <= t${i}) return mix(c${i - 1}, c${i}, (t - t${i - 1}) / (t${i} - t${i - 1}));`;
  }).join('\n  ')}
  return c${HEAT_STOPS.length - 1};
}`;

/** Packet colors: what each request or response actually did. */
export const FLOW = {
  ingress: new THREE.Color(0xc8d3dc),
  request: new THREE.Color(0x38bdf8),
  ok: new THREE.Color(0x8ed61a),
  silent: new THREE.Color(0xf59e0b),
  err: new THREE.Color(0xf43f5e),
  shed: new THREE.Color(0xa78bfa),
  power: new THREE.Color(0xf5a623),
  powerCapped: new THREE.Color(0xf97316),
};

/** Entity status. Matches the CSS tokens in index.css. */
export const STATUS = {
  ok: 0x76b900,
  warn: 0xf59e0b,
  bad: 0xf43f5e,
  restart: 0x38bdf8,
  off: 0x55606a,
  xid: 0xd946ef,
  thermal: 0xf97316,
  batch: 0x3a4650,
  neutral: 0x222a30,
};
