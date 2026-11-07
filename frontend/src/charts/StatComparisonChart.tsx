import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DATA_UNAVAILABLE, type Metric } from '../services/api';

// Unavailable metrics are listed, not drawn as zero-height bars.
export function StatComparisonChart({ rows, homeName, awayName }: { rows: Array<{ label: string; home: Metric; away: Metric }>; homeName: string; awayName: string }) {
  const drawable = rows.filter((r) => r.home.value !== DATA_UNAVAILABLE && r.away.value !== DATA_UNAVAILABLE);
  const missing = rows.filter((r) => !drawable.includes(r)).map((r) => r.label);
  return (
    <div>
      {drawable.length > 0 ? (
        <div className="h-64" role="img" aria-label={`Statistical comparison of ${homeName} and ${awayName}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={drawable.map((r) => ({ label: r.label, [homeName]: r.home.value, [awayName]: r.away.value, nHome: r.home.sampleSize, nAway: r.away.sampleSize }))} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }}
                formatter={(v, name, item) => [`${typeof v === 'number' ? v : 'n/a'} (n=${name === homeName ? (item.payload as { nHome: number }).nHome : (item.payload as { nAway: number }).nAway})`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey={homeName} fill="#34d399" />
              <Bar dataKey={awayName} fill="#38bdf8" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-slate-500">No statistic is known for both teams.</p>
      )}
      {missing.length > 0 && <p className="mt-2 text-xs text-slate-500">DATA UNAVAILABLE (not charted): {missing.join(', ')}.</p>}
    </div>
  );
}
