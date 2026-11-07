import type { ReactNode } from 'react';
import { DATA_UNAVAILABLE, type DataEnvironment, type Metric } from '../services/api';

export function Card({ title, subtitle, children, className = '' }: { title?: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-800 bg-slate-900/60 p-5 ${className}`} aria-label={title}>
      {title && <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">{title}</h2>}
      {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
      <div className={title ? 'mt-4' : ''}>{children}</div>
    </section>
  );
}

const ENV_STYLE: Record<DataEnvironment, string> = {
  SYNTHETIC: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  HISTORICAL: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  LIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
};

export function EnvBadge({ env }: { env: DataEnvironment }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${ENV_STYLE[env]}`} title={env === 'SYNTHETIC' ? 'Generated development data — not evidence of real-world performance' : undefined}>
      {env}
    </span>
  );
}

export function SyntheticNotice() {
  return (
    <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      Synthetic development data. It demonstrates the pipeline and is <strong>not</strong> evidence that Nexora performs well on real football.
    </p>
  );
}

export function Unavailable({ label = DATA_UNAVAILABLE }: { label?: string }) {
  return <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>;
}

export function MetricValue({ metric, digits = 2, suffix = '' }: { metric: Metric; digits?: number; suffix?: string }) {
  if (metric.value === DATA_UNAVAILABLE) return <Unavailable />;
  return (
    <span>
      {metric.value.toFixed(digits)}
      {suffix}
      <span className="ml-1 text-[10px] text-slate-500">n={metric.sampleSize}</span>
    </span>
  );
}

const OUTCOME: Record<string, string> = { W: 'bg-emerald-500 text-emerald-950', D: 'bg-slate-500 text-slate-950', L: 'bg-rose-500 text-rose-950' };

export function FormPills({ sequence }: { sequence: string[] }) {
  if (sequence.length === 0) return <Unavailable label="No known matches" />;
  return (
    <span className="inline-flex gap-1" aria-label={`Form, most recent first: ${sequence.join(' ')}`}>
      {sequence.map((o, i) => (
        <span key={i} className={`grid h-6 w-6 place-items-center rounded text-xs font-bold ${OUTCOME[o] ?? 'bg-slate-700'}`}>
          {o}
        </span>
      ))}
    </span>
  );
}

const RECOMMENDATION: Record<string, string> = {
  PICK: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  LEAN: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  NO_PICK: 'bg-slate-600/20 text-slate-400 border-slate-600/50',
};

export function RecommendationBadge({ value }: { value: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${RECOMMENDATION[value] ?? RECOMMENDATION.NO_PICK}`}>{value.replace('_', ' ')}</span>;
}

const LEVEL: Record<string, string> = { HIGH: 'text-emerald-300', MEDIUM: 'text-amber-300', LOW: 'text-rose-300' };

export function ConfidenceLabel({ level }: { level: string }) {
  return <span className={`font-semibold ${LEVEL[level] ?? 'text-slate-300'}`}>{level}</span>;
}

export function List({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm text-slate-300">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden="true" className="text-slate-600">•</span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export function Loading() {
  return (
    <p role="status" className="text-sm text-slate-400">
      Loading…
    </p>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
      {message}
    </p>
  );
}

export const fmtDate = (iso: string, withTime = true) =>
  new Date(iso).toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });

export const pct = (v: number) => `${Math.round(v * 100)}%`;
