// Domain modules. The platform loop (detect → diagnose → select tools → shadow
// test → act → verify) and the certificate are shared; a domain supplies
// its twin scene, how its failures are grouped, and which doctor answers each.
// Only the AI datacenter is implemented. Others are listed as concepts so the
// UI never presents them as operational.
import type { FaultSpec, Topology } from '../lib/types';
import { TwinScene } from '../twin/scene';

export interface DomainModule {
  id: string;
  name: string;
  status: 'operational' | 'concept';
  /** Creates the domain's digital twin view inside a container. */
  createScene?: (container: HTMLElement, topo: Topology) => TwinScene;
  /** Which doctor answers a failure of this kind. */
  doctorFor?: (fault: FaultSpec) => 'tool' | 'infra';
  /** Order of failure groups in Break the system. */
  categories?: { match: string; label: string }[];
}

export const datacenter: DomainModule = {
  id: 'datacenter',
  name: 'AI datacenter',
  status: 'operational',
  createScene: (el, topo) => new TwinScene(el, topo),
  doctorFor: (f) => (f.kind === 'tool_parser' ? 'tool' : 'infra'),
  categories: [
    { match: 'Inference & Tool-Calling Failures', label: 'Tool calling' },
    { match: 'Compute & Worker Failures', label: 'Compute' },
    { match: 'Performance & Workload Failures', label: 'Workload' },
    { match: 'Network & Communication Failures', label: 'Network' },
    { match: 'GPU & Hardware Failures', label: 'GPU & hardware' },
    { match: 'Power Cooling & Thermal Failures', label: 'Power & cooling' },
    { match: 'Cascading & Compound Failures', label: 'Cascading' },
  ],
};

export const DOMAINS: DomainModule[] = [
  datacenter,
  { id: 'healthcare', name: 'Healthcare', status: 'concept' },
  { id: 'agriculture', name: 'Agriculture', status: 'concept' },
  { id: 'education', name: 'Education', status: 'concept' },
  { id: 'logistics', name: 'Logistics', status: 'concept' },
];
