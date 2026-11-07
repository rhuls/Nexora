import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ModelVersionItem } from '../services/api';

const COLORS = ['#34d399', '#38bdf8', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#2dd4bf', '#94a3b8'];

export function WeightEvolutionChart({ versions }: { versions: ModelVersionItem[] }) {
  const features = [...new Set(versions.flatMap((v) => v.weights.map((w) => w.feature)))].sort();
  const data = versions.map((v) => ({ version: v.version, ...Object.fromEntries(v.weights.map((w) => [w.feature, w.weight])) }));
  if (versions.length === 0) return <p className="text-sm text-slate-500">No model versions.</p>;
  return (
    <div className="h-72" role="img" aria-label="Feature weights by model version">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1e293b" />
          <XAxis dataKey="version" stroke="#64748b" fontSize={11} />
          <YAxis stroke="#64748b" fontSize={11} domain={[0, 'auto']} />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : 'n/a')} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {features.map((f, i) => (
            <Line key={f} type="monotone" dataKey={f} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
