import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { fleetView, useFleet, type FleetWorker } from '../lib/fleet';
import { modelName, utc } from '../lib/flow';
import type { RecordingDetail } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

const POS: Record<string, { x: number; y: number }> = { 'target-a': { x: 440, y: 118 }, 'target-b': { x: 440, y: 298 } };
const HAP = { x: 170, y: 208 };
const AGENT = { x: 250, y: 46 };
const REF = { x: 610, y: 208 };

const wire = (to: { x: number; y: number }) => `M${HAP.x + 52} ${HAP.y} C ${HAP.x + 140} ${HAP.y}, ${to.x - 180} ${to.y}, ${to.x - 104} ${to.y}`;

/**
 * The real fleet as recorded: HAProxy in front of two vLLM workers, the Nemotron
 * agent beside them. Every state shown comes from the recording at the replay
 * cursor: probe results, configurations, the executor window and the referee.
 */
export function FleetStage() {
  const rec = useFleet((s) => s.detail);
  const cursor = useFleet((s) => s.cursor);
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {rec && (
        <motion.div
          key={rec.summary.id}
          initial={{ opacity: 0, scale: 0.94, filter: 'blur(10px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.96, filter: 'blur(8px)', transition: { duration: 0.5 } }}
          transition={{ duration: 1.1, ease, delay: 0.2 }}
          className="pointer-events-none absolute bottom-6 left-6 right-[460px] top-[140px] z-10 hidden flex-col items-center justify-center md:flex"
        >
          <Diorama rec={rec} cursor={cursor} reduce={!!reduce} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Diorama({ rec, cursor, reduce }: { rec: RecordingDetail; cursor: number; reduce: boolean }) {
  const s = rec.summary;
  const v = fleetView(rec, cursor);
  const focusPos = v.focus && POS[v.focus] ? POS[v.focus] : null;
  const investigating = v.phase === 'investigate' || v.phase === 'plan';
  const recentFocus = cursor - v.focusAt < 2200;
  const caption = captionFor(v, s.terminal_state, s.target, s.success);
  const refOk = !!s.success;
  return (
    <div className="w-full max-w-[720px]">
      <div className="mb-3 flex flex-wrap items-center gap-2 px-2">
        <span className="rounded-full border border-replay/35 bg-replay/[0.08] px-2.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-replay">Real fleet · recorded</span>
        <span className="font-mono text-[10.5px] text-ink-3">{s.environment ?? 'brev'} · 1× H100 · {s.started_at.slice(0, 10)} {utc(s.started_at)} UTC</span>
      </div>
      <div className="glass rounded-[30px] px-3 pb-3 pt-2">
        <svg viewBox="0 0 680 380" className="w-full">
          <defs>
            <filter id="fs-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" /></filter>
            <linearGradient id="fs-floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#76b900" stopOpacity="0.06" /><stop offset="1" stopColor="#76b900" stopOpacity="0" /></linearGradient>
          </defs>
          {/* floor grid */}
          {Array.from({ length: 9 }).map((_, i) => <line key={`h${i}`} x1="20" x2="660" y1={40 + i * 40} y2={40 + i * 40} stroke="rgba(118,185,0,0.05)" />)}
          {Array.from({ length: 17 }).map((_, i) => <line key={`v${i}`} y1="30" y2="360" x1={20 + i * 40} x2={20 + i * 40} stroke="rgba(118,185,0,0.035)" />)}

          {/* alarm rings beneath a faulty worker */}
          {v.workers.filter((w) => w.state === 'faulty').map((w) => (
            <g key={`ring-${w.id}`}>
              {[0, 1, 2].map((k) => (
                <ellipse key={k} cx={POS[w.id].x} cy={POS[w.id].y + 46} rx="56" ry="12" fill="none" stroke="#f43f5e" strokeWidth="1.3"
                  style={reduce ? { opacity: 0.5 } : { transformOrigin: `${POS[w.id].x}px ${POS[w.id].y + 46}px`, animation: `ring-out 2.6s cubic-bezier(.2,.6,.3,1) ${k * 0.86}s infinite` }} />
              ))}
            </g>
          ))}

          {/* users → HAProxy → workers */}
          <path d={`M60 ${HAP.y} L${HAP.x - 52} ${HAP.y}`} stroke="rgba(200,211,220,0.25)" strokeWidth="1.2" />
          {v.workers.map((w) => {
            const d = wire(POS[w.id]);
            const drained = w.state === 'repairing';
            const reply = w.canary === 'bad' ? '#f5a524' : '#8ed61a';
            return (
              <g key={`wire-${w.id}`}>
                <path d={d} fill="none" stroke={drained ? 'rgba(56,189,248,0.25)' : w.canary === 'bad' ? 'rgba(245,165,36,0.45)' : 'rgba(118,185,0,0.4)'} strokeWidth="1.3" strokeDasharray={drained ? '3 5' : undefined} />
                {!reduce && !drained && [0, 1, 2].map((k) => (
                  <g key={k}>
                    <circle r="2.4" fill="#38bdf8" filter="url(#fs-glow)"><animateMotion dur="1.9s" begin={`${k * 0.63}s`} repeatCount="indefinite" path={d} /></circle>
                    <circle r={w.canary === 'bad' ? 3.2 : 2.4} fill={reply} filter="url(#fs-glow)"><animateMotion dur="1.9s" begin={`${k * 0.63 + 0.3}s`} repeatCount="indefinite" path={d} keyPoints="1;0" keyTimes="0;1" calcMode="linear" /></circle>
                  </g>
                ))}
              </g>
            );
          })}
          {!reduce && [0, 1, 2].map((k) => <circle key={k} r="2" fill="#c8d3dc" opacity="0.7"><animateMotion dur="1.2s" begin={`${k * 0.4}s`} repeatCount="indefinite" path={`M60 ${HAP.y} L${HAP.x - 52} ${HAP.y}`} /></circle>)}

          {/* users */}
          <g transform={`translate(38 ${HAP.y})`}>
            <circle r="14" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.12)" />
            <circle cy="-3" r="3.4" fill="none" stroke="#a7b2b9" strokeWidth="1.3" /><path d="M-6 7a6 6 0 0 1 12 0" fill="none" stroke="#a7b2b9" strokeWidth="1.3" />
            <text y="30" textAnchor="middle" fontSize="9" fill="#6e7b83" fontFamily="JetBrains Mono">users</text>
          </g>

          {/* HAProxy */}
          <g>
            <rect x={HAP.x - 52} y={HAP.y - 22} width="104" height="44" rx="16" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.14)" />
            <text x={HAP.x} y={HAP.y - 2} textAnchor="middle" fontSize="12" fill="#eaf0f2" fontFamily="Instrument Sans Variable, sans-serif" fontWeight="500">HAProxy</text>
            <text x={HAP.x} y={HAP.y + 12} textAnchor="middle" fontSize="8.5" fill="#6e7b83" fontFamily="JetBrains Mono">fleet entry</text>
          </g>

          {/* the agent and what it is looking at */}
          <g>
            <rect x={AGENT.x - 92} y={AGENT.y - 22} width="184" height="44" rx="16" fill={investigating ? 'rgba(118,185,0,0.1)' : 'rgba(255,255,255,0.03)'} stroke={investigating ? 'rgba(118,185,0,0.6)' : 'rgba(255,255,255,0.14)'} />
            {investigating && !reduce && <rect x={AGENT.x - 92} y={AGENT.y - 22} width="184" height="44" rx="16" fill="none" stroke="#76b900" strokeOpacity="0.5" style={{ animation: 'breathe 1.6s ease-in-out infinite', transformOrigin: `${AGENT.x}px ${AGENT.y}px` }} />}
            <text x={AGENT.x} y={AGENT.y - 2} textAnchor="middle" fontSize="12" fill="#eaf0f2" fontFamily="Instrument Sans Variable, sans-serif" fontWeight="500">{modelName(s.controller)}</text>
            <text x={AGENT.x} y={AGENT.y + 12} textAnchor="middle" fontSize="8.5" fill="#76b900" fontFamily="JetBrains Mono">agent · declared tools only</text>
          </g>
          <AnimatePresence>
            {investigating && recentFocus && (
              <motion.path
                key={v.focus ?? 'env'}
                d={focusPos ? `M${AGENT.x + 40} ${AGENT.y + 22} Q ${focusPos.x - 60} ${AGENT.y + 30}, ${focusPos.x - 30} ${focusPos.y - 44}` : `M${AGENT.x} ${AGENT.y + 22} L${AGENT.x} ${AGENT.y + 60}`}
                fill="none" stroke="#a3e635" strokeWidth="1.4" strokeDasharray="4 4"
                initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 0.9 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease }}
              />
            )}
          </AnimatePresence>

          {/* workers */}
          {v.workers.map((w) => <Worker key={w.id} w={w} focused={investigating && recentFocus && v.focus === w.id} repair={v.repair?.target === w.id ? v.repair : null} route={v.route[w.id]} reduce={reduce} />)}

          {/* referee */}
          <g opacity={v.referee ? 1 : 0.35}>
            <path d={`M${REF.x} ${REF.y - 22} l17 6v12c0 10-7.5 17-17 21c-9.5-4-17-11-17-21v-12z`} fill={v.referee ? (refOk ? 'rgba(118,185,0,0.15)' : 'rgba(244,63,94,0.12)') : 'rgba(255,255,255,0.03)'} stroke={v.referee ? (refOk ? '#76b900' : '#f43f5e') : 'rgba(255,255,255,0.2)'} />
            {v.referee && (refOk ? <path d={`M${REF.x - 6} ${REF.y + 1} l4 4 l8 -8`} fill="none" stroke="#a3e635" strokeWidth="1.8" strokeLinecap="round" /> : <path d={`M${REF.x - 5} ${REF.y - 4} l10 10 M${REF.x + 5} ${REF.y - 4} l-10 10`} fill="none" stroke="#f43f5e" strokeWidth="1.8" strokeLinecap="round" />)}
            <text x={REF.x} y={REF.y + 40} textAnchor="middle" fontSize="9" fill="#a7b2b9" fontFamily="JetBrains Mono">referee</text>
          </g>
        </svg>
        <AnimatePresence mode="wait">
          <motion.p key={caption} initial={{ opacity: 0, y: 6, filter: 'blur(3px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.4 }} className="px-3 pb-1 text-center text-[13px] text-ink-2">
            {caption}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Worker({ w, focused, repair, route, reduce }: { w: FleetWorker; focused: boolean; repair: { progress: number; seconds: number } | null; route?: { p95: number; err: number }; reduce: boolean }) {
  const p = POS[w.id];
  const color = w.state === 'faulty' ? '#f43f5e' : w.state === 'repairing' ? '#38bdf8' : w.state === 'repaired' ? '#76b900' : '#76b900';
  const canary = w.canary === 'ok' ? { t: 'tool calls ✓', c: '#8ed61a' } : w.canary === 'bad' ? { t: 'HTTP 200 · tool_calls: []', c: '#f5a524' } : { t: 'canary –', c: '#6e7b83' };
  const cfg = w.profile ? w.profile : w.parser ? `parser ${w.parser} · ${w.template ?? '–'}` : null;
  const R = 2 * Math.PI * 30;
  return (
    <g>
      {focused && <rect x={p.x - 112} y={p.y - 50} width="224" height="100" rx="26" fill="none" stroke="#a3e635" strokeOpacity="0.6" style={reduce ? undefined : { animation: 'breathe 1.2s ease-in-out infinite', transformOrigin: `${p.x}px ${p.y}px` }} />}
      <rect x={p.x - 104} y={p.y - 42} width="208" height="84" rx="22" fill={`${color}12`} stroke={`${color}${w.state === 'serving' ? '55' : '99'}`} />
      <text x={p.x - 88} y={p.y - 20} fontSize="12.5" fill="#eaf0f2" fontFamily="Instrument Sans Variable, sans-serif" fontWeight="600">{w.id}</text>
      {route && <text x={p.x + 88} y={p.y - 20} textAnchor="end" fontSize="9" fill="#a7b2b9" fontFamily="JetBrains Mono">p95 {Math.round(route.p95 * 1000)} ms</text>}
      <text x={p.x - 88} y={p.y - 5} fontSize="8.5" fill="#6e7b83" fontFamily="JetBrains Mono">Qwen2.5-Coder-7B · vLLM</text>
      <text x={p.x - 88} y={p.y + 12} fontSize="9.5" fill={canary.c} fontFamily="JetBrains Mono">{canary.t}</text>
      {cfg && <text x={p.x - 88} y={p.y + 28} fontSize="8.5" fill={w.profile ? '#a3e635' : '#6e7b83'} fontFamily="JetBrains Mono">{cfg.length > 40 ? `${cfg.slice(0, 39)}…` : cfg}</text>}
      {repair && repair.progress < 1 && (
        <g transform={`translate(${p.x + 140} ${p.y})`}>
          <circle r="30" fill="rgba(56,189,248,0.06)" stroke="rgba(56,189,248,0.2)" strokeWidth="2" />
          <circle r="30" fill="none" stroke="#38bdf8" strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${R * repair.progress} ${R}`} transform="rotate(-90)" />
          <text y="-2" textAnchor="middle" fontSize="10" fill="#d9f3ff" fontFamily="JetBrains Mono">{Math.round(repair.progress * repair.seconds)}s</text>
          <text y="10" textAnchor="middle" fontSize="7.5" fill="#38bdf8" fontFamily="JetBrains Mono">executor</text>
        </g>
      )}
    </g>
  );
}

function captionFor(v: ReturnType<typeof fleetView>, terminal: string | null, target: string | null, success: boolean | null): string {
  switch (v.phase) {
    case 'detect': return v.workers.some((w) => w.canary === 'bad') ? `Silent failure: HTTP 200 and health checks pass, but ${v.workers.find((w) => w.canary === 'bad')?.id ?? target} returns no structured tool calls.` : 'Monitoring snapshot: route probe and visible tool-call canaries.';
    case 'investigate': return v.focus && v.focus !== '@env' ? `Nemotron is reading ${v.focus} through the environment API.` : v.focus === '@env' ? 'Nemotron is reading the environment manifest: what exists and what it may do.' : 'Nemotron is weighing the monitoring snapshot.';
    case 'plan': return 'Plan checked against policy; before-state and a rollback token captured.';
    case 'repair': return `Executor on ${v.repair?.target ?? 'the worker'}: drain → apply the reviewed profile → hidden canary → undrain.`;
    case 'verify': return 'The referee probes users through HAProxy and runs the hidden canary.';
    case 'failed': return 'The agent run failed before any change. Nothing was touched.';
    case 'done': return success ? 'Referee: users served, hidden canary passed, root cause fixed.' : terminal === 'VERIFIED' ? 'The executor said VERIFIED, but the referee did not confirm it.' : 'The referee did not confirm a repair.';
    default: return '';
  }
}
