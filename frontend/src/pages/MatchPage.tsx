import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StatComparisonChart } from '../charts/StatComparisonChart';
import { Card, ConfidenceLabel, EnvBadge, ErrorBox, FormPills, List, Loading, MetricValue, SyntheticNotice, Unavailable, fmtDate, pct } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { ApiError, api, type FormAnalysis, type MatchAnalysis, type TeamAvailability } from '../services/api';
import { TokenPrompt } from '../components/TokenPrompt';
import { DebatePanel } from '../components/DebatePanel';

function StatTable({ home, away, homeName, awayName }: { home: FormAnalysis; away: FormAnalysis; homeName: string; awayName: string }) {
  const rows = [
    ['Goals scored', 'averageGoalsScored'],
    ['Goals conceded', 'averageGoalsConceded'],
    ['Shots', 'averageShots'],
    ['Shots on target', 'averageShotsOnTarget'],
    ['Corners', 'averageCorners'],
    ['Possession %', 'averagePossession'],
    ['Yellow cards', 'averageYellowCards'],
    ['Red cards', 'averageRedCards'],
  ] as const;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Average per match over each team's last {home.metadata.calculationWindow} known matches</caption>
      <thead className="text-xs text-slate-500">
        <tr><th scope="col" className="text-left">Metric (per match)</th><th scope="col" className="text-right">{homeName}</th><th scope="col" className="text-right">{awayName}</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, key]) => (
          <tr key={key} className="border-t border-slate-800">
            <th scope="row" className="py-1.5 text-left font-normal text-slate-300">{label}</th>
            <td className="text-right"><MetricValue metric={home[key]} /></td>
            <td className="text-right"><MetricValue metric={away[key]} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AvailabilityTable({ a }: { a: TeamAvailability }) {
  if (a.status !== 'REPORTED') return <div><p className="mb-1 text-sm font-medium">{a.team.name}</p><Unavailable /><p className="mt-1 text-xs text-slate-500">{a.limitations[0]}</p></div>;
  return (
    <div>
      <p className="mb-1 text-sm font-medium">{a.team.name} <span className="text-xs text-slate-500">· {a.unavailableCount} out, {a.doubtfulCount} doubtful{a.combinedImpact !== null ? ` · combined impact ${a.combinedImpact}` : ''}</span></p>
      {a.players.length === 0 ? <p className="text-sm text-slate-400">Everyone reported available.</p> : (
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500"><tr><th scope="col" className="text-left">Player</th><th scope="col" className="text-left">Status</th><th scope="col" className="text-right">Impact</th></tr></thead>
          <tbody>
            {a.players.map((p) => (
              <tr key={p.player.id} className="border-t border-slate-800">
                <td className="py-1"><Link className="hover:underline" to={`/players/${encodeURIComponent(p.player.id)}`}>{p.player.name}</Link> <span className="text-xs text-slate-500">{p.player.position.toLowerCase()}</span></td>
                <td>{p.status}{p.reason && <span className="block text-xs text-slate-500">{p.reason}</span>}</td>
                <td className="text-right">{p.impactScore === null ? <Unavailable label="unknown" /> : <>{p.impactLabel} <span className="text-xs text-slate-500">{p.impactScore}/100</span></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Insight({ a }: { a: MatchAnalysis }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        {a.resultTrend ? (
          <div>
            <p className="text-sm text-slate-300">{a.resultTrend.explanation}</p>
            <div className="mt-2 flex h-3 overflow-hidden rounded" role="img" aria-label={`Home ${pct(a.resultTrend.probabilities.home)}, draw ${pct(a.resultTrend.probabilities.draw)}, away ${pct(a.resultTrend.probabilities.away)}`}>
              <span className="bg-emerald-500" style={{ width: pct(a.resultTrend.probabilities.home) }} />
              <span className="bg-slate-500" style={{ width: pct(a.resultTrend.probabilities.draw) }} />
              <span className="bg-sky-500" style={{ width: pct(a.resultTrend.probabilities.away) }} />
            </div>
          </div>
        ) : <p className="text-sm text-slate-400">No result forecast: not enough was known before kickoff.</p>}
        <List items={[a.goalTrend, a.cornerTrend, a.cardTrend].filter((t) => t !== null).map((t) => t!.explanation)} empty="No totals could be forecast from the known data." />
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Key factors</h3>
          <List items={a.keyFactors} empty="No key factors." />
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Supporting evidence</h3>
          <List items={a.supportingFactors} empty="None identified." />
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Conflicting evidence</h3>
          <List items={a.conflictingFactors} empty="None identified." />
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Confidence</h3>
          <p className="text-lg"><ConfidenceLabel level={a.confidence.level} /> <span className="text-xs text-slate-500">score {a.confidence.score}</span></p>
          <List items={a.confidence.reasons} empty="" />
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Data limitations</h3>
          <p className="mb-1 text-xs text-slate-500">{a.dataQuality.featuresAvailable} of {a.dataQuality.featuresTotal} features available · quality {a.dataQuality.status}</p>
          <List items={a.dataLimitations.slice(0, 12)} empty="None." />
        </div>
        <p className="text-xs text-slate-500">Model {a.modelVersion} · information as of {fmtDate(a.asOf)} · {a.models.map((m) => `${m.model} ${m.status}`).join(', ')}</p>
      </div>
    </div>
  );
}

export function MatchPage() {
  const { id = '' } = useParams();
  const match = useApi(() => api.match(id), [id]);
  const form = useApi(() => api.form(id), [id]);
  const h2h = useApi(() => api.h2h(id), [id]);
  const availability = useApi(() => api.availability(id), [id]);
  const analysis = useApi(() => api.analysis(id), [id]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);

  if (match.loading) return <Loading />;
  if (match.error) return <ErrorBox message={match.error} />;
  const m = match.data!;
  const played = m.homeScore !== null && m.awayScore !== null;

  const run = async () => {
    setRunning(true);
    setRunError(null);
    setNeedsToken(false);
    try {
      await api.runAnalysis(id);
      analysis.reload();
    } catch (e) {
      // A refusal is a missing token, not a failure worth a red error box.
      if (e instanceof ApiError && e.status === 401) setNeedsToken(true);
      else setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="flex items-center justify-center gap-2 text-xs text-slate-400">{m.competition.name} · {m.season.name}{m.round ? ` · ${m.round}` : ''} <EnvBadge env={m.dataEnvironment} /></p>
        <h1 className="mt-2 text-3xl font-bold">
          {m.homeTeam.name} <span className="px-3 font-mono text-slate-400">{played ? `${m.homeScore} – ${m.awayScore}` : 'vs'}</span> {m.awayTeam.name}
        </h1>
        <p className="mt-1 text-sm text-slate-400">{fmtDate(m.matchDate)} · {m.status}</p>
        <p className="mt-1 text-[11px] text-slate-600">Source: {m.provenance.source} · “{m.provenance.sourceMatchDate}” · updated {fmtDate(m.provenance.lastUpdated)}</p>
      </header>
      {m.dataEnvironment === 'SYNTHETIC' && <SyntheticNotice />}

      <Card title="Recent form" subtitle={form.data ? `Only matches whose result was known before ${fmtDate(form.data.cutoff)}` : undefined}>
        {form.loading ? <Loading /> : form.error ? <ErrorBox message={form.error} /> : (
          <div className="grid gap-4 sm:grid-cols-2">
            {(['home', 'away'] as const).map((side) => {
              const b = form.data![side];
              return (
                <div key={side}>
                  <p className="text-sm font-medium">{b.overall.team.name}</p>
                  <div className="mt-1 flex items-center gap-3"><FormPills sequence={b.overall.sequence} /><span className="text-xs text-slate-400">{b.overall.record.wins}W {b.overall.record.draws}D {b.overall.record.losses}L · PPG <MetricValue metric={b.overall.pointsPerGame} /></span></div>
                  <p className="mt-2 text-xs text-slate-400">Home: <FormPills sequence={b.homeAway.home.sequence} /> · Away: <FormPills sequence={b.homeAway.away.sequence} /></p>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {form.data && (
        <Card title="Statistical comparison" subtitle={`Average per match over the last ${form.data.home.overall.metadata.calculationWindow} known matches`}>
          <div className="grid gap-6 lg:grid-cols-2">
            <StatTable home={form.data.home.overall} away={form.data.away.overall} homeName={m.homeTeam.name} awayName={m.awayTeam.name} />
            <StatComparisonChart
              homeName={m.homeTeam.name}
              awayName={m.awayTeam.name}
              rows={[
                { label: 'Goals', home: form.data.home.overall.averageGoalsScored, away: form.data.away.overall.averageGoalsScored },
                { label: 'Shots', home: form.data.home.overall.averageShots, away: form.data.away.overall.averageShots },
                { label: 'On target', home: form.data.home.overall.averageShotsOnTarget, away: form.data.away.overall.averageShotsOnTarget },
                { label: 'Corners', home: form.data.home.overall.averageCorners, away: form.data.away.overall.averageCorners },
                { label: 'Yellow cards', home: form.data.home.overall.averageYellowCards, away: form.data.away.overall.averageYellowCards },
              ]}
            />
          </div>
        </Card>
      )}

      <Card title="Player availability">
        {availability.loading ? <Loading /> : availability.error ? <ErrorBox message={availability.error} /> : (
          <div className="grid gap-6 lg:grid-cols-2">
            <AvailabilityTable a={availability.data!.home.availability} />
            <AvailabilityTable a={availability.data!.away.availability} />
          </div>
        )}
      </Card>

      <Card title="Head to head" subtitle={h2h.data ? `Last ${h2h.data.meetingsUsed} known meeting(s), weighted with a ${h2h.data.halfLifeDays}-day half-life` : undefined}>
        {h2h.loading ? <Loading /> : h2h.error ? <ErrorBox message={h2h.error} /> : h2h.data!.meetingsUsed === 0 ? <Unavailable label="No previous meetings known" /> : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="text-sm">
              <p>{m.homeTeam.name} {h2h.data!.results.subjectHomeWins}W · {h2h.data!.results.draws}D · {h2h.data!.results.subjectAwayWins}L</p>
              <p className="text-slate-400">Goals per meeting: <MetricValue metric={h2h.data!.totalGoals.timeWeighted} /> (time-weighted) · corners <MetricValue metric={h2h.data!.totalCorners.timeWeighted} /></p>
              <p className="mt-1 text-xs text-slate-500">Reliability {h2h.data!.reliability} (effective sample {h2h.data!.effectiveSampleSize}); influence on the forecast is scaled by this.</p>
            </div>
            <ul className="text-sm">
              {h2h.data!.meetings.map((x) => (
                <li key={x.matchId} className="flex justify-between border-t border-slate-800 py-1">
                  <Link className="hover:underline" to={`/matches/${encodeURIComponent(x.matchId)}`}>{fmtDate(x.matchDate, false)}</Link>
                  <span className="font-mono">{x.subjectHomeGoals}–{x.subjectAwayGoals}</span>
                  <span className="text-xs text-slate-500">weight {x.weight}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Nexora insight">
        {analysis.loading ? <Loading /> : analysis.error ? <ErrorBox message={analysis.error} /> : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {analysis.data!.status === 'ANALYSED'
                ? <span className="text-slate-400">{analysis.data!.mode === 'PROSPECTIVE' ? 'Forecast made before kickoff' : 'Backtest at the pre-kickoff cutoff'} · {analysis.data!.modelVersion} · {fmtDate(analysis.data!.asOf!)}</span>
                : <span className="text-slate-400">Not analysed yet.</span>}
              <button type="button" onClick={run} disabled={running} className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-slate-950 disabled:opacity-50">
                {running ? 'Analysing…' : played ? 'Run backtest' : 'Run analysis now'}
              </button>
            </div>
            {needsToken && <TokenPrompt onSaved={() => { setNeedsToken(false); void run(); }} />}
            {runError && <ErrorBox message={runError} />}
            {analysis.data!.analysis && <Insight a={analysis.data!.analysis} />}
            {analysis.data!.predictions && analysis.data!.predictions.some((p) => p.result) && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Forecast vs actual</h3>
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-500"><tr><th scope="col" className="text-left">Target</th><th scope="col">Forecast</th><th scope="col">Actual</th><th scope="col">Error</th></tr></thead>
                  <tbody>
                    {analysis.data!.predictions.filter((p) => p.result).map((p) => (
                      <tr key={p.target} className="border-t border-slate-800 text-center">
                        <td className="py-1 text-left">{p.target}</td>
                        <td>{p.predictedLabel ?? p.predictedValue.toFixed(2)}</td>
                        <td>{p.result!.actualLabel ?? p.result!.actualValue}</td>
                        <td>{p.target === 'MATCH_RESULT' ? (p.result!.wasCorrect ? 'correct' : 'missed') : p.result!.absoluteError.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>
      <DebatePanel matchId={id} />
    </div>
  );
}
