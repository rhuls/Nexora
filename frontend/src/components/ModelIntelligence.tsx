import { useMemo, useState } from 'react';
import { api, type BlackjackRules, type CalibrationBin, type EvaluationReport, type SegmentEvaluation } from '../services/api';
import { useApi } from '../hooks/useApi';
import { Card, ErrorBox, Loading } from './ui';

// One data hue throughout, stepped for this surface and checked against the colour-vision and
// contrast thresholds rather than chosen by eye. Expected values are drawn as a reference mark in
// plain ink rather than as a second hue: the question is whether the bar reached the target, and a
// second colour would make it a comparison between two equals, which it is not.
const DATA = '#059669';
const GRID = 'rgba(148, 163, 184, 0.25)';
const REFERENCE = 'rgba(226, 232, 240, 0.85)';
const STATUS_WARN = '#f59e0b';

const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
const signed = (v: number, digits = 5): string => (v >= 0 ? '+' : '') + v.toFixed(digits);

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p className="mt-1 font-mono text-xl text-slate-100">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

/**
 * Forecast against outcome, bin by bin, with the diagonal a perfectly calibrated model would sit
 * on. The bars through each point are the interval around the observed rate: a point off the line
 * whose bar still crosses it has not shown anything.
 */
function ReliabilityChart({ bins }: { bins: CalibrationBin[] }) {
  const W = 320;
  const H = 320;
  const pad = 40;
  const populated = bins.filter((b) => b.n > 0);
  const x = (v: number): number => pad + v * (W - pad - 12);
  const y = (v: number): number => H - pad - v * (H - pad - 12);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Reliability diagram: forecast probability against observed frequency">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={x(0)} y1={y(t)} x2={x(1)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad - 8} y={y(t) + 4} textAnchor="end" className="fill-slate-500 text-[9px]">{pct(t, 0)}</text>
            <text x={x(t)} y={H - pad + 16} textAnchor="middle" className="fill-slate-500 text-[9px]">{pct(t, 0)}</text>
          </g>
        ))}
        {/* The line a model that means what it says would lie along. */}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke={REFERENCE} strokeWidth={2} strokeDasharray="4 4" />
        {populated.map((b, i) => (
          <g key={i}>
            <line x1={x(b.meanForecast)} y1={y(b.interval.low)} x2={x(b.meanForecast)} y2={y(b.interval.high)} stroke={b.outsideInterval ? STATUS_WARN : DATA} strokeWidth={2} strokeLinecap="round" />
            <circle cx={x(b.meanForecast)} cy={y(b.observedRate)} r={5} fill={b.outsideInterval ? STATUS_WARN : DATA} stroke="#0f172a" strokeWidth={2}>
              <title>
                {`Forecast ${pct(b.meanForecast)} · observed ${pct(b.observedRate)} (${b.n.toLocaleString()} forecasts, interval ${pct(b.interval.low)}–${pct(b.interval.high)})`}
              </title>
            </circle>
          </g>
        ))}
        <text x={x(0.5)} y={H - 6} textAnchor="middle" className="fill-slate-400 text-[10px]">forecast probability</text>
        <text x={12} y={y(0.5)} textAnchor="middle" transform={`rotate(-90 12 ${y(0.5)})`} className="fill-slate-400 text-[10px]">observed frequency</text>
      </svg>
      <figcaption className="mt-1 text-[11px] text-slate-500">
        Dashed line is perfect calibration. Vertical bars are 95% intervals around the observed rate;
        amber marks a bin whose forecast falls outside its own interval.
      </figcaption>
    </figure>
  );
}

/** What the model said each dealer total would happen, against how often it did. */
function DistributionChart({ segment }: { segment: SegmentEvaluation }) {
  const W = 360;
  const H = 240;
  const pad = 34;
  const max = Math.max(...segment.categories.flatMap((c) => [c.forecastRate, c.observedRate]), 0.01) * 1.15;
  const bandWidth = (W - pad - 12) / segment.categories.length;
  const y = (v: number): number => H - pad - (v / max) * (H - pad - 16);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Predicted against observed frequency of each dealer total">
        <line x1={pad} y1={y(0)} x2={W - 12} y2={y(0)} stroke={GRID} strokeWidth={1} />
        {segment.categories.map((c, i) => {
          const left = pad + i * bandWidth + bandWidth * 0.22;
          const width = bandWidth * 0.56;
          return (
            <g key={c.category}>
              <rect x={left} y={y(c.observedRate)} width={width} height={Math.max(0, y(0) - y(c.observedRate))} rx={3} fill={DATA}>
                <title>{`${c.category}: predicted ${pct(c.forecastRate, 2)}, observed ${pct(c.observedRate, 2)} (p = ${c.test.pValue.toFixed(3)})`}</title>
              </rect>
              {/* The target: where the forecast said the bar should reach. */}
              <line x1={left - 3} y1={y(c.forecastRate)} x2={left + width + 3} y2={y(c.forecastRate)} stroke={REFERENCE} strokeWidth={2} strokeLinecap="round" />
              <text x={left + width / 2} y={H - pad + 14} textAnchor="middle" className="fill-slate-400 text-[9px]">{c.category}</text>
            </g>
          );
        })}
        <text x={pad} y={14} className="fill-slate-400 text-[10px]">share of hands</text>
      </svg>
      <figcaption className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: DATA }} /> observed</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: REFERENCE }} /> predicted</span>
      </figcaption>
    </figure>
  );
}

