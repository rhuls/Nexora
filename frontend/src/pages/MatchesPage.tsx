import { useState } from 'react';
import { MatchRow } from '../components/MatchRow';
import { Card, ErrorBox, Loading, SyntheticNotice } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api, type DataEnvironment } from '../services/api';

const PAGE = 25;

export function MatchesPage() {
  const [env, setEnv] = useState<DataEnvironment>('LIVE');
  const [status, setStatus] = useState<string>('');
  const [page, setPage] = useState(0);
  const order = status === 'SCHEDULED' ? 'asc' : 'desc';
  const res = useApi(() => api.matches({ dataEnvironment: env, status: status || undefined, order, limit: PAGE, offset: page * PAGE }), [env, status, page]);

  return (
    <Card title="Matches">
      <form className="mb-4 flex flex-wrap gap-3 text-sm" onSubmit={(e) => e.preventDefault()}>
        <label className="flex items-center gap-2">
          Data
          <select className="rounded bg-slate-800 px-2 py-1" value={env} onChange={(e) => { setEnv(e.target.value as DataEnvironment); setPage(0); }}>
            <option value="LIVE">LIVE (2026/27)</option>
            <option value="HISTORICAL">HISTORICAL (2023/24–2025/26)</option>
            <option value="SYNTHETIC">SYNTHETIC (development)</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Status
          <select className="rounded bg-slate-800 px-2 py-1" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            <option value="">All</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="FINISHED">Finished</option>
          </select>
        </label>
      </form>
      {env === 'SYNTHETIC' && <div className="mb-3"><SyntheticNotice /></div>}
      {res.loading ? <Loading /> : res.error ? <ErrorBox message={res.error} /> : (
        <>
          <ul>{res.data!.items.map((m) => <MatchRow key={m.id} match={m} />)}</ul>
          <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm text-slate-400">
            <button type="button" className="rounded bg-slate-800 px-3 py-1 disabled:opacity-40" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span>{res.data!.total === 0 ? 'No matches' : `${page * PAGE + 1}–${Math.min(res.data!.total, (page + 1) * PAGE)} of ${res.data!.total}`}</span>
            <button type="button" className="rounded bg-slate-800 px-3 py-1 disabled:opacity-40" disabled={(page + 1) * PAGE >= res.data!.total} onClick={() => setPage((p) => p + 1)}>Next</button>
          </nav>
        </>
      )}
    </Card>
  );
}

