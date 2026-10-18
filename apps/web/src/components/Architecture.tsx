import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { FlowRun } from '../lib/flow';

const ease = [0.16, 1, 0.3, 1] as const;

type NodeId = 'incident' | 'controller' | 'runtime' | 'tooldoc' | 'infradoc' | 'shadow' | 'tools' | 'verify' | 'cert';
interface N { id: NodeId; x: number; y: number; title: string; sub: string; tech?: string[] }

const W = 1120, H = 440;
const NODES: N[] = [
  { id: 'incident', x: 70, y: 220, title: 'Incident', sub: 'signal, not a ticket' },
  { id: 'controller', x: 240, y: 220, title: 'Nemotron controller', sub: 'one model', tech: ['NVIDIA Nemotron', 'vLLM'] },
  { id: 'runtime', x: 410, y: 220, title: 'Tool runtime', sub: 'policy · budgets · evidence', tech: ['FastAPI'] },
  { id: 'tooldoc', x: 580, y: 120, title: 'Tool-Calling Doctor', sub: 'parsers · templates · args' },
  { id: 'infradoc', x: 580, y: 320, title: 'Infrastructure Doctor', sub: 'GPUs · workers · network' },
  { id: 'shadow', x: 750, y: 120, title: 'Shadow twin', sub: 'predicts, never measures', tech: ['SimPy'] },
  { id: 'tools', x: 750, y: 320, title: 'Recovery tools', sub: 'drain · patch · rollback', tech: ['NVIDIA Brev'] },
  { id: 'verify', x: 905, y: 220, title: 'Independent verification', sub: 'the model never grades itself' },
  { id: 'cert', x: 1050, y: 220, title: 'Recovery certificate', sub: 'whatever the outcome' },
];
const EDGES: [NodeId, NodeId][] = [
  ['incident', 'controller'], ['controller', 'runtime'], ['runtime', 'tooldoc'], ['runtime', 'infradoc'],
  ['tooldoc', 'shadow'], ['tooldoc', 'tools'], ['infradoc', 'shadow'], ['infradoc', 'tools'],
  ['shadow', 'verify'], ['tools', 'verify'], ['verify', 'cert'],
];
const at = (id: NodeId) => NODES.find((n) => n.id === id)!;
function curve(a: NodeId, b: NodeId) {
  const p = at(a), q = at(b);
  const x1 = p.x + 62, x2 = q.x - 62, mx = (x1 + x2) / 2;
  return `M${x1} ${p.y} C ${mx} ${p.y}, ${mx} ${q.y}, ${x2} ${q.y}`;
}

/** Which parts of the architecture this run actually used. */
function usedBy(flow: FlowRun | null): { nodes: Set<NodeId>; note: Partial<Record<NodeId, string>> } | null {
  if (!flow) return null;
  const has = (k: string) => flow.stages.some((s) => s.key === k);
  const acted = flow.stages.find((s) => s.key === 'act')?.items.some((i) => i.kind === 'action') ?? false;
  const nodes = new Set<NodeId>(['incident', 'runtime', flow.doctor === 'tool' ? 'tooldoc' : 'infradoc']);
  if (flow.controllerReal) nodes.add('controller');
  if (has('shadow')) nodes.add('shadow');
  if (acted) nodes.add('tools');
  if (has('verify')) nodes.add('verify');
  if (flow.terminal) nodes.add('cert');
  const note: Partial<Record<NodeId, string>> = {};
  if (!flow.controllerReal) note.controller = 'not connected to the twin: a rule-based stand-in drove this run';
  else note.controller = `${flow.controller} chose every tool call`;
  if (flow.source === 'fleet') { note.shadow = 'not used on the real fleet'; note.tools = 'executor on the Brev fleet'; note.verify = 'referee, independent of the agent'; }
  return { nodes, note };
}

