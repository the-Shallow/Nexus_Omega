// Shared color language for the 3D view and the HUD (light theme).
import * as THREE from 'three';

// Temperature ramp (°C), tuned to read on a light background:
// cool blue → teal → NVIDIA green → amber → orange → red → magenta at shutdown.
const HEAT_STOPS = [
  [16, 0x2563eb],
  [30, 0x0891b2],
  [48, 0x10b981],
  [64, 0x76b900],
  [76, 0xeab308],
  [86, 0xf97316],
  [92, 0xe11d48],
  [97, 0xc026d3],
].map(([t, hex]) => [t, new THREE.Color(hex)]);

export function heatColor(t, out = new THREE.Color()) {
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

export function heatCss(t) {
  return '#' + heatColor(t).getHexString();
}

// Air runs cooler than silicon: stretch its range so a 55 °C hot aisle reads orange.
export const airTemp = (t) => 18 + (t - 18) * 1.7;
export const airColor = (t, out) => heatColor(airTemp(t), out);
export const airCss = (t) => heatCss(airTemp(t));

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

export const COLORS = {
  request: new THREE.Color(0x0ea5e9),
  ok: new THREE.Color(0x65a30d),
  err: new THREE.Color(0xe11d48),
  silent: new THREE.Color(0xf59e0b),
  shed: new THREE.Color(0x7c3aed),
  power: new THREE.Color(0xf59e0b),
  powerCapped: new THREE.Color(0xea580c),
  ingress: new THREE.Color(0x6366f1),
};

export const STATUS = {
  ok: 0x76b900,
  warn: 0xf59e0b,
  bad: 0xe11d48,
  restart: 0x0ea5e9,
  off: 0x94a3b8,
  xid: 0xc026d3,
  batch: 0x64748b,
};

export const CSS = {
  green: '#76b900',
  cyan: '#0891b2',
  amber: '#d97706',
  red: '#e11d48',
  violet: '#7c3aed',
  ink3: '#98a2b3',
};
