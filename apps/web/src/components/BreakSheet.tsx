import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { datacenter } from '../domains';
import { api } from '../lib/api';
import { toast, twin } from '../lib/bus';
import { fleet } from '../lib/fleet';
import { fleetVerdict, utc } from '../lib/flow';
import { store } from '../lib/store';
import type { FaultSpec, RecordingSummary } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

const HUE: Record<string, string> = {
  'Tool calling': '#f5a524', Compute: '#fb923c', Workload: '#a78bfa', Network: '#38bdf8', 'GPU & hardware': '#e879f9', 'Power & cooling': '#f43f5e', Cascading: '#fb7185',
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
  return ids[0] === 'gateway' ? 'gateway' : ids[0];
}

interface FleetGroup { fault: string; title: string; runs: RecordingSummary[]; featured: RecordingSummary; remedy: RecordingSummary['remedy'] }
const FAULT_ORDER = ['vllm-32926', 'tools-stripped-a', 'kill-b', 'net-latency-b', 'net-blackhole-b', 'capacity-b'];

/** One row per recorded fault; the featured run is the latest the referee scored a success, else the latest. */
function groupRecordings(recs: RecordingSummary[]): FleetGroup[] {
  const by = new Map<string, RecordingSummary[]>();
  for (const r of recs) by.set(r.fault ?? r.title, [...(by.get(r.fault ?? r.title) ?? []), r]);
  const rank = (f: string) => (FAULT_ORDER.indexOf(f) === -1 ? 99 : FAULT_ORDER.indexOf(f));
  return [...by.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([fault, list]) => {
    const runs = [...list].sort((a, b) => a.started_at.localeCompare(b.started_at));
    const latest = [...runs].reverse();
    return { fault, title: runs[0].title, runs, featured: latest.find((r) => r.success) ?? latest[0], remedy: runs[0].remedy };
  });
}

const fleetDoctor = (fault: string) => (/vllm|tool/i.test(fault) ? 'tool' : 'infra');
const fleetCategory = (fault: string) => (/vllm|tool/i.test(fault) ? 'Tool calling' : /^net/.test(fault) ? 'Network' : /kill|capacity/.test(fault) ? 'Compute' : 'Cascading');

type Row =
  | { key: string; doctor: 'tool' | 'infra'; type: 'twin'; f: FaultSpec; category: string }
  | { key: string; doctor: 'tool' | 'infra'; type: 'fleet'; g: FleetGroup; category: string }
  | { key: string; doctor: 'tool' | 'infra'; type: 'planned'; title: string; summary: string; category: string };

/**
 * Break the system: a holographic sheet that grows out of the trigger. Simulated
 * failures are injected into the twin through the real fault API; recorded fleet
 * runs replay. Scenarios that do not exist yet are listed, and cannot be chosen.
 */
