import { Card, ErrorBox, Loading, fmtDate } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';

const BADGE: Record<string, string> = { PASS: 'bg-emerald-500/15 text-emerald-300', WARN: 'bg-amber-500/15 text-amber-300', FAIL: 'bg-rose-500/15 text-rose-300' };

export function QualityPage() {
  const q = useApi(() => api.quality(), []);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Data quality</h1>
      {q.loading ? <Loading /> : q.error ? <ErrorBox message={q.error} /> : (
        <>
          <Card title={`Overall: ${q.data!.status}`} subtitle={`Checked ${fmtDate(q.data!.asOf)}`}>
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500"><tr><th scope="col" className="text-left">Check</th><th scope="col" className="px-2">Result</th><th scope="col" className="px-2">Count</th><th scope="col" className="pl-2 text-left">Meaning</th></tr></thead>
              <tbody>
                {q.data!.checks.map((c) => (
                  <tr key={c.check} className="border-t border-slate-800 align-top">
                    <th scope="row" className="py-2 text-left font-normal">{c.check}</th>
                    <td className="px-2 py-2 text-center"><span className={`rounded px-2 py-0.5 text-xs font-semibold ${BADGE[c.status]}`}>{c.status}</span></td>
                    <td className="px-2 py-2 text-center font-mono">{c.count}</td>
                    <td className="py-2 pl-2 text-xs text-slate-400">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Statistics coverage" subtitle="Missing values stay unavailable; they are never filled with zeros">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500"><tr><th scope="col" className="text-left">Environment</th><th scope="col">Finished</th><th scope="col">No statistics</th><th scope="col">Missing corners</th><th scope="col">Missing possession</th><th scope="col">Missing cards</th></tr></thead>
              <tbody>
                {q.data!.coverage.map((c) => (
                  <tr key={c.dataEnvironment} className="border-t border-slate-800 text-center font-mono">
                    <th scope="row" className="py-2 text-left font-sans font-normal">{c.dataEnvironment}</th>
                    <td>{c.finishedMatches}</td><td>{c.withoutAnyStatistics}</td><td>{c.missingCorners}</td><td>{c.missingPossession}</td><td>{c.missingCards}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
