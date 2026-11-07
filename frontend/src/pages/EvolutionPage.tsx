import { useState } from 'react';
import { WeightEvolutionChart } from '../charts/WeightEvolutionChart';
import { Card, EnvBadge, ErrorBox, List, Loading, SyntheticNotice, fmtDate } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api, type DataEnvironment, type ModelVersionItem } from '../services/api';

const STATUS: Record<string, string> = { ACTIVE: 'text-emerald-300', EXPERIMENTAL: 'text-amber-300', RETIRED: 'text-slate-500' };

function VersionCard({ v }: { v: ModelVersionItem }) {
  const changed = v.weights.filter((w) => w.previousWeight !== null && Math.abs(w.weight - w.previousWeight) > 1e-4);
  return (
    <li className="rounded-lg border border-slate-800 p-4">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-lg font-bold">{v.version}</span>
        <span className={`text-xs font-semibold ${STATUS[v.status] ?? ''}`}>{v.status}</span>
        {v.dataEnvironment ? <EnvBadge env={v.dataEnvironment} /> : <span className="text-xs text-slate-500">baseline (not learned from data)</span>}
        {v.parent && <span className="text-xs text-slate-500">from {v.parent}</span>}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Created {fmtDate(v.createdAt)} · {v.matchesEvaluated} matches evaluated
        {v.trainingWindow && ` · trained on outcomes ${fmtDate(v.trainingWindow.start, false)} → ${v.trainingWindow.end ? fmtDate(v.trainingWindow.end, false) : '—'}`}
      </p>
      {v.notes && <p className="mt-2 text-sm text-slate-300">{v.notes}</p>}
      <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">What changed?</h3>
      {changed.length === 0 ? (
        <p className="text-sm text-slate-500">{v.parent ? 'No weight changed beyond renormalisation.' : 'Initial weights.'}</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {changed.map((w) => (
            <li key={w.feature}><span className="font-medium">{w.feature}</span> {w.previousWeight!.toFixed(3)} → {w.weight.toFixed(3)}{w.reason && <span className="block text-xs text-slate-400">{w.reason}</span>}</li>
          ))}
        </ul>
      )}
      <details className="mt-2 text-xs text-slate-400">
        <summary className="cursor-pointer">All weights</summary>
        <p className="mt-1 font-mono">{v.weights.map((w) => `${w.feature} ${w.weight.toFixed(3)}`).join(' · ')}</p>
      </details>
    </li>
  );
}

export function EvolutionPage() {
  const [env, setEnv] = useState<DataEnvironment>('HISTORICAL');
  const models = useApi(() => api.models(), []);
  const events = useApi(() => api.learningEvents(env), [env]);
  const sims = useApi(() => api.simulations(), []);

  const lineage = models.data?.items.filter((v) => v.dataEnvironment === null || v.dataEnvironment === env) ?? [];
  const latestSim = sims.data?.items.find((s) => s.dataEnvironment === env && s.status === 'COMPLETED');
  const summary = latestSim?.summary as { promoted?: Array<{ version: string; reason: string }>; rejected?: Array<{ version: string; reason: string }>; matchesProcessed?: number; finalModel?: string; evidenceNote?: string } | null | undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Model evolution</h1>
        <label className="flex items-center gap-2 text-sm">
          Data
          <select className="rounded bg-slate-800 px-2 py-1" value={env} onChange={(e) => setEnv(e.target.value as DataEnvironment)}>
            <option value="HISTORICAL">HISTORICAL</option>
            <option value="LIVE">LIVE</option>
            <option value="SYNTHETIC">SYNTHETIC</option>
          </select>
        </label>
      </div>
      {env === 'SYNTHETIC' && <SyntheticNotice />}

      {summary && (
        <Card title="Latest learning simulation" subtitle={latestSim && fmtDate(latestSim.startedAt)}>
          <p className="text-sm text-slate-300">{summary.evidenceNote}</p>
          <p className="mt-2 text-sm">{summary.matchesProcessed} matches replayed chronologically · final model <span className="font-mono">{summary.finalModel}</span></p>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div><h3 className="text-xs font-semibold uppercase text-slate-400">Promoted</h3><List items={(summary.promoted ?? []).map((p) => `${p.version}: ${p.reason}`)} empty="No change passed validation." /></div>
            <div><h3 className="text-xs font-semibold uppercase text-slate-400">Rejected</h3><List items={(summary.rejected ?? []).map((p) => `${p.version}: ${p.reason}`)} empty="None." /></div>
          </div>
        </Card>
      )}

      <Card title="Feature weights by version">
        {models.loading ? <Loading /> : models.error ? <ErrorBox message={models.error} /> : <WeightEvolutionChart versions={lineage} />}
      </Card>

      <Card title="Version lineage" subtitle="Oldest first. Versions are never edited; a change always creates a new version.">
        {models.loading ? <Loading /> : <ol className="space-y-3">{lineage.map((v) => <VersionCard key={v.version} v={v} />)}</ol>}
      </Card>

      <Card title="Learning history">
        {events.loading ? <Loading /> : events.error ? <ErrorBox message={events.error} /> : events.data!.items.length === 0 ? <p className="text-sm text-slate-400">No learning events for {env}.</p> : (
          <ul className="space-y-2 text-sm">
            {events.data!.items.slice(0, 60).map((e) => (
              <li key={e.id} className="border-l-2 border-slate-700 pl-3">
                <p className="text-xs text-slate-500">{fmtDate(e.createdAt)} · {e.type.replaceAll('_', ' ')}{e.fromVersion ? ` · ${e.fromVersion}` : ''}{e.toVersion ? ` → ${e.toVersion}` : ''}{e.feature ? ` · ${e.feature} ${e.previousWeight?.toFixed(3)} → ${e.proposedWeight?.toFixed(3)}` : ''}</p>
                <p className="text-slate-300">{e.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
