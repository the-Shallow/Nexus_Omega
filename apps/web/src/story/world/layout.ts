// Where everything sits on the floor. Rooms follow the design.html diagram left to
// right: callers → front door → serving floor → signals → Nexus (doctors above,
// shadow twin below), so the finale's top-down view reads as the architecture.
import type { V3 } from '../engine/fx';

export type RoomId = 'callers' | 'door' | 'gpu' | 'signals' | 'doctors' | 'twin';

export interface RoomDef { id: RoomId; n: string; name: string; sub: string; x: number; z: number; w: number; d: number; h: number }

export const ROOMS: RoomDef[] = [
  { id: 'callers', n: '01', name: 'Callers', sub: 'agents and people', x: -20, z: 0, w: 5.2, d: 6.2, h: 0.14 },
  { id: 'door', n: '02', name: 'Front door', sub: 'gateway', x: -12.5, z: 0, w: 4.2, d: 5.2, h: 0.14 },
  { id: 'gpu', n: '03', name: 'GPU floor', sub: '8 vLLM replicas · substrate below', x: -3, z: 0, w: 7.8, d: 5.0, h: 0.55 },
  { id: 'signals', n: '04', name: 'Signals', sub: 'dashboards and canary', x: 6.6, z: 0, w: 5.4, d: 5.0, h: 0.14 },
  { id: 'doctors', n: '05', name: 'Doctors', sub: 'manager · 2 doctors · policy gate', x: 16.4, z: -5.2, w: 8.0, d: 4.8, h: 0.14 },
  { id: 'twin', n: '06', name: 'Shadow twin', sub: 'simulated fork', x: 16.4, z: 5.2, w: 6.4, d: 4.8, h: 0.14 },
];
export const ROOM = Object.fromEntries(ROOMS.map((r) => [r.id, r])) as Record<RoomId, RoomDef>;

/** GPU floor: rack x offsets (relative to the room) and the two rows facing a cold aisle. */
export const RACK_X = [-1.8, -0.6, 0.6, 1.8];
export const ROWS = [{ id: 'A', z: -1.3, crah: 'CRAH-1' }, { id: 'B', z: 1.3, crah: 'CRAH-2' }];

/** Which serving workers stand on the GPU floor: a block id, its label, and its rack slot. */
export interface Worker { id: string; label: string; row: 0 | 1; slot: number }
export type Fleet = Worker[];

/** The scripted stories: 8 replicas, two rows of four. */
export const FLEET_SCRIPTED: Fleet = Array.from({ length: 8 }, (_, k) => ({ id: `vllm-${k}`, label: `vllm-${k}`, row: (k < 4 ? 0 : 1) as 0 | 1, slot: k % 4 }));

/** The real Brev fleet: two vLLM workers behind HAProxy on one H100, one per row, facing each other. */
export const FLEET_REAL: Fleet = [
  { id: 'target-a', label: 'target-a', row: 0, slot: 1.5 },
  { id: 'target-b', label: 'target-b', row: 1, slot: 1.5 },
];

/** x offset of a rack slot; fractional slots sit between the four positions. */
export const slotX = (slot: number) => -1.8 + slot * 1.2;

export interface Pose { pos: V3; target: V3 }

const near = (id: RoomId, dx: number, h: number, dz: number, ty = 0.9): Pose => {
  const r = ROOM[id];
  return { pos: [r.x + dx, h, r.z + dz], target: [r.x + dx * 0.12, ty, r.z] };
};

export const CAMS: Record<string, Pose> = {
  // The landing's opening view: across the whole floor from the front right, close enough to read the rooms.
  landing: { pos: [9, 15, 24], target: [-2.5, 0.5, -0.5] },
  wide: { pos: [-1.5, 29, 33], target: [-1.5, 0, 0.5] },
  // Looks a little past the floor's centre so the overview sits above the flow map.
  finale: { pos: [-1.2, 40, 30], target: [-1.2, 0, 8.5] },
  callers: near('callers', 2.6, 4.4, 8.6, 0.8),
  door: near('door', 2.8, 4.2, 8.2, 1.0),
  gpu: { pos: [ROOM.gpu.x - 8.6, 6.2, 4.4], target: [ROOM.gpu.x + 0.4, 0.9, 0] },
  'gpu-aisle': { pos: [ROOM.gpu.x - 6.4, 2.6, 1.6], target: [ROOM.gpu.x + 1, 1.3, 0] },
  'gpu-under': { pos: [ROOM.gpu.x - 8.8, 3.8, 7.6], target: [ROOM.gpu.x - 1.4, 0.6, -0.5] },
  signals: { pos: [ROOM.signals.x + 0.9, 3.1, 6.2], target: [ROOM.signals.x + 0.5, 1.5, -1.0] },
  'signals-wide': { pos: [ROOM.signals.x - 1.5, 9.5, 13], target: [ROOM.signals.x - 5, 0.8, 0] },
  doctors: near('doctors', 1.8, 5.2, 9.8, 0.9),
  gate: { pos: [ROOM.doctors.x - 3.6, 3.0, ROOM.doctors.z + 6.6], target: [ROOM.doctors.x - 0.1, 1.1, ROOM.doctors.z + 1.55] },
  twin: near('twin', 1.8, 5.4, 8.8, 0.6),
};

/** Quiet floor tones under each part of the system. Never a state color: those mean something happened. */
export const ZONES = [
  { id: 'demand', label: 'DEMAND', color: 0x18212c, x: [-23.6, -9.4], z: [-4.2, 4.2] },
  { id: 'serving', label: 'SERVING', color: 0x1a1f23, x: [-7.9, 1.9], z: [-3.7, 3.7] },
  { id: 'signals', label: 'SIGNALS', color: 0x0f282b, x: [2.9, 10.3], z: [-3.6, 3.6] },
  { id: 'nexus', label: 'NEXUS', color: 0x1b1c35, x: [11.4, 21.4], z: [-8.7, 8.7] },
] as const;

/** Floor paths between rooms, in the order an incident travels. y is just above the floor. */
export const PATHS: Record<string, V3[]> = {
  'callers-door': [[-17.3, 0.03, 0], [-14.7, 0.03, 0]],
  'door-gpu': [[-10.3, 0.03, 0], [-7.0, 0.03, 0]],
  'gpu-signals': [[1.0, 0.03, 0], [3.8, 0.03, 0]],
  'signals-doctors': [[9.4, 0.03, 0], [11.4, 0.03, -1.6], [12.3, 0.03, -4.2]],
  'doctors-twin': [[16.4, 0.03, -2.7], [16.4, 0.03, 2.7]],
  fix: [[12.3, 0.03, -6.2], [6.6, 0.03, -7.2], [0.4, 0.03, -6.0], [-2.2, 0.03, -2.6]],
};