/**
 * One metric across successive blocks of hands. Three measures on three different scales get three
 * charts rather than one with two axes, which would let the shapes be set by the scaling.
 */
function MetricTrend({ title, values, format }: { title: string; values: number[]; format: (v: number) => string }) {
  const W = 300;
  const H = 110;
  const pad = 30;
  if (values.length < 2) return <p className="text-xs text-slate-500">{title}: needs at least two windows.</p>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) || 1;
  const x = (i: number): number => pad + (i / (values.length - 1)) * (W - pad - 10);
  const y = (v: number): number => H - 22 - ((v - (min - span * 0.2)) / (span * 1.4)) * (H - 36);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');

  return (
    <figure className="m-0">
      <figcaption className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title} across successive windows`}>
        <line x1={pad} y1={H - 20} x2={W - 10} y2={H - 20} stroke={GRID} strokeWidth={1} />
        <path d={path} fill="none" stroke={DATA} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {values.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={3.5} fill={DATA} stroke="#0f172a" strokeWidth={1.5}>
            <title>{`window ${i + 1}: ${format(v)}`}</title>
          </circle>
        ))}
        <text x={pad - 4} y={y(max) + 3} textAnchor="end" className="fill-slate-500 text-[9px]">{format(max)}</text>
        <text x={pad - 4} y={y(min) + 3} textAnchor="end" className="fill-slate-500 text-[9px]">{format(min)}</text>
      </svg>
    </figure>
  );
}

function Verdict({ report }: { report: EvaluationReport }) {
  const c = report.recalibration.comparison;
  const justified = c.justified;
  return (
    <div className={`rounded-lg border p-3 ${justified ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-slate-700 bg-slate-900/60'}`}>
      <p className={`text-sm font-semibold ${justified ? 'text-emerald-200' : 'text-slate-200'}`}>
        {justified ? 'Recalibration justified' : 'No change made'}
      </p>
      <p className="mt-1 text-xs text-slate-400">{report.recalibration.verdict}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-slate-400 sm:grid-cols-4">
        <div><dt className="text-slate-500">baseline log loss</dt><dd className="text-slate-200">{c.baselineLogLoss.toFixed(6)}</dd></div>
        <div><dt className="text-slate-500">candidate</dt><dd className="text-slate-200">{c.candidateLogLoss.toFixed(6)}</dd></div>
        <div><dt className="text-slate-500">improvement</dt><dd className="text-slate-200">{signed(c.meanImprovement, 6)}</dd></div>
        <div><dt className="text-slate-500">95% interval</dt><dd className="text-slate-200">{signed(c.interval.low, 5)} … {signed(c.interval.high, 5)}</dd></div>
      </dl>
      <p className="mt-2 text-[11px] text-slate-500">
        Fitted on {report.training.toLocaleString()} hands and judged on {report.validation.toLocaleString()} it never saw.
        A candidate is only accepted when it wins on the held-out half by more than the interval allows to be chance.
      </p>
    </div>
  );
}

