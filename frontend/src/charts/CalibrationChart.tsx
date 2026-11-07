import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Bin {
  from: number;
  to: number;
  n: number;
  meanPredicted: number | null;
  observed: number | null;
}

// Stated probability vs observed hit rate per bin; a well-calibrated model has bars of equal height.
export function CalibrationChart({ bins }: { bins: Bin[] }) {
  const data = bins.filter((b) => b.n > 0).map((b) => ({ bin: `${Math.round(b.from * 100)}–${Math.round(b.to * 100)}% (n=${b.n})`, predicted: b.meanPredicted, observed: b.observed }));
  if (data.length === 0) return <p className="text-sm text-slate-500">No calibration data yet.</p>;
  return (
    <div className="h-64" role="img" aria-label="Calibration: stated probability versus observed frequency">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1e293b" />
          <XAxis dataKey="bin" stroke="#64748b" fontSize={10} />
          <YAxis stroke="#64748b" fontSize={11} domain={[0, 1]} />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} formatter={(v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : 'n/a')} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine y={0.5} stroke="#334155" />
          <Bar dataKey="predicted" name="Stated probability" fill="#38bdf8" />
          <Bar dataKey="observed" name="Observed frequency" fill="#34d399" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
