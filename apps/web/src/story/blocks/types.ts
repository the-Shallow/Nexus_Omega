import type * as THREE from 'three';
import { STATUS } from '../../twin/palette';

/** One reusable 3D object with named visual states (healthy, silent-wrong, broken, …). */
export interface Block {
  root: THREE.Group;
  state: string;
  set(state: string): void;
  tick(t: number, dt: number): void;
}

export interface StateDef { key: string; label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'sim' | 'idle'; note: string }

/** A block type as shown on the specimen page: what it stands for and how each state reads. */
export interface Family { id: string; name: string; stands: string; states: StateDef[]; make: () => Block; frame?: { y: number; dist: number } }

export const TONE: Record<StateDef['tone'], number> = {
  ok: STATUS.ok, warn: STATUS.warn, bad: STATUS.bad, info: STATUS.restart, sim: 0xa78bfa, idle: STATUS.off,
};
