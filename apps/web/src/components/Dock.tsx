import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { DOMAINS } from '../domains';
import { api } from '../lib/api';
import { toast } from '../lib/bus';
import { fleet, useFleet } from '../lib/fleet';
import { fromFleet, utc } from '../lib/flow';
import { clock } from '../lib/format';
import { store, useStore } from '../lib/store';
import { fleetStatus, systemStatus, TONE_BG, TONE_TEXT, type SystemStatus } from '../lib/status';
import { OmegaMark, Wordmark } from './Logo';

const ease = [0.16, 1, 0.3, 1] as const;

/** The floating dock: identity, what is true right now, time, and the one big trigger. */
export function Dock({ onBreak, breakDisabled, onReset }: { onBreak: (origin: { x: number; y: number }) => void; breakDisabled: string | null; onReset: () => void }) {
  return (
    <motion.header
      initial={{ y: -40, opacity: 0, filter: 'blur(8px)' }}
      animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration: 1.1, delay: 0.25, ease }}
      className="glass pointer-events-auto absolute left-1/2 top-4 z-40 flex h-[58px] w-max max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 rounded-full pl-4 pr-1.5"
      aria-label="NEXUS controls"
    >
      <a href="/" className="mr-2 flex items-center gap-2.5 rounded-full" aria-label="NEXUS home">
        <OmegaMark size={30} />
        <Wordmark className="hidden md:inline" />
      </a>
      <Sep />
      <Status />
      <Sep className="hidden lg:block" />
      <ModeChip />
      <Sep className="hidden sm:block" />
      <Clock />
      <Menu onReset={onReset} />
      <BreakTrigger onClick={onBreak} disabled={breakDisabled} />
    </motion.header>
  );
}

const Sep = ({ className = '' }: { className?: string }) => <span className={`mx-2 h-6 w-px shrink-0 bg-line ${className}`} />;

function useStatus(): SystemStatus {
  const connected = useStore((s) => s.connected);
  const frame = useStore((s) => s.frame);
  const run = useStore((s) => s.doctor);
  const rec = useFleet((s) => s.detail);
  const cursor = useFleet((s) => (s.detail ? Math.floor(s.cursor / 250) : 0));
  if (rec) return fleetStatus(fromFleet(rec, cursor * 250));
  return systemStatus(connected, frame, run);
}

function Status() {
  const st = useStatus();
  return (
    <div className="flex min-w-0 items-center gap-2.5 pr-1" role="status" aria-live="polite">
      <span className="relative flex size-2.5 shrink-0">
        {st.pulse && <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${TONE_BG[st.tone]}`} />}
        <span className={`relative size-2.5 rounded-full ${TONE_BG[st.tone]}`} />
      </span>
      <div className="hidden min-w-0 flex-col leading-tight sm:flex">
        <span className="label !text-[8.5px]">System</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={st.label}
            initial={{ opacity: 0, y: 5, filter: 'blur(3px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -5, filter: 'blur(3px)' }}
            transition={{ duration: 0.3 }}
            className={`max-w-[180px] truncate text-[13px] font-medium ${TONE_TEXT[st.tone]}`}
          >
            {st.label}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Exactly one data mode is ever shown, with what it means. */
function ModeChip() {
  const mode = useStore((s) => s.mode);
  const connected = useStore((s) => s.connected);
  const calib = useStore((s) => s.topo?.calibration.source);
  const fleetRec = useFleet((s) => s.detail?.summary ?? null);
  const replay = !!fleetRec || mode === 'replay';
  const label = !connected ? 'Offline' : replay ? 'Replay' : mode === 'live' ? 'Live' : 'Simulated';
  const tip = fleetRec
    ? `Replay of a run recorded on the real fleet (${fleetRec.environment ?? 'Brev'}) on ${fleetRec.started_at.slice(0, 10)} at ${utc(fleetRec.started_at)} UTC. Nothing here is live.`
    : replay ? 'Replay of an incident recorded in this browser from the simulated twin.'
    : mode === 'live' ? 'Production telemetry.'
    : `Streaming from the SimPy digital twin${calib ? ` (${calib})` : ''}. Live production telemetry is not connected to this view.`;
  const color = replay ? 'text-replay border-replay/35 bg-replay/[0.08]' : mode === 'live' ? 'text-ok border-ok/35 bg-ok/[0.08]' : 'text-info border-info/30 bg-info/[0.07]';
  return (
    <span title={tip} className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] lg:flex ${connected ? color : 'border-line text-ink-4'}`}>
      <span className={`size-1.5 rounded-full ${replay ? 'bg-replay' : mode === 'live' ? 'bg-ok' : 'bg-info'} ${connected ? '' : 'opacity-30'}`} />
      {label}
      {fleetRec && <span className="normal-case tracking-normal text-replay/70">· real fleet</span>}
    </span>
  );
}

