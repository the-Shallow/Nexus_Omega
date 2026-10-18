import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { datacenter } from '../domains';
import { api } from '../lib/api';
import { toast, twin } from '../lib/bus';
import { fleet } from '../lib/fleet';
import { utc } from '../lib/flow';
import { store } from '../lib/store';
import type { FaultSpec, RecordingSummary } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

const HUE: Record<string, string> = {
  'Tool calling': '#f5a524',
  Compute: '#fb923c',
  Workload: '#a78bfa',
  Network: '#38bdf8',
  'GPU & hardware': '#e879f9',
  'Power & cooling': '#f43f5e',
  Cascading: '#fb7185',
};

const EPISODE: Record<string, { text: string; tip: string }> = {
  real: { text: 'real episode exists', tip: 'A controlled episode of this failure was reproduced on the live vLLM target. Here it is injected into the simulated twin.' },
  hybrid: { text: 'hybrid', tip: 'Partly reproduced on the live target; the rest is simulated telemetry.' },
  simulated: { text: '', tip: 'Simulated only; there is no live episode of this failure.' },
};

/** Ids the twin can outline for a failure before it is injected. */
export function previewIds(f: FaultSpec): string[] {
  if (f.default_target) return f.default_target.split(',').map((s) => s.trim()).filter(Boolean);
  if (f.kind === 'compound') return ['CRAH-1', 'gateway'];
  return ['gateway'];
}

function targetText(f: FaultSpec) {
  const ids = previewIds(f);
  if (ids.length > 1) return `${ids.length} replicas`;
  return ids[0] === 'gateway' ? 'edge gateway' : ids[0];
}

