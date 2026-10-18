import type { Candidate, CertRecord } from '../blocks/nexus';
import type { RoomId } from '../world/layout';
import type { PathKind, World } from '../world/world';

/** Block states by id, e.g. { "vllm-0": "silent" }. */
export type Snapshot = Record<string, string>;

/** Something that happens part way through a hop. `set` also counts when jumping past the hop. */
export interface Beat { at: number; set?: Snapshot; cam?: string; focus?: RoomId; fx?: (w: World) => void }

/** What the corner bar says about dashboards versus reality (silent story only). */
export interface Reality { dash: string; real: string; tone: 'ok' | 'lie' | 'caught'; head?: string; labels?: [string, string] }

export interface Hop {
  id: string;
  room: RoomId | null;
  cam: string;
  /** Short tile title. */
  title: string;
  /** The plain-language sentence, for everyone. */
  plain: string;
  /** One mono line of technical detail. */
  tech: string;
  /** Extra lines shown in Engineer mode. */
  engineer?: string[];
  /** Seconds at 1×. */
  dur: number;
  /** Twin clock, shown in the top bar. */
  clock: string;
  set?: Snapshot;
  beats?: Beat[];
  paths?: Record<string, PathKind>;
  reality?: Reality;
  /** Pause here until the viewer acts. */
  wait?: { label: string; set: Snapshot };
  finale?: 'verified' | 'human' | CertRecord;
}

export interface Story {
  id: string;
  name: string;
  short: string;
  /** 'scripted' plays on 8 illustrative replicas; 'real' replays a recorded run on the real 2 workers. */
  mode: 'scripted' | 'real';
  /** Top-bar badge, e.g. "RECORDED RUN · run-96915174". */
  badge: string;
  /** Room subtitles that differ from the defaults (the real fleet is not 8 replicas). */
  subs?: Partial<Record<RoomId, string>>;
  base: Snapshot;
  candidates: Candidate[];
  hops: Hop[];
  summary: { outcome: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; rows: [string, string][]; note: string; label?: string };
}

export const BASE: Snapshot = {
  'agent-0': 'ok', 'agent-1': 'ok', 'agent-2': 'ok', 'agent-3': 'ok',
  'human-0': 'ok', 'human-1': 'ok', 'human-2': 'ok',
  gateway: 'ok', floor: 'ok', dash: 'ok', canary: 'probe',
  ...Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`vllm-${k}`, 'ok'])),
  mgr: 'idle', 'doc-tool': 'idle', 'doc-infra': 'idle', gate: 'idle', twin: 'idle',
};

/** Block states at the start of hop i: base, then every earlier hop's sets, beats and waits. */
export function snapshotAt(story: Story, i: number): { blocks: Snapshot; paths: Record<string, PathKind> } {
  const blocks: Snapshot = { ...story.base };
  const paths: Record<string, PathKind> = {};
  for (let j = 0; j < i; j++) {
    const h = story.hops[j];
    Object.assign(blocks, h.set);
    for (const b of h.beats ?? []) Object.assign(blocks, b.set);
    if (h.wait) Object.assign(blocks, h.wait.set);
    Object.assign(paths, h.paths);
  }
  return { blocks, paths };
}
