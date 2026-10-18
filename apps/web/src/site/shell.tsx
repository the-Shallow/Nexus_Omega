// Shared frame for the product pages: navigation, chapter sections, footer, and the
// read-only data they show (everything comes from the results API, or says where it's from).
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { BfclProfile, EpisodeSummary, Scoreboard } from '../lib/types';

export const REFERENCE_RUN = 'run-96915174';
export const storyUrl = (q: string) => `story.html?${q}`;

export function Nav({ page }: { page: 'home' | 'results' }) {
  const links = page === 'home'
    ? [['#problem', 'Problem'], ['#how', 'How it works'], ['#evidence', 'Evidence'], ['#next', 'What’s next']]
    : [['about.html', 'About'], ['#scoreboard', 'Scoreboard'], ['#profiles', 'Tool calling'], ['#runs', 'Runs']];
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1180px] items-center gap-6 px-5">
        <a href="./" className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-[17px] font-bold text-bg">Ω</span>
          <span className="text-[15px] font-semibold tracking-tight">Nexus</span>
        </a>
        <nav className="hidden gap-1 md:flex" aria-label="Sections">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="rounded-lg px-3 py-1.5 text-[13.5px] text-ink-3 transition-colors hover:bg-white/[0.04] hover:text-ink">{label}</a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {page === 'home' && <a href="results.html" className="hidden rounded-xl px-3.5 py-2 text-[13.5px] text-ink-2 hover:text-ink sm:block">Results</a>}
          <a href="platform.html" className="hidden rounded-xl px-3.5 py-2 text-[13.5px] text-ink-2 hover:text-ink sm:block">Live twin</a>
          <a href={storyUrl(`run=${REFERENCE_RUN}`)} className="rounded-xl bg-accent px-4 py-2 text-[13.5px] font-semibold text-bg">Watch a real incident</a>
        </div>
      </div>
    </header>
  );
}

export function Chapter({ id, n, eyebrow, title, lede, children }: { id: string; n?: string; eyebrow: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="border-t border-line py-24">
      <div className="mx-auto max-w-[1180px] px-5">
        <div className="grid gap-x-10 gap-y-3 md:grid-cols-[180px_minmax(0,1fr)]">
          <div className="label pt-2">{n && <span className="mr-3 text-accent">{n}</span>}{eyebrow}</div>
          <div className="min-w-0">
            <h2 className="max-w-[24ch] text-[clamp(28px,3.4vw,42px)] font-semibold leading-[1.08] tracking-tight" style={{ textWrap: 'balance' }}>{title}</h2>
            {lede && <p className="mt-5 max-w-[64ch] text-[17px] leading-relaxed text-ink-2">{lede}</p>}
          </div>
        </div>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line py-12">
      <div className="mx-auto grid max-w-[1180px] gap-2 px-5 text-[13px] text-ink-3">
        <div className="flex items-center gap-2 text-ink-2"><span className="grid size-6 place-items-center rounded-md bg-accent text-[13px] font-bold text-bg">Ω</span>Nexus · self-healing for AI inference fleets</div>
        <p>Recorded runs come from a real 2-worker vLLM fleet on one H100 (Brev), diagnosed by NVIDIA Nemotron. Illustrative scenarios are labelled as such.</p>
        <p>Numbers on these pages are read from the results API: the scoreboard, tool-calling scores per serving profile, and each run’s recorded trail.</p>
      </div>
    </footer>
  );
}

/** Load once; `null` while loading, `undefined` if it failed (pages show a dash, never a made-up number). */
function useLoad<T>(load: () => Promise<T>): T | null | undefined {
  const [v, setV] = useState<T | null | undefined>(null);
  // Load once on mount.
  useEffect(() => { load().then(setV).catch(() => setV(undefined)); }, []);
  return v;
}
export const useScoreboard = () => useLoad<Scoreboard>(api.scoreboard);
export const useBfcl = () => useLoad<BfclProfile[]>(api.bfcl);
export const useEpisodes = () => useLoad<EpisodeSummary[]>(() => api.episodes({ solver: 'agent' }));

export const fmt = {
  sec: (x: number | null | undefined) => (x === null || x === undefined ? '–' : x < 100 ? `${x.toFixed(1)} s` : `${Math.round(x)} s`),
  score: (x: number | null | undefined) => (x === null || x === undefined ? '–' : x.toFixed(2)),
};