/** Simulation time, or replay time. Never claims to control live time. */
function Clock() {
  const t = useStore((s) => s.frame?.t ?? 0);
  const paused = useStore((s) => s.frame?.paused ?? false);
  const simSpeed = useStore((s) => s.frame?.speed ?? 1);
  const replay = useStore((s) => s.replay);
  const fleetOn = useFleet((s) => !!s.detail);
  const fleetPlaying = useFleet((s) => s.playing);
  const fleetSpeed = useFleet((s) => s.speed);
  const fleetSec = useFleet((s) => Math.floor(s.cursor / 1000));
  const fast = useFleet((s) => s.fast);

  const live = useStore((s) => s.mode === 'live');
  const kind = fleetOn ? 'fleet' : replay ? 'replay' : 'sim';
  const playing = kind === 'fleet' ? fleetPlaying : kind === 'replay' ? replay!.playing : !paused;
  const speed = kind === 'fleet' ? fleetSpeed : kind === 'replay' ? replay!.speed : simSpeed;
  const speeds = [1, 4, 10];
  const time = kind === 'fleet' ? `${utc(fleetSec * 1000)}` : clock(t);
  const toggle = () => {
    if (kind === 'fleet') fleet.setPlaying(!fleetPlaying);
    else if (kind === 'replay') store.setReplay({ playing: !replay!.playing });
    else api.control({ paused: !paused });
  };
  const setSpeed = (s: number) => {
    if (kind === 'fleet') fleet.setSpeed(s);
    else if (kind === 'replay') store.setReplay({ speed: s, playing: true });
    else api.control({ speed: s, paused: false });
  };
  const label = kind === 'fleet' ? 'Recorded · UTC' : kind === 'replay' ? 'Replay time' : live ? 'Live · wall clock' : 'Simulation';
  return (
    <div className="flex items-center gap-0.5">
      <div className="mr-1 hidden flex-col leading-tight sm:flex">
        <span className={`label !text-[8.5px] ${kind !== 'sim' ? '!text-replay' : ''}`}>{label}{fast && kind === 'fleet' ? ` · ×${12 * speed}` : ''}</span>
        <span className="tnum font-mono text-[13px] text-ink">{time}</span>
      </div>
      {!(live && kind === 'sim') && <>
      <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} title={kind === 'sim' ? 'Pause or resume the simulation' : 'Pause or resume the replay'} className="grid size-9 place-items-center rounded-full text-ink-2 transition hover:bg-white/[0.06] hover:text-ink">
        {playing ? (
          <svg viewBox="0 0 24 24" className="size-3.5 fill-current"><rect x="6.5" y="5" width="3.6" height="14" rx="1" /><rect x="13.9" y="5" width="3.6" height="14" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" className="size-3.5 fill-current"><path d="M7.5 4.8v14.4L19.5 12z" /></svg>
        )}
      </button>
      <div className="hidden items-center rounded-full bg-black/25 p-0.5 md:flex" role="group" aria-label={kind === 'sim' ? 'Simulation speed' : 'Replay speed'}>
        {speeds.map((s) => (
          <button key={s} onClick={() => setSpeed(s)} aria-pressed={speed === s} className={`relative h-7 w-9 rounded-full font-mono text-[10.5px] transition ${speed === s ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
            {speed === s && <motion.span layoutId="speed-pill" className="absolute inset-0 rounded-full bg-white/[0.09]" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
            <span className="relative">{s}×</span>
          </button>
        ))}
      </div>
      </>}
    </div>
  );
}

function Menu({ onReset }: { onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const autopilot = useStore((s) => s.autopilot);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setConfirmReset(false); return; }
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  const reset = () => {
    if (!confirmReset) return setConfirmReset(true);
    setOpen(false);
    onReset();
  };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open} className="ml-1 grid size-10 place-items-center rounded-full text-ink-2 transition hover:bg-white/[0.06] hover:text-ink">
        <svg viewBox="0 0 24 24" className="size-4 fill-current"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.22, ease }}
            className="glass-strong absolute right-0 top-[52px] w-80 origin-top-right rounded-3xl p-2 text-[13px]"
            role="menu"
          >
            <button
              role="menuitemcheckbox" aria-checked={autopilot}
              onClick={() => api.doctorConfig({ autopilot: !autopilot }).then(() => toast(autopilot ? 'Autopilot off: repairs wait for your authorization' : 'Autopilot on: repairs within policy run without asking')).catch((e) => toast(e.message, 'bad'))}
              className="flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-2.5 text-left hover:bg-white/5"
            >
              <span><span className="block text-ink">Autopilot</span><span className="text-[11.5px] text-ink-3">Act within policy without asking</span></span>
              <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${autopilot ? 'bg-accent' : 'bg-white/10'}`}>
                <motion.span layout className={`absolute top-0.5 size-4 rounded-full bg-white ${autopilot ? 'right-0.5' : 'left-0.5'}`} />
              </span>
            </button>
            <div className="mx-3 my-1.5 h-px bg-line" />
            <div className="px-3 pb-1 pt-1.5">
              <span className="label !text-[9px]">Domains</span>
              <ul className="mt-2 space-y-1.5">
                {DOMAINS.map((d) => (
                  <li key={d.id} className="flex items-center justify-between text-[12.5px]">
                    <span className={d.status === 'operational' ? 'text-ink' : 'text-ink-4'}>{d.name}</span>
                    <span className={`rounded-full border px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.12em] ${d.status === 'operational' ? 'border-ok/30 text-ok' : 'border-line-2 text-ink-4'}`}>{d.status === 'operational' ? 'operational' : 'future · unavailable'}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="mx-3 my-1.5 h-px bg-line" />
            <button role="menuitem" onClick={reset} className={`flex w-full flex-col rounded-2xl px-3 py-2.5 text-left hover:bg-white/5 ${confirmReset ? 'text-bad' : 'text-ink-2 hover:text-ink'}`}>
              <span>{confirmReset ? 'Click again to reset the twin' : 'Reset twin to a healthy fleet'}</span>
              <span className="text-[11.5px] text-ink-4">Clears every fault and run in the simulated twin</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BreakTrigger({ onClick, disabled }: { onClick: (origin: { x: number; y: number }) => void; disabled: string | null }) {
  return (
    <motion.button
      onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onClick({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}
      disabled={!!disabled}
      title={disabled ?? 'Choose a failure to inject (B)'}
      whileHover={disabled ? undefined : { scale: 1.025 }}
      whileTap={disabled ? undefined : { scale: 0.965 }}
      aria-label="Break the system"
      className="break-trigger group ml-1.5 flex h-[42px] items-center gap-2 overflow-hidden rounded-full bg-[radial-gradient(120%_140%_at_50%_0%,rgba(244,63,94,0.24),rgba(60,8,18,0.5))] pl-3.5 pr-4 text-[10.5px] font-semibold uppercase tracking-[0.2em] text-[#ffe1e6] shadow-[0_0_26px_-12px_rgba(244,63,94,0.85),inset_0_1px_0_rgba(255,255,255,0.1)] transition-[filter,opacity] hover:brightness-125 disabled:opacity-45 disabled:hover:brightness-100"
    >
      <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-1000 group-hover:translate-x-full" />
      <svg viewBox="0 0 24 24" className="relative size-4 fill-[#ff6b81] drop-shadow-[0_0_7px_rgba(244,63,94,1)]"><path d="M13.4 2 4.6 13.5h6.2L9.8 22l8.8-11.6h-6.1z" /></svg>
      <span className="relative">Break</span>
    </motion.button>
  );
}

// ------------------------------------------------------------------ replay strip

/** Under the dock while replaying: source, position and the way back. */
export function ReplayStrip({ right }: { right: number }) {
  const replay = useStore((s) => s.replay);
  const fleetRec = useFleet((s) => s.detail?.summary ?? null);
  const start = useFleet((s) => s.start);
  const end = useFleet((s) => s.end);
  const cursor = useFleet((s) => s.cursor);
  const fast = useFleet((s) => s.fast);
  const compress = useFleet((s) => s.compress);
  const show = !!replay || !!fleetRec;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 10, opacity: 0 }}
          transition={{ duration: 0.5, ease }}
          style={{ right }}
          className="pointer-events-none absolute bottom-4 left-3 z-30 flex justify-center"
        >
          <div className="glass pointer-events-auto flex w-[min(620px,100%)] items-center gap-3 rounded-full py-1.5 pl-3 pr-1.5">
          <span className="rounded-full bg-replay/15 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-replay">Replay</span>
          <span className="hidden max-w-[190px] truncate text-[11.5px] text-ink-2 sm:block">
            {fleetRec ? `${fleetRec.title} · real fleet · ${fleetRec.started_at.slice(0, 10)}` : replay?.recording.label}
          </span>
          {fleetRec ? (
            <input
              type="range" min={start} max={end} value={cursor} step={100}
              onChange={(e) => fleet.seek(Number(e.target.value))}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-[#a78bfa]" aria-label="Replay position"
            />
          ) : replay ? (
            <input
              type="range" min={0} max={replay.recording.frames.length - 1} value={replay.index}
              onChange={(e) => store.setReplay({ index: Number(e.target.value), playing: false })}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-[#a78bfa]" aria-label="Replay position"
            />
          ) : null}
          {fleetRec && (
            <button onClick={() => fleet.setCompress(!compress)} title="Skip long silent gaps (e.g. the executor restarting a worker) faster than real time" className={`hidden rounded-full px-2 py-1 font-mono text-[10px] transition md:block ${compress ? (fast ? 'bg-replay/20 text-replay' : 'text-replay/80 hover:bg-white/5') : 'text-ink-4 hover:bg-white/5'}`}>
              {compress ? (fast ? '⏩ skipping gap' : 'skip gaps') : 'real time'}
            </button>
          )}
          <button
            onClick={() => (fleetRec ? fleet.exit() : store.exitReplay())}
            className="rounded-full px-3 py-1 text-[11.5px] text-ink-2 transition hover:bg-white/[0.06] hover:text-ink"
          >
            {fleetRec ? 'Close replay' : 'Back to simulation'}
          </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
