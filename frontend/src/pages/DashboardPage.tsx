import { Link } from 'react-router-dom';
import { MatchRow } from '../components/MatchRow';
import { Card, ErrorBox, fmtDate, Loading, pct } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function DashboardPage() {
  const today = useApi(() => api.today(LOCAL_TZ), []);
  const upcoming = useApi(() => api.upcoming(14), []);
  const perf = useApi(() => api.performance('HISTORICAL'), []);
  const models = useApi(() => api.models(), []);
  const freshness = useApi(() => api.freshness(), []);
  const events = useApi(() => api.learningEvents(), []);

  const result = perf.data?.byTarget.MATCH_RESULT as { n: number; accuracy: number; brier: number } | undefined;
  const goals = perf.data?.byTarget.GOALS as { n: number; mae: number } | undefined;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card title="Active models">
          {models.data ? (
            <dl className="space-y-1 text-sm">
              {Object.entries(models.data.activeByEnvironment).map(([env, v]) => (
                <div key={env} className="flex justify-between"><dt className="text-slate-400">{env}</dt><dd className="font-mono">{v}</dd></div>
              ))}
            </dl>
          ) : <Loading />}
        </Card>
        <Card title="Matches analysed (backtest)" subtitle="Real EPL history, walk-forward">
          {perf.data ? <p className="text-3xl font-bold">{perf.data.matchesEvaluated}</p> : <Loading />}
          {perf.data?.window && <p className="text-xs text-slate-500">{fmtDate(perf.data.window.from, false)} → {fmtDate(perf.data.window.to, false)}</p>}
        </Card>
        <Card title="Result accuracy" subtitle="HISTORICAL backtest">
          {result ? <><p className="text-3xl font-bold">{pct(result.accuracy)}</p><p className="text-xs text-slate-500">Brier {result.brier} · n={result.n}</p></> : perf.loading ? <Loading /> : <p className="text-sm text-slate-500">Not yet evaluated</p>}
        </Card>
        <Card title="Goals MAE" subtitle="HISTORICAL backtest">
          {goals ? <><p className="text-3xl font-bold">{goals.mae}</p><p className="text-xs text-slate-500">n={goals.n}</p></> : perf.loading ? <Loading /> : <p className="text-sm text-slate-500">Not yet evaluated</p>}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Today's matches" subtitle={`Your time zone: ${LOCAL_TZ}`}>
          {today.error && <ErrorBox message={today.error} />}
          {today.data && (today.data.items.length === 0 ? <p className="text-sm text-slate-500">No matches today ({today.data.date}).</p> : <ul>{today.data.items.map((m) => <MatchRow key={m.id} match={m} />)}</ul>)}
          {today.loading && <Loading />}
        </Card>
        <Card title="Upcoming (next 14 days)" subtitle="Current season, LIVE data">
          {upcoming.error && <ErrorBox message={upcoming.error} />}
          {upcoming.data && (
            <>
              {upcoming.data.upcoming.length === 0 ? <p className="text-sm text-slate-500">No fixtures in the next 14 days.</p> : <ul>{upcoming.data.upcoming.slice(0, 10).map((m) => <MatchRow key={m.id} match={m} />)}</ul>}
              {upcoming.data.awaitingResult.length > 0 && <p className="mt-3 text-xs text-amber-300">{upcoming.data.awaitingResult.length} past fixture(s) awaiting a result from the source.</p>}
            </>
          )}
          {upcoming.loading && <Loading />}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Data freshness">
          {freshness.data ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500"><tr><th className="py-1">Dataset</th><th>Env</th><th>Finished</th><th>Scheduled</th><th>Source fetched</th></tr></thead>
              <tbody>
                {freshness.data.datasets.map((d) => (
                  <tr key={d.dataset} className="border-t border-slate-800">
                    <td className="py-1.5 font-mono text-xs">{d.dataset}</td>
                    <td className="text-xs">{d.dataEnvironment}</td>
                    <td>{d.finished}</td>
                    <td>{d.scheduled}{d.awaitingResult > 0 && <span className="text-amber-300"> ({d.awaitingResult} awaiting)</span>}</td>
                    <td className="text-xs text-slate-400">{d.sourceFetchedAt ? fmtDate(d.sourceFetchedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Loading />}
        </Card>
        <Card title="Recent learning events">
          {events.data ? (
            <ul className="space-y-2 text-sm">
              {events.data.items.slice(0, 6).map((e) => (
                <li key={e.id} className="border-l-2 border-slate-700 pl-3">
                  <p className="text-xs text-slate-500">{fmtDate(e.createdAt)} · {e.type} · {e.dataEnvironment}</p>
                  <p className="text-slate-300">{e.reason}</p>
                </li>
              ))}
            </ul>
          ) : <Loading />}
          <Link to="/evolution" className="mt-3 inline-block text-xs text-emerald-400 hover:underline">Full learning history →</Link>
        </Card>
      </div>
    </div>
  );
}