export function BreakSheet({ open, origin, onClose, onInjected, onReplay }: {
  open: boolean; origin: { x: number; y: number } | null; onClose: () => void; onInjected: (f: FaultSpec) => void; onReplay: () => void;
}) {
  const [faults, setFaults] = useState<FaultSpec[]>([]);
  const [recs, setRecs] = useState<RecordingSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { api.faults().then(setFaults).catch((e) => toast(`Could not load failures: ${e.message}`, 'bad')); }, []);
  useEffect(() => { if (open) api.recordings().then(setRecs).catch(() => setRecs([])); }, [open]);
  useEffect(() => { if (!open) twin.get()?.setPreview(null); }, [open]);

  const rows = useMemo(() => {
    const cats = datacenter.categories ?? [];
    const label = (f: FaultSpec) => cats.find((c) => c.match === f.category)?.label ?? f.category;
    const order = (f: FaultSpec) => cats.findIndex((c) => c.match === f.category);
    const out: Row[] = [];
    const twinRows = [...faults].sort((a, b) => order(a) - order(b)).map((f): Row => ({ key: `t:${f.kind}`, doctor: datacenter.doctorFor?.(f) ?? 'infra', type: 'twin', f, category: label(f) }));
    const fleetRows = groupRecordings(recs ?? []).map((g): Row => ({ key: `f:${g.fault}`, doctor: fleetDoctor(g.fault), type: 'fleet', g, category: fleetCategory(g.fault) }));
    const planned = (datacenter.planned ?? []).map((p): Row => ({ key: `p:${p.title}`, doctor: p.doctor, type: 'planned', title: p.title, summary: p.summary, category: p.category }));
    for (const d of ['tool', 'infra'] as const) out.push(...twinRows.filter((r) => r.doctor === d), ...fleetRows.filter((r) => r.doctor === d), ...planned.filter((r) => r.doctor === d));
    return out;
  }, [faults, recs]);
  const pickable = rows.filter((r) => r.type !== 'planned');

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
    } finally { setBusy(null); }
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
    } finally { setBusy(null); }
  };

  const pick = (r: Row | undefined) => { if (r?.type === 'twin') inject(r.f); else if (r?.type === 'fleet') replay(r.g.featured); };

  useEffect(() => {
    if (!open) return;
    setCursor(0);
    const t = setTimeout(() => list.current?.querySelector<HTMLElement>('[data-i="0"]')?.focus({ preventScroll: true }), 450);
    return () => clearTimeout(t);
  }, [open]);

  const move = (i: number) => {
    const n = (i + pickable.length) % Math.max(1, pickable.length);
    setCursor(n);
    const el = list.current?.querySelector<HTMLElement>(`[data-i="${n}"]`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
    const r = pickable[n];
    preview(r?.type === 'twin' ? r.f : null);
  };

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); move(cursor + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(cursor - 1); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= Math.min(9, pickable.length) && !e.metaKey && !e.ctrlKey) pick(pickable[n - 1]);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // The sheet grows out of whichever trigger opened it.
  const W = Math.min(500, window.innerWidth - 24), top = 84;
  const left = window.innerWidth - 12 - W;
  const ox = (origin?.x ?? window.innerWidth - 60) - left, oy = (origin?.y ?? 40) - top;
  const reach = Math.hypot(Math.max(Math.abs(ox), Math.abs(W - ox)), Math.max(Math.abs(oy), Math.abs(window.innerHeight - top - oy))) + 40;

  let pi = -1;
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="absolute inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.4, delay: 0.05 } }}>
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,6,12,0)_0%,rgba(3,6,12,0.25)_45%,rgba(3,6,12,0.7)_100%)]" onClick={onClose} aria-hidden />
          <motion.section
            role="dialog" aria-modal aria-label="Break the system"
            className="holo-sheet absolute bottom-3 flex flex-col overflow-hidden rounded-[30px]"
            style={{ left, top, width: W }}
            initial={{ clipPath: `circle(18px at ${ox}px ${oy}px)`, opacity: 0.4 }}
            animate={{ clipPath: `circle(${reach}px at ${ox}px ${oy}px)`, opacity: 1 }}
            exit={{ opacity: 0, x: 30, filter: 'blur(8px)', transition: { duration: 0.4, ease } }}
            transition={{ duration: 0.85, ease: [0.65, 0, 0.35, 1] }}
            onMouseLeave={() => preview(null)}
          >
            <div className="pointer-events-none absolute -right-24 -top-28 h-64 w-80 rounded-full bg-bad/20 blur-3xl" />
            <header className="relative flex items-start justify-between gap-4 px-6 pb-3 pt-5">
              <div>
                <span className="label !text-[9.5px] !text-[#ff8a9c]">Chaos</span>
                <h2 className="display mt-1.5 text-[22px] font-medium leading-tight">Break the system</h2>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">Pick a failure. The hall takes the hit; one controller has to notice, investigate and prove its repair.</p>
              </div>
              <button onClick={onClose} aria-label="Close" className="grid size-9 shrink-0 place-items-center rounded-full text-ink-3 transition hover:bg-white/5 hover:text-ink">
                <svg viewBox="0 0 24 24" className="size-4 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </header>

            <div ref={list} className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {rows.length === 0 && <p className="px-3 py-6 text-[13px] text-ink-3">Loading failures…</p>}
              {(['tool', 'infra'] as const).map((d) => {
                const group = rows.filter((r) => r.doctor === d);
                if (!group.length) return null;
                return (
                  <div key={d} className="mb-1">
                    <div className="flex items-center gap-2.5 px-3 pb-1 pt-3">
                      <span className="text-[11.5px] font-medium text-ink">{d === 'tool' ? 'Tool-Calling Doctor' : 'Infrastructure Doctor'}</span>
                      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-4">{d === 'tool' ? 'parser · template · arguments' : 'workers · GPU · network · facility'}</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                    {group.map((r) => {
                      const i = r.type === 'planned' ? -1 : ++pi;
                      return (
                        <ScenarioRow
                          key={r.key} row={r} index={i} active={cursor === i} busy={busy} expanded={expanded === r.key}
                          onPick={() => pick(r)}
                          onFocus={() => { if (i >= 0) setCursor(i); preview(r.type === 'twin' ? r.f : null); }}
                          onToggle={() => setExpanded((x) => (x === r.key ? null : r.key))}
                          onReplay={replay}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <footer className="relative border-t border-line px-6 py-2.5 font-mono text-[9.5px] leading-relaxed text-ink-4">
              <div className="flex justify-between"><span>↑ ↓ choose · Enter break · 1–9 quick pick</span><span>Esc close</span></div>
              <p className="mt-1 font-sans text-[10.5px] text-ink-4">Simulated failures go to the SimPy twin through its fault API. The real fleet's fault endpoint is not connected here, so nothing is live-injectable; recorded fleet runs replay.</p>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const LABEL_CLS = { SIMULATED: 'text-info border-info/30', 'REPLAY ONLY': 'text-replay border-replay/35', 'NOT IMPLEMENTED': 'text-ink-4 border-line-2' } as const;

function ScenarioRow({ row, index, active, busy, expanded, onPick, onFocus, onToggle, onReplay }: {
  row: Row; index: number; active: boolean; busy: string | null; expanded: boolean; onPick: () => void; onFocus: () => void; onToggle: () => void; onReplay: (r: RecordingSummary) => void;
}) {
  const hue = HUE[row.category] ?? '#38bdf8';
  const planned = row.type === 'planned';
  const title = row.type === 'twin' ? row.f.title : row.type === 'fleet' ? row.g.title : row.title;
  const summary = row.type === 'twin' ? row.f.summary : row.type === 'fleet' ? fleetLine(row.g) : row.summary;
  const label = row.type === 'twin' ? 'SIMULATED' : row.type === 'fleet' ? 'REPLAY ONLY' : 'NOT IMPLEMENTED';
  const right = row.type === 'twin' ? `→ ${targetText(row.f)}` : row.type === 'fleet' ? `${row.g.runs.length} run${row.g.runs.length > 1 ? 's' : ''}` : '';
  const isBusy = row.type === 'twin' ? busy === row.f.kind : row.type === 'fleet' ? row.g.runs.some((r) => r.id === busy) : false;
  return (
    <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + Math.max(0, index) * 0.03, duration: 0.5, ease }} className="relative">
      <button
        data-i={planned ? undefined : index}
        tabIndex={planned ? -1 : active ? 0 : -1}
        disabled={planned}
        onClick={onPick}
        onFocus={onFocus}
        onMouseEnter={onFocus}
        title={planned ? 'No twin fault or recorded run exists for this yet' : undefined}
        style={{ '--hue': hue } as CSSProperties}
        className="group relative flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-white/[0.045] focus-visible:bg-white/[0.05] focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--hue)_45%,transparent)] disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <span className="relative grid size-6 shrink-0 place-items-center">
          {!planned && <span className="absolute inset-0 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100" style={{ background: `radial-gradient(circle, ${hue}55, transparent 70%)` }} />}
          {row.type === 'fleet' ? (
            <svg viewBox="0 0 24 24" className="relative size-3 fill-replay"><path d="M8 5.5v13l10.5-6.5z" /></svg>
          ) : (
            <span className="size-[7px] rounded-full" style={{ background: planned ? 'transparent' : hue, boxShadow: planned ? `inset 0 0 0 1px ${hue}66` : `0 0 10px ${hue}` }} />
          )}
        </span>
        <span className={`min-w-0 flex-1 ${planned ? 'opacity-45' : ''}`}>
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-medium text-ink">{title}</span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em]" style={{ color: `${hue}cc` }}>{row.category}</span>
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] text-ink-3 transition-colors group-hover:text-ink-2">{summary}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className={`rounded-full border px-1.5 py-px font-mono text-[8.5px] uppercase tracking-[0.12em] ${LABEL_CLS[label]}`}>{label}</span>
          {right && <span className="font-mono text-[10px] text-ink-4 group-hover:text-ink-3">{isBusy ? 'working…' : right}</span>}
        </span>
        {!planned && index < 9 && <kbd className="hidden w-3 font-mono text-[10px] text-ink-4 sm:block">{index + 1}</kbd>}
        {isBusy && <motion.span layoutId="inject-bar" className="absolute inset-x-3 bottom-0 h-px" style={{ background: hue, boxShadow: `0 0 8px ${hue}` }} />}
      </button>
      {row.type === 'fleet' && row.g.runs.length > 1 && (
        <>
          <div className="-mt-1 flex items-center gap-1.5 pb-1 pl-12 pr-3">
            <button onClick={onToggle} aria-expanded={expanded} className="font-mono text-[9.5px] text-ink-4 transition hover:text-ink-2">{expanded ? '− hide runs' : '+ pick a run'}</button>
          </div>
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
                <div className="flex flex-wrap gap-1.5 pb-2 pl-12 pr-3">
                  {row.g.runs.map((r) => {
                    const v = fleetVerdict(r);
                    const cls = v.falseVerified ? 'border-bad/40 text-bad' : r.success ? 'border-ok/30 text-ok' : 'border-line-2 text-ink-3';
                    return (
                      <button key={r.id} onClick={() => onReplay(r)} title={v.headline} className={`rounded-full border px-2 py-0.5 font-mono text-[9.5px] transition hover:bg-white/5 ${cls} ${busy === r.id ? 'opacity-60' : ''}`}>
                        {utc(r.started_at).slice(0, 5)} · {v.label.toLowerCase()}
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </motion.div>
  );
}

function fleetLine(g: FleetGroup) {
  const ok = g.runs.filter((r) => r.success).length;
  const fv = g.runs.filter((r) => r.false_verified).length;
  return `Nemotron on the Brev fleet · ${ok}/${g.runs.length} confirmed by the referee${fv ? ` · ${fv} false VERIFIED` : ''}`;
}