export function ChaosOverlay({ open, onClose, onInjected, onReplay }: { open: boolean; onClose: () => void; onInjected: (f: FaultSpec) => void; onReplay: () => void }) {
  const [faults, setFaults] = useState<FaultSpec[]>([]);
  const [recs, setRecs] = useState<RecordingSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { api.faults().then(setFaults).catch((e) => toast(`Could not load failures: ${e.message}`, 'bad')); }, []);
  useEffect(() => { if (open) api.recordings().then(setRecs).catch(() => setRecs([])); }, [open]);
  useEffect(() => { if (!open) twin.get()?.setPreview(null); }, [open]);

  const groups = useMemo(() => {
    const cats = datacenter.categories ?? [];
    return cats.map((c) => ({ label: c.label, items: faults.filter((f) => f.category === c.match) })).filter((g) => g.items.length);
  }, [faults]);
  const flat = groups.flatMap((g) => g.items.map((f) => ({ f, group: g.label })));
  const verified = (recs ?? []).filter((r) => r.terminal_state === 'VERIFIED');
  const featured = verified[0] ?? (recs ?? [])[0] ?? null;
  const total = flat.length + (featured ? 1 : 0);

  const preview = (f: FaultSpec | null) => twin.get()?.setPreview(f ? previewIds(f) : null, f ? `${f.title} → ${targetText(f)}` : undefined);

  const inject = async (f: FaultSpec) => {
    if (busy) return;
    setBusy(f.kind);
    try {
      if (fleet.get().detail) fleet.exit();
      if (store.get().replay) store.exitReplay();
      await api.inject(f.kind);
      preview(null);
      onClose();
      onInjected(f);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const replay = async (r: RecordingSummary) => {
    if (busy) return;
    setBusy(r.id);
    try {
      if (store.get().replay) store.exitReplay();
      preview(null);
      await fleet.start(r.id);
      onReplay();
      onClose();
    } catch (e) {
      toast(`Could not load the recording: ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const pick = (i: number) => {
    if (i < flat.length) inject(flat[i].f);
    else if (featured) replay(featured);
  };

  useEffect(() => {
    if (!open) return;
    setCursor(0);
    const t = setTimeout(() => list.current?.querySelector<HTMLElement>('[data-i="0"]')?.focus({ preventScroll: true }), 420);
    return () => clearTimeout(t);
  }, [open]);

  const move = (i: number) => {
    const n = (i + total) % Math.max(1, total);
    setCursor(n);
    const el = list.current?.querySelector<HTMLElement>(`[data-i="${n}"]`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
    preview(n < flat.length ? flat[n].f : null);
  };

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); move(cursor + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(cursor - 1); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= Math.min(9, flat.length) && !e.metaKey && !e.ctrlKey) pick(n - 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="absolute inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.35, delay: 0.1 } }}>
          <motion.div
            className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,4,5,0.05)_0%,rgba(3,4,5,0.35)_45%,rgba(3,4,5,0.82)_100%)]"
            onClick={onClose}
            aria-hidden
          />
          <motion.section
            role="dialog"
            aria-modal
            aria-label="Break the system"
            className="glass-strong absolute bottom-4 right-4 top-[88px] flex w-[min(560px,calc(100vw-24px))] flex-col overflow-hidden rounded-[30px]"
            initial={{ x: 60, opacity: 0, filter: 'blur(10px)' }}
            animate={{ x: 0, opacity: 1, filter: 'blur(0px)' }}
            exit={{ x: 50, opacity: 0, filter: 'blur(8px)', transition: { duration: 0.4, ease } }}
            transition={{ duration: 0.65, ease }}
            onMouseLeave={() => preview(null)}
          >
            <div className="pointer-events-none absolute -right-24 -top-32 h-72 w-96 rounded-full bg-bad/20 blur-3xl" />
            <header className="relative flex items-start justify-between gap-6 px-7 pb-5 pt-7">
              <div>
                <span className="label !text-bad/80">Chaos</span>
                <h2 className="display mt-2 text-[26px] font-medium leading-tight">Break the system</h2>
                <p className="mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-ink-2">Choose a failure. The twin takes the hit in place; the right doctor has to notice it, investigate, and prove its repair.</p>
              </div>
              <button onClick={onClose} aria-label="Close" className="grid size-10 shrink-0 place-items-center rounded-full text-ink-3 transition hover:bg-white/5 hover:text-ink">
                <svg viewBox="0 0 24 24" className="size-4 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </header>

            <div ref={list} className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <SectionTitle text="Digital twin" chip="simulated" chipClass="text-info border-info/30" />
              {groups.length === 0 && <p className="px-3 py-6 text-[13px] text-ink-3">Loading failures…</p>}
              {groups.map((g) => (
                <div key={g.label} className="mb-2">
                  <div className="px-3 pb-1 pt-3 font-mono text-[9.5px] uppercase tracking-[0.16em]" style={{ color: HUE[g.label] ?? '#6e7b83' }}>{g.label}</div>
                  {g.items.map((f) => {
                    const i = flat.findIndex((x) => x.f.kind === f.kind);
                    return (
                      <FaultRow
                        key={f.kind} f={f} index={i} hue={HUE[g.label] ?? '#38bdf8'} busy={busy === f.kind} active={cursor === i}
                        onPick={() => inject(f)} onFocus={() => { setCursor(i); preview(f); }} onHover={() => preview(f)}
                      />
                    );
                  })}
                </div>
              ))}

              {featured && (
                <>
                  <SectionTitle text="Real fleet" chip="recorded" chipClass="text-replay border-replay/35" />
                  <FleetCard
                    index={flat.length}
                    featured={featured}
                    recs={recs ?? []}
                    busy={busy}
                    active={cursor === flat.length}
                    onReplay={replay}
                    onFocus={() => { setCursor(flat.length); preview(null); }}
                  />
                </>
              )}
            </div>
            <footer className="relative flex items-center justify-between border-t border-line px-7 py-3 font-mono text-[10px] text-ink-4">
              <span>↑ ↓ choose · Enter break · 1–9 quick pick</span>
              <span>Esc close</span>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SectionTitle({ text, chip, chipClass }: { text: string; chip: string; chipClass: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 pb-1 pt-4">
      <span className="text-[12px] font-medium text-ink">{text}</span>
      <span className={`rounded-full border px-2 py-px font-mono text-[9px] uppercase tracking-[0.16em] ${chipClass}`}>{chip}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function FaultRow({ f, index, hue, busy, active, onPick, onFocus, onHover }: { f: FaultSpec; index: number; hue: string; busy: boolean; active: boolean; onPick: () => void; onFocus: () => void; onHover: () => void }) {
  const doctor = datacenter.doctorFor?.(f) === 'tool' ? 'Tool-Calling Doctor' : 'Infrastructure Doctor';
  const ep = EPISODE[f.live_episode ?? 'simulated'] ?? EPISODE.simulated;
  return (
    <motion.button
      data-i={index}
      tabIndex={active ? 0 : -1}
      onClick={onPick}
      onFocus={onFocus}
      onMouseEnter={onHover}
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.18 + index * 0.035, duration: 0.5, ease }}
      style={{ '--hue': hue } as CSSProperties}
      className="group relative flex w-full items-start gap-3.5 rounded-2xl px-3 py-3 text-left outline-none transition-colors hover:bg-white/[0.045] focus-visible:bg-white/[0.05] focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--hue)_45%,transparent)]"
    >
      <span className="relative mt-1 grid size-7 shrink-0 place-items-center">
        <span className="absolute inset-0 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100" style={{ background: `radial-gradient(circle, ${hue}55, transparent 70%)` }} />
        <span className="size-2 rounded-full" style={{ background: hue, boxShadow: `0 0 10px ${hue}` }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[14.5px] font-medium text-ink">{f.title}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-ink-3 transition-colors group-hover:text-ink-2">→ {targetText(f)}</span>
        </span>
        <span className="mt-0.5 line-clamp-1 block text-[12.5px] leading-relaxed text-ink-3 transition-colors group-hover:text-ink-2">{f.summary}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[9.5px] uppercase tracking-[0.12em]">
          <span className="text-info/80">simulated</span>
          {ep.text && <span className="text-ink-4" title={ep.tip}>· {ep.text}</span>}
          <span className="text-ink-4">· {doctor}</span>
        </span>
      </span>
      {index < 9 && <kbd className="mt-1 hidden font-mono text-[10px] text-ink-4 sm:block">{index + 1}</kbd>}
      {busy && <motion.span layoutId="inject-bar" className="absolute inset-x-3 bottom-0 h-px" style={{ background: hue, boxShadow: `0 0 8px ${hue}` }} />}
    </motion.button>
  );
}

function FleetCard({ index, featured, recs, busy, active, onReplay, onFocus }: { index: number; featured: RecordingSummary; recs: RecordingSummary[]; busy: string | null; active: boolean; onReplay: (r: RecordingSummary) => void; onFocus: () => void }) {
  const runs = [...recs].filter((r) => r.fault === featured.fault).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const ok = runs.filter((r) => r.success).length;
  const falseVerified = runs.filter((r) => r.false_verified).length;
  return (
    <motion.div
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.5, duration: 0.5, ease }}
      className="mx-1 mt-2 rounded-3xl border border-replay/20 bg-[linear-gradient(160deg,rgba(167,139,250,0.08),rgba(167,139,250,0.015))] p-4"
    >
      <button
        data-i={index}
        tabIndex={active ? 0 : -1}
        onFocus={onFocus}
        onClick={() => onReplay(featured)}
        className="group flex w-full items-start gap-3.5 rounded-2xl text-left outline-none"
      >
        <span className="relative mt-1 grid size-7 shrink-0 place-items-center">
          <span className="absolute inset-0 animate-[breathe_2.4s_ease-in-out_infinite] rounded-full bg-replay/20" />
          <svg viewBox="0 0 24 24" className="relative size-3.5 fill-replay"><path d="M8 5.5v13l10.5-6.5z" /></svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-medium text-ink">{featured.title} <span className="text-ink-3">· Nemotron on the live fleet</span></span>
          <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-3 group-hover:text-ink-2">
            Real tool calls, real evidence and a real repair on vLLM workers, as recorded. Plays back the run from {featured.started_at.slice(0, 10)} {utc(featured.started_at)} UTC.
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 font-mono text-[9.5px] uppercase tracking-[0.12em]">
            <span className="text-replay">recorded · replay only</span>
            <span className="text-ink-4">· {ok}/{runs.length} confirmed by the referee · {falseVerified} false VERIFIED</span>
          </span>
        </span>
        <span className="mt-1 rounded-full bg-replay/15 px-3 py-1.5 text-[11.5px] font-medium text-replay transition group-hover:bg-replay/25 group-focus-visible:bg-replay/25">
          {busy === featured.id ? 'Loading…' : 'Replay'}
        </span>
      </button>
      {runs.length > 1 && (
        <div className="mt-3.5 border-t border-replay/10 pt-3">
          <span className="label !text-[9px]">Every attempt, including failures</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => onReplay(r)}
                title={r.failure ?? r.summary ?? r.id}
                className={`rounded-full border px-2.5 py-1 font-mono text-[10px] transition hover:bg-white/5 ${r.terminal_state === 'VERIFIED' ? 'border-ok/30 text-ok' : 'border-line-2 text-ink-3'} ${busy === r.id ? 'opacity-60' : ''}`}
              >
                {utc(r.started_at).slice(0, 5)} · {r.terminal_state === 'VERIFIED' ? 'verified' : (r.terminal_state ?? 'no verdict').toLowerCase()}
              </button>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-ink-4">The fleet's fault endpoint is not connected to this UI, so these cannot be re-run from here. They replay exactly as recorded.</p>
        </div>
      )}
    </motion.div>
  );
}
