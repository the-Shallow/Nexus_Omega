// Flat drawings of the system, in the same zone tones as the 3D floor.

/** The floor seen from above: six rooms on their zones, and one incident's route. */
export function FloorPlan() {
  return (
    <svg viewBox="0 0 960 520" role="img" aria-label="The system from above: callers and the front door, the GPU floor with two workers, signals, and Nexus with its doctors and shadow twin. An amber line traces the fault; a green line traces the fix coming back." className="block h-auto w-full">
      <defs>
        <radialGradient id="fp-pool" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#dfe8ee" stopOpacity=".14" /><stop offset=".6" stopColor="#dfe8ee" stopOpacity=".04" /><stop offset="1" stopColor="#dfe8ee" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="960" height="520" rx="20" fill="var(--ground)" />
      <rect x="24" y="140" width="250" height="240" rx="18" fill="var(--zone-demand)" />
      <rect x="292" y="130" width="260" height="260" rx="18" fill="var(--zone-serving)" />
      <rect x="570" y="140" width="140" height="240" rx="18" fill="var(--zone-signals)" />
      <rect x="728" y="30" width="208" height="460" rx="18" fill="var(--zone-nexus)" />
      <ellipse cx="422" cy="260" rx="200" ry="160" fill="url(#fp-pool)" />
      <g fill="none" stroke="var(--color-line-2, rgb(255 255 255 / .12))" strokeWidth="1.5">
        <rect x="40" y="190" width="100" height="140" rx="8" /><rect x="160" y="200" width="96" height="120" rx="8" />
        <rect x="316" y="170" width="212" height="180" rx="8" /><rect x="584" y="190" width="112" height="140" rx="8" />
        <rect x="746" y="60" width="172" height="150" rx="8" /><rect x="746" y="310" width="172" height="150" rx="8" strokeDasharray="4 4" />
      </g>
      <rect x="402" y="204" width="40" height="44" rx="3" fill="var(--color-raised, #0e1214)" stroke="var(--color-warn, #f59e0b)" strokeWidth="1.5" />
      <rect x="402" y="272" width="40" height="44" rx="3" fill="var(--color-raised, #0e1214)" stroke="var(--color-ink-4, #48535a)" />
      <g stroke="var(--color-warn, #f59e0b)" strokeWidth="2" fill="none"><path d="M140 260 H160 M256 260 H316" /><path d="M528 260 H584 M696 260 C730 260 730 135 746 135" /></g>
      <path d="M746 180 C640 180 560 140 470 170" stroke="var(--color-ok, #76b900)" strokeWidth="2" fill="none" />
      <circle cx="470" cy="170" r="4" fill="var(--color-ok, #76b900)" />
      <g fontFamily="Instrument Sans Variable, sans-serif" fontWeight="600" fontSize="15" fill="var(--color-ink, #e9eef1)">
        <text x="40" y="180">Callers</text><text x="160" y="190">Front door</text><text x="316" y="160">GPU floor</text>
        <text x="584" y="180">Signals</text><text x="746" y="50">Doctors</text><text x="746" y="300">Shadow twin</text>
      </g>
      <g fontFamily="JetBrains Mono, monospace" fontSize="11" fill="var(--color-ink-3, #6b7880)">
        <text x="40" y="348">agents · people</text><text x="160" y="338">HAProxy</text><text x="452" y="230">target-a</text><text x="452" y="298">target-b</text>
        <text x="584" y="348">canary</text><text x="746" y="228">policy gate</text><text x="746" y="478">simulated fixes</text>
      </g>
    </svg>
  );
}

const LOOP = [
  { k: 'Detect', t: 'A canary checks the work, not just the plumbing: a known tool call, every 5 seconds.' },
  { k: 'Investigate', t: 'A doctor agent gathers evidence one tool call at a time. Every claim cites a result.' },
  { k: 'Decide', t: 'It names a cause and proposes one declared action, with its expected effect.' },
  { k: 'Gate', t: 'Policy checks the action. Facility and hardware changes go to a person.' },
  { k: 'Act', t: 'An executor applies the change, reversibly, on one worker while the other serves.' },
  { k: 'Verify', t: 'An independent referee checks what users actually get. Its verdict is final.' },
];

/** The recovery loop, left to right. */
export function Loop() {
  return (
    <ol className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-6">
      {LOOP.map((s, i) => (
        <li key={s.k} className="flex flex-col gap-2 bg-bg p-5">
          <span className="font-mono text-[11px] text-accent">0{i + 1}</span>
          <span className="text-[17px] font-semibold tracking-tight">{s.k}</span>
          <span className="text-[13.5px] leading-snug text-ink-2">{s.t}</span>
        </li>
      ))}
    </ol>
  );
}
