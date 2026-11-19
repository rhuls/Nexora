import { useCallback, useEffect, useState } from 'react';
import { api, type BlackjackRules, type ModelIntelligence } from '../services/api';

const signed = (v: number, d = 5): string => (v >= 0 ? '+' : '') + v.toFixed(d);

/**
 * What the record says about the model, beside the hand being played.
 *
 * It reloads after each completed hand. The figures move slowly by design: one hand is not
 * evidence about a forecast, and a panel that reacted to every result would be teaching the
 * opposite of what the engine does.
 */
export function LiveModelPanel({ rules, refreshKey }: { rules: BlackjackRules; refreshKey: number }) {
  const [data, setData] = useState<ModelIntelligence | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.modelIntelligence(rules));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rules]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const report = data?.latest ?? null;
  const overall = report?.evaluation.overall ?? null;
  const total = data ? data.counts.played + data.counts.simulated : 0;
  const pending = error?.includes('tables do not exist') ?? false;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Model intelligence</h3>
      {pending ? (
        <p className="mt-2 text-xs text-slate-500">This deployment&apos;s database has no observation tables yet.</p>
      ) : error ? (
        <p className="mt-2 text-xs text-rose-300">{error}</p>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="Observations" value={total.toLocaleString()} hint={data ? `${data.counts.played.toLocaleString()} played` : undefined} />
          {overall ? (
            <>
              <Row label="Calibration error" value={overall.calibration.ece.toFixed(5)} />
              <Row label="Brier" value={overall.brier.toFixed(5)} />
              <Row label="Bias" value={signed(overall.calibration.bias)} hint="＋ over-forecast" />
              <Row
                label="Weaknesses"
                value={report!.evaluation.weaknesses.length === 0 ? 'none' : String(report!.evaluation.weaknesses.length)}
                hint={`${report!.evaluation.segments.length} segments`}
                tone={report!.evaluation.weaknesses.length > 0 ? 'warn' : undefined}
              />
              <div className="border-t border-slate-800 pt-2">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Estimate in use</p>
                <p className="mt-1 text-xs text-slate-400">
                  {report!.recalibration.comparison.justified
                    ? 'A fitted correction beat the solver on held-out hands and is in use alongside it.'
                    : 'The exact solver. No fitted correction has beaten it on hands it had not seen, so none is applied.'}
                </p>
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-500">
              {total === 0
                ? 'No observations yet. Play a hand and it is recorded with the forecast that preceded it.'
                : `${total.toLocaleString()} observations recorded, not yet evaluated.`}
            </p>
          )}
        </dl>
      )}
    </div>
  );
}

function Row({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-400">{label}{hint && <span className="ml-1.5 text-[11px] text-slate-600">{hint}</span>}</dt>
      <dd className={`font-mono ${tone === 'warn' ? 'text-amber-300' : 'text-slate-100'}`}>{value}</dd>
    </div>
  );
}
