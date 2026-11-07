import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading, RecommendationBadge, fmtDate, pct } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api, type BookkeeperReport, type DataEnvironment, type DebateRunRow } from '../services/api';

function BookkeeperPanel({ report }: { report: BookkeeperReport }) {
  return (
    <Card title="Bookkeeper" subtitle="Every settled pick, scored. Thin samples are labelled, not smoothed over.">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['Settled picks', String(report.settledPicks)],
          ['Hit rate', report.overall.accuracy === null ? '—' : pct(report.overall.accuracy)],
          ['Brier', report.overall.brier === null ? '—' : report.overall.brier.toFixed(3)],
          ['Log loss', report.overall.logLoss === null ? '—' : report.overall.logLoss.toFixed(3)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-[10px] uppercase tracking-widest text-slate-500">{label}</dt>
            <dd className="mt-1 font-mono text-lg">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-slate-400">{report.overall.note}</p>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-widest text-slate-400">Calibration by confidence</h3>
      <table className="mt-2 w-full text-sm">
        <thead className="text-xs text-slate-500">
          <tr><th scope="col" className="text-left">Bucket</th><th scope="col">n</th><th scope="col">Predicted</th><th scope="col">Observed</th><th scope="col" className="pl-2 text-left">Reading</th></tr>
        </thead>
        <tbody>
          {report.byConfidence.map((b) => (
            <tr key={b.bucket} className="border-t border-slate-800">
              <th scope="row" className="py-2 text-left font-normal">{b.bucket}</th>
              <td className="text-center font-mono">{b.n}</td>
              <td className="text-center font-mono">{b.predicted === null ? '—' : pct(b.predicted)}</td>
              <td className="text-center font-mono">{b.observed === null ? '—' : pct(b.observed)}</td>
              <td className={`py-2 pl-2 text-xs ${b.trustworthy ? 'text-slate-400' : 'text-amber-300'}`}>{b.note}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-widest text-slate-400">Return at flat stake</h3>
      <p className="mt-2 text-sm">
        {report.roi.roi === null ? <span className="text-slate-500">No settled pick carried a recorded price.</span> : <span className="font-mono">{(report.roi.roi * 100).toFixed(2)}% over {report.roi.priced} priced picks</span>}
      </p>
      <p className={`mt-1 text-xs ${report.roi.significant ? 'text-slate-400' : 'text-amber-300'}`}>{report.roi.note}</p>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-widest text-slate-400">Which agent has been right</h3>
      {report.agentAccuracy.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No claim has been scored yet.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {report.agentAccuracy.map((a) => (
            <li key={a.agent} className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold text-slate-200">{a.agent}</span>
              <span className="font-mono">{a.accuracy === null ? '—' : pct(a.accuracy)}</span>
              <span className={`text-xs ${a.trustworthy ? 'text-slate-400' : 'text-amber-300'}`}>{a.note}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RunsTable({ runs }: { runs: DebateRunRow[] }) {
  if (runs.length === 0) return <p className="text-sm text-slate-500">No debate has been run yet. Open a match and run one from its page.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-slate-500">
        <tr><th scope="col" className="text-left">Fixture</th><th scope="col" className="px-2">Kickoff</th><th scope="col" className="px-2">Result</th><th scope="col" className="px-2">Over 2.5</th><th scope="col" className="px-2">BTTS</th></tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const pick = (m: string) => run.picks.find((p) => p.market === m);
          return (
            <tr key={run.id} className="border-t border-slate-800">
              <th scope="row" className="py-2 text-left font-normal">
                <Link className="text-emerald-400 hover:underline" to={`/matches/${run.matchId}`}>{run.fixture}</Link>
              </th>
              <td className="px-2 text-center text-xs text-slate-400">{fmtDate(run.kickoff, false)}</td>
              {['MATCH_RESULT', 'OVER_UNDER_25', 'BTTS'].map((m) => {
                const p = pick(m);
                return (
                  <td key={m} className="px-2 py-2 text-center">
                    {p ? <RecommendationBadge value={p.recommendation} /> : <span className="text-slate-600">—</span>}
                    {p?.result && <span className={`ml-1 text-xs ${p.result.wasCorrect ? 'text-emerald-400' : 'text-rose-400'}`}>{p.result.wasCorrect ? '✓' : '✗'}</span>}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DebatePage() {
  const [env, setEnv] = useState<DataEnvironment>('LIVE');
  const runs = useApi(() => api.debateRuns(env), [env]);
  const report = useApi(() => api.bookkeeper(env), [env]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Debate</h1>
        <label className="text-sm text-slate-400">
          Environment{' '}
          <select className="ml-2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200" value={env} onChange={(e) => setEnv(e.target.value as DataEnvironment)}>
            {(['LIVE', 'HISTORICAL', 'SYNTHETIC'] as const).map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
      </div>

      <p className="max-w-3xl text-sm text-slate-400">
        Four agents argue each fixture: <strong className="text-slate-200">Scout</strong> presents evidence, <strong className="text-slate-200">Copycat</strong> the de-vigged market baseline,{' '}
        <strong className="text-slate-200">Skeptic</strong> attacks both, and <strong className="text-slate-200">Bookkeeper</strong> scores and sizes. A veto forces no pick, and an unresolved concern can only ever produce a lean.
      </p>

      {report.loading ? <Loading /> : report.error ? <ErrorBox message={report.error} /> : <BookkeeperPanel report={report.data!} />}

      <Card title="Recent debates">
        {runs.loading ? <Loading /> : runs.error ? <ErrorBox message={runs.error} /> : <RunsTable runs={runs.data!.items} />}
      </Card>
    </div>
  );
}
