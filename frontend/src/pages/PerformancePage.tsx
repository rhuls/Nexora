import { useState } from 'react';
import { CalibrationChart } from '../charts/CalibrationChart';
import { ErrorOverTimeChart } from '../charts/ErrorOverTimeChart';
import { Card, ErrorBox, List, Loading, SyntheticNotice, fmtDate } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api, type DataEnvironment } from '../services/api';

type Cls = { n: number; accuracy: number; brier: number; logLoss: number; expectedCalibrationError: number; f1Macro: number | null; precisionMacro: number | null; recallMacro: number | null; calibration: Array<{ from: number; to: number; n: number; meanPredicted: number | null; observed: number | null }>; byConfidence: Record<string, { n: number; accuracy: number }>; byCompetition: Array<{ competition: string; n: number; metric: number }> };
type Reg = { n: number; mae: number; rmse: number; bias: number; withinTolerance: number; tolerance: number; byConfidence: Record<string, { n: number; mae: number }> };

export function PerformancePage() {
  const [env, setEnv] = useState<DataEnvironment>('HISTORICAL');
  const perf = useApi(() => api.performance(env), [env]);
  const [target, setTarget] = useState('MATCH_RESULT');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Model performance</h1>
        <label className="flex items-center gap-2 text-sm">
          Data
          <select className="rounded bg-slate-800 px-2 py-1" value={env} onChange={(e) => setEnv(e.target.value as DataEnvironment)}>
            <option value="HISTORICAL">HISTORICAL — walk-forward backtest on real EPL data</option>
            <option value="LIVE">LIVE — forecasts made before kickoff only</option>
            <option value="SYNTHETIC">SYNTHETIC — development data</option>
          </select>
        </label>
      </div>
      {env === 'SYNTHETIC' && <SyntheticNotice />}
      {perf.loading ? <Loading /> : perf.error ? <ErrorBox message={perf.error} /> : (() => {
        const p = perf.data!;
        const cls = p.byTarget.MATCH_RESULT as unknown as Cls | undefined;
        const numeric = Object.entries(p.byTarget).filter(([t]) => t !== 'MATCH_RESULT') as Array<[string, Reg]>;
        if (p.forecastsEvaluated === 0) {
          return <Card><p className="text-sm text-slate-400">{env === 'LIVE' ? 'No forecast made before kickoff has been evaluated yet. LIVE performance accumulates as analysed fixtures are played.' : 'No evaluated forecasts yet. Run npm run simulate-learning.'}</p></Card>;
        }
        return (
          <>
            <Card>
              <dl className="grid gap-4 text-sm sm:grid-cols-4">
                <div><dt className="text-slate-400">Current model</dt><dd className="font-mono text-lg">{p.currentModel}</dd></div>
                <div><dt className="text-slate-400">Matches evaluated</dt><dd className="text-lg">{p.matchesEvaluated}</dd></div>
                <div><dt className="text-slate-400">Forecasts evaluated</dt><dd className="text-lg">{p.forecastsEvaluated}</dd></div>
                <div><dt className="text-slate-400">Window</dt><dd>{p.window ? `${fmtDate(p.window.from, false)} → ${fmtDate(p.window.to, false)}` : '—'}</dd></div>
              </dl>
              <p className="mt-3 text-xs text-slate-500">{p.includesBacktests ? 'Includes the latest walk-forward simulation: every forecast used only information from before its kickoff.' : 'Only forecasts made before kickoff are counted.'} There is no single score: each target is judged by the metric that suits it.</p>
            </Card>

            {cls && (
              <Card title="Result analysis" subtitle={`n = ${cls.n}`}>
                <div className="grid gap-6 lg:grid-cols-2">
                  <table className="w-full text-sm">
                    <tbody>
                      {[
                        ['Accuracy', `${(cls.accuracy * 100).toFixed(1)}%`],
                        ['Brier score (lower is better)', cls.brier.toFixed(4)],
                        ['Log loss', cls.logLoss.toFixed(4)],
                        ['Expected calibration error', cls.expectedCalibrationError.toFixed(4)],
                        ['Precision / recall / F1 (macro)', [cls.precisionMacro, cls.recallMacro, cls.f1Macro].map((v) => (v === null ? 'n/a' : v.toFixed(3))).join(' / ')],
                      ].map(([k, v]) => <tr key={k} className="border-t border-slate-800"><th scope="row" className="py-1.5 text-left font-normal text-slate-400">{k}</th><td className="text-right font-mono">{v}</td></tr>)}
                      {Object.entries(cls.byConfidence).map(([level, v]) => <tr key={level} className="border-t border-slate-800"><th scope="row" className="py-1.5 text-left font-normal text-slate-400">Accuracy at {level} confidence</th><td className="text-right font-mono">{(v.accuracy * 100).toFixed(1)}% <span className="text-[10px] text-slate-500">n={v.n}</span></td></tr>)}
                      {cls.byCompetition.map((c) => <tr key={c.competition} className="border-t border-slate-800"><th scope="row" className="py-1.5 text-left font-normal text-slate-400">{c.competition}</th><td className="text-right font-mono">{(c.metric * 100).toFixed(1)}% <span className="text-[10px] text-slate-500">n={c.n}</span></td></tr>)}
                    </tbody>
                  </table>
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Confidence calibration</h3>
                    <CalibrationChart bins={cls.calibration} />
                  </div>
                </div>
              </Card>
            )}

            {numeric.length > 0 && (
              <Card title="Numeric targets" subtitle="Mean absolute error and RMSE per target">
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-500"><tr><th scope="col" className="text-left">Target</th><th scope="col">n</th><th scope="col">MAE</th><th scope="col">RMSE</th><th scope="col">Bias</th><th scope="col">Within tolerance</th></tr></thead>
                  <tbody>{numeric.map(([t, r]) => <tr key={t} className="border-t border-slate-800 text-center font-mono"><td className="py-1.5 text-left font-sans">{t}</td><td>{r.n}</td><td>{r.mae.toFixed(3)}</td><td>{r.rmse.toFixed(3)}</td><td>{r.bias.toFixed(3)}</td><td>{(r.withinTolerance * 100).toFixed(1)}% <span className="text-[10px] text-slate-500">±{r.tolerance}</span></td></tr>)}</tbody>
                </table>
              </Card>
            )}

            <Card title="Error over time">
              <label className="mb-3 flex items-center gap-2 text-sm">
                Target
                <select className="rounded bg-slate-800 px-2 py-1" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {Object.keys(p.byTarget).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <ErrorOverTimeChart points={p.overTime} target={target} metricLabel={target === 'MATCH_RESULT' ? '1 − p(actual outcome)' : 'Mean absolute error'} />
            </Card>

            <Card title="Error analysis" subtitle="Where error comes from; findings are associations, not proof">
              <div className="grid gap-4 lg:grid-cols-2">
                {p.errorAnalysis.map((a) => (
                  <div key={a.target}>
                    <h3 className="mb-1 text-sm font-semibold">{a.target} <span className="text-xs font-normal text-slate-500">n={a.n}</span></h3>
                    <List items={a.findings.map((f) => `${f.category.replaceAll('_', ' ')}: ${f.explanation}`)} empty="No findings." />
                  </div>
                ))}
              </div>
            </Card>
          </>
        );
      })()}
    </div>
  );
}