export function ModelIntelligence({ rules }: { rules: BlackjackRules }) {
  const intel = useApi(() => api.modelIntelligence(rules), [JSON.stringify(rules)]);
  const [showTable, setShowTable] = useState(false);
  const report = intel.data?.latest ?? null;
  const overall = report?.evaluation.overall;

  const windows = useMemo(() => report?.windows ?? [], [report]);

  if (intel.loading) return <Card title="Model intelligence"><Loading /></Card>;
  if (intel.error) {
    const pending = intel.error.includes('tables do not exist');
    return (
      <Card title="Model intelligence">
        {pending ? (
          <div className="space-y-2 text-sm text-slate-400">
            <p>This deployment&apos;s database has not had the observation tables created yet.</p>
            <pre className="overflow-x-auto rounded-md bg-slate-950 p-2 font-mono text-[11px] text-slate-300">prisma migrate deploy</pre>
            <p className="text-xs text-slate-500">Everything else on this page works without them; only the record of forecasts needs a database.</p>
          </div>
        ) : (
          <ErrorBox message={intel.error} />
        )}
      </Card>
    );
  }

  const counts = intel.data!.counts;
  const total = counts.played + counts.simulated;

  return (
    <Card
      title="Model intelligence"
      subtitle="Whether the model's confidence matches what happens — measured, segmented, and corrected for the number of places it looked."
    >
      {total === 0 || !report || !overall ? (
        <div className="space-y-2 text-sm text-slate-400">
          <p>No observations recorded yet{total > 0 ? `, though ${total.toLocaleString()} are stored and not yet evaluated` : ''}.</p>
          <p className="text-xs text-slate-500">
            Every hand played in the trainer is recorded with the forecast that preceded it. A larger record can also be
            generated directly, which tests whether the arithmetic is right rather than whether the assumptions match a
            real table. Both need the deployment token.
          </p>
          <pre className="overflow-x-auto rounded-md bg-slate-950 p-2 font-mono text-[11px] text-slate-300">
{`POST /api/blackjack/observations/simulate  {"rounds": 50000}
POST /api/blackjack/model/evaluate         {"source": "ALL"}`}
          </pre>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Observations" value={total.toLocaleString()} hint={`${counts.played.toLocaleString()} played · ${counts.simulated.toLocaleString()} simulated`} />
            <Tile label="Brier" value={overall.brier.toFixed(5)} hint="lower is better" />
            <Tile label="Log loss" value={overall.logLoss.toFixed(5)} hint="lower is better" />
            <Tile label="Calibration error" value={overall.calibration.ece.toFixed(5)} hint="mean forecast−outcome gap" />
            <Tile label="Bias" value={signed(overall.calibration.bias)} hint="＋ means over-forecast" />
            <Tile
              label="Fit to outcomes"
              value={`p = ${overall.goodnessOfFit.pValue.toFixed(3)}`}
              hint={overall.goodnessOfFit.pValue < 0.05 ? 'a real mismatch' : 'no mismatch detected'}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">Probability calibration</h3>
              <ReliabilityChart bins={overall.calibration.bins} />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">Expected against observed</h3>
              <DistributionChart segment={overall} />
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
              As the record grows · {windows.length} windows of {windows[0]?.n.toLocaleString() ?? 0} hands
            </h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <MetricTrend title="Brier" values={windows.map((w) => w.brier)} format={(v) => v.toFixed(4)} />
              <MetricTrend title="Log loss" values={windows.map((w) => w.logLoss)} format={(v) => v.toFixed(4)} />
              <MetricTrend title="Calibration error" values={windows.map((w) => w.ece)} format={(v) => v.toFixed(4)} />
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
              Identified weaknesses · {report.evaluation.segments.length} segments examined
            </h3>
            {report.evaluation.weaknesses.length === 0 ? (
              <p className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-300">
                None. Every segment's outcomes are consistent with what was forecast, after correcting for the number of
                segments tested — looking in twenty places at the usual threshold would otherwise turn up one by chance
                alone.
                {report.evaluation.insufficient.length > 0 && (
                  <span className="mt-1 block text-xs text-slate-500">
                    {report.evaluation.insufficient.length} segment(s) hold too few hands to judge and were not tested.
                  </span>
                )}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500">
                  <tr><th scope="col" className="text-left">Segment</th><th scope="col">Hands</th><th scope="col">Calibration error</th><th scope="col">Adjusted p</th></tr>
                </thead>
                <tbody>
                  {report.evaluation.weaknesses.map((w) => (
                    <tr key={`${w.segment.dimension}:${w.segment.key}`} className="border-t border-slate-800">
                      <td className="py-1">{w.segment.label}</td>
                      <td className="text-center font-mono text-slate-300">{w.n.toLocaleString()}</td>
                      <td className="text-center font-mono text-amber-300">{w.calibration.ece.toFixed(4)}</td>
                      <td className="text-center font-mono text-amber-300">{w.adjustedPValue.toExponential(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">Changes to the estimates</h3>
            <Verdict report={report} />
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-500 hover:text-emerald-300"
            >
              {showTable ? 'Hide the numbers' : 'Show the numbers behind the charts'}
            </button>
            {showTable && (
              <table className="mt-2 w-full text-sm">
                <caption className="sr-only">Predicted and observed frequency of each dealer total</caption>
                <thead className="text-xs text-slate-500">
                  <tr><th scope="col" className="text-left">Dealer total</th><th scope="col">Predicted</th><th scope="col">Observed</th><th scope="col">Difference</th><th scope="col">p</th></tr>
                </thead>
                <tbody>
                  {overall.categories.map((c) => (
                    <tr key={c.category} className="border-t border-slate-800">
                      <td className="py-1">{c.category}</td>
                      <td className="text-center font-mono text-slate-300">{pct(c.forecastRate, 3)}</td>
                      <td className="text-center font-mono text-slate-300">{pct(c.observedRate, 3)}</td>
                      <td className="text-center font-mono text-slate-400">{signed(c.test.difference * 100, 3)}pp</td>
                      <td className="text-center font-mono text-slate-400">{c.test.pValue.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-[11px] text-slate-500">
            {report.modelVersion} · evaluated {new Date(report.generatedAt).toLocaleString()} ·
            {' '}{intel.data!.history.length} evaluation(s) on record, every verdict kept whether it accepted a change or refused one.
          </p>
        </div>
      )}
    </Card>
  );
}