export function Architecture({ open, flow, onClose }: { open: boolean; flow: FlowRun | null; onClose: () => void }) {
  const reduce = useReducedMotion();
  const used = usedBy(flow);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  const lit = (id: NodeId) => !used || used.nodes.has(id);
  const edgeLit = (a: NodeId, b: NodeId) => (used ? used.nodes.has(a) && used.nodes.has(b) : true) || (!!used && a === 'incident' && b === 'controller') || (!!used && a === 'controller' && b === 'runtime');
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="absolute inset-0 z-[60] flex items-center justify-center p-3 md:p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.3 } }}>
          <motion.div className="absolute inset-0 bg-black/60 backdrop-blur-[8px]" onClick={onClose} />
          <motion.section
            role="dialog" aria-modal aria-label="Architecture"
            className="glass-strong relative w-full max-w-[1180px] overflow-hidden rounded-[32px] px-6 pb-6 pt-7 md:px-9"
            initial={{ y: 30, scale: 0.97, opacity: 0, filter: 'blur(10px)' }}
            animate={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.75, ease }}
          >
            <button autoFocus onClick={onClose} aria-label="Close" className="absolute right-4 top-4 z-10 grid size-10 place-items-center rounded-full text-ink-3 transition hover:bg-white/5 hover:text-ink">
              <svg viewBox="0 0 24 24" className="size-4 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
            <span className="label">Architecture{flow ? ` · as used by ${flow.source === 'fleet' ? 'this recorded run' : 'this simulated run'}` : ''}</span>
            <h2 className="display mt-2 text-[24px] font-medium leading-tight md:text-[28px]">One controller. Two tool collections. Independent proof.</h2>
            <p className="mt-2 max-w-[760px] text-[13.5px] leading-relaxed text-ink-2">
              The Tool-Calling Doctor and the Infrastructure Doctor are collections of tools driven by the same controller, not separate agents. Nothing reaches the fleet without policy, a precheck and a rollback path, and success is decided by checks the controller cannot influence.
            </p>
            <div className="mt-4 overflow-x-auto">
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[860px]">
                <defs>
                  <filter id="arch-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5" /></filter>
                  <radialGradient id="core-g"><stop offset="0" stopColor="#76b900" stopOpacity="0.35" /><stop offset="1" stopColor="#76b900" stopOpacity="0" /></radialGradient>
                </defs>
                <circle cx={at('controller').x} cy={at('controller').y} r="120" fill="url(#core-g)" opacity={lit('controller') ? 1 : 0.35} />
                {EDGES.map(([a, b], i) => {
                  const on = edgeLit(a, b);
                  const d = curve(a, b);
                  return (
                    <g key={`${a}-${b}`}>
                      <motion.path d={d} fill="none" stroke={on ? '#76b900' : 'rgba(255,255,255,0.1)'} strokeOpacity={on ? 0.65 : 1} strokeWidth={on ? 1.5 : 1} strokeDasharray={on ? undefined : '3 6'}
                        initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: 0.7, delay: 0.3 + i * 0.07, ease: 'easeInOut' }} />
                      {on && !reduce && (
                        <circle r="2.6" fill="#c6f36b" filter="url(#arch-glow)">
                          <animateMotion dur={`${2.2 + (i % 3) * 0.3}s`} begin={`${1.2 + i * 0.18}s`} repeatCount="indefinite" path={d} />
                        </circle>
                      )}
                    </g>
                  );
                })}
                {NODES.map((n, i) => {
                  const on = lit(n.id);
                  const note = used?.note[n.id];
                  const core = n.id === 'controller';
                  return (
                    <motion.g key={n.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.15 + i * 0.08, ease }}>
                      <rect x={n.x - 62} y={n.y - (core ? 34 : 28)} width={124} height={core ? 68 : 56} rx={core ? 22 : 18}
                        fill={on ? 'rgba(118,185,0,0.07)' : 'rgba(255,255,255,0.015)'} stroke={on ? 'rgba(118,185,0,0.55)' : 'rgba(255,255,255,0.12)'} strokeDasharray={on ? undefined : '4 4'} />
                      <foreignObject x={n.x - 62} y={n.y - (core ? 34 : 28)} width={124} height={core ? 68 : 56}>
                        <div className={`flex h-full flex-col items-center justify-center px-2 text-center ${on ? '' : 'opacity-50'}`}>
                          <span className={`text-[11.5px] font-medium leading-tight ${on ? 'text-ink' : 'text-ink-2'}`}>{n.title}</span>
                          <span className="mt-0.5 font-mono text-[8.5px] leading-tight text-ink-3">{n.sub}</span>
                        </div>
                      </foreignObject>
                      {(n.tech || note) && (
                        <foreignObject x={n.x - 80} y={n.y + (core ? 40 : 34)} width={160} height={64}>
                          <div className="flex flex-col items-center gap-1">
                            {n.tech && (
                              <div className="flex flex-wrap justify-center gap-1">
                                {n.tech.map((t) => <span key={t} className="rounded-full border border-accent/25 bg-accent/[0.06] px-1.5 py-px font-mono text-[8.5px] text-accent/90">{t}</span>)}
                              </div>
                            )}
                            {note && <span className="text-center text-[9.5px] leading-tight text-ink-3">{note}</span>}
                          </div>
                        </foreignObject>
                      )}
                    </motion.g>
                  );
                })}
              </svg>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-4 font-mono text-[10px]">
              <span className="label !text-[9px] mr-1">Integrated</span>
              {['NVIDIA Nemotron 3.5 Lightning · real-fleet agent runs', 'NVIDIA Brev · the fleet', 'vLLM v0.27.1 · workers and agent', 'FastAPI · twin server and environment API', 'SimPy · digital and shadow twin', 'React / TypeScript · this interface'].map((t) => (
                <span key={t} className="rounded-full border border-line-2 px-2.5 py-1 text-ink-2">{t}</span>
              ))}
              <span className="rounded-full border border-dashed border-line-2 px-2.5 py-1 text-ink-4" title="Planned; not integrated in this build">NVIDIA NeMo Gym · planned</span>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
