// Shared color language for the 3D view and the HUD.
import * as THREE from 'three';

// Temperature ramp (°C): deep blue supply air → cyan → teal → yellow → orange → red → magenta at shutdown.
const HEAT_STOPS = [
  [16, 0x1f3cff],
  [30, 0x00b8ff],
  [48, 0x19e3b1],
  [64, 0xc8f04a],
  [76, 0xffc23d],
  [86, 0xff6a1f],
  [92, 0xff2d55],
  [97, 0xff3df2],
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

// Air runs cooler than silicon: stretch its range so a 55 °C hot aisle reads orange, not green.
export const airTemp = (t) => 18 + (t - 18) * 1.7;
export const airColor = (t, out) => heatColor(airTemp(t), out);
export const airCss = (t) => heatCss(airTemp(t));

// GLSL version of the same ramp, for shader materials.
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
  request: new THREE.Color(0x4de8ff),
  ok: new THREE.Color(0x3dffa0),
  err: new THREE.Color(0xff3355),
  silent: new THREE.Color(0xffb020),
  shed: new THREE.Color(0xb46bff),
  power: new THREE.Color(0xffc861),
  powerCapped: new THREE.Color(0xff5a2a),
  ingress: new THREE.Color(0x7aa8ff),
};

export const STATUS = {
  ok: 0x2dff8f,
  warn: 0xffb020,
  bad: 0xff2d55,
  restart: 0x3d8bff,
  off: 0x3a4255,
  xid: 0xff3df2,
  batch: 0x7f93b8,
};
