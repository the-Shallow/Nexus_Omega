// Small shared channels: the live scene instance and transient notices.
import { useSyncExternalStore } from 'react';
import type { TwinScene } from '../twin/scene';

let scene: TwinScene | null = null;
const sceneSubs = new Set<(s: TwinScene | null) => void>();
export const twin = {
  get: () => scene,
  set: (s: TwinScene | null) => { scene = s; sceneSubs.forEach((cb) => cb(s)); },
  /** Calls back now and whenever the scene is created or disposed. */
  subscribe(cb: (s: TwinScene | null) => void) { sceneSubs.add(cb); cb(scene); return () => { sceneSubs.delete(cb); }; },
};

export interface Toast { id: number; text: string; tone: 'info' | 'bad' | 'ok' }
let toasts: Toast[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export function toast(text: string, tone: Toast['tone'] = 'info', ttl = 3600) {
  const id = nextId++;
  toasts = [...toasts, { id, text, tone }].slice(-3);
  emit();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emit(); }, ttl);
}

export function useToasts() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => toasts);
}
