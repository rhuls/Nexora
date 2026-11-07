import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// Monthly error, with each point's sample size in the tooltip so thin months are not over-read.
export function ErrorOverTimeChart({ points, target, metricLabel }: { points: Array<{ month: string; target: string; n: number; meanAbsoluteError: number }>; target: string; metricLabel: string }) {
  const data = points.filter((p) => p.target === target);
  if (data.length === 0) return <p className="text-sm text-slate-500">No evaluated forecasts for this target yet.</p>;
  return (
    <div className="h-64" role="img" aria-label={`${metricLabel} by month for ${target}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1e293b" />
          <XAxis dataKey="month" stroke="#64748b" fontSize={11} />
          <YAxis stroke="#64748b" fontSize={11} domain={[0, 'auto']} />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }}
            formatter={(value, _name, item) => [`${typeof value === 'number' ? value.toFixed(3) : 'n/a'} (n=${(item.payload as { n: number }).n})`, metricLabel]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="meanAbsoluteError" name={metricLabel} stroke="#34d399" strokeWidth={2} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
